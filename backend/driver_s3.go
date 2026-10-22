package main

// driver_s3.go — S3 兼容驱动（minio-go）。
// 覆盖：MinIO、AWS S3、Cloudflare R2、Wasabi、Backblaze B2、Ceph，
// 以及腾讯 COS / 华为 OBS 等 S3 兼容端点。
//
// 分页设计说明：采用 minio-go 的 V1 列举路径（UseV1: true）。
// S3 V1 API 的 marker 支持目录折叠前缀续页（AWS 文档明确：delimiter 场景下
// marker 可设为最后一个 CommonPrefixes 值），与阿里云 OSS 的 marker 语义对齐，
// 因此 token 直接使用「最后一条条目的 key/前缀」（不透明字符串，UI 原样透传），
// 无需客户端重放。提前跳出时 cancel 内部 context 释放 minio-go 分页 goroutine
// （其发送侧 select ctx.Done，可安全终止）。

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"strings"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

type s3Driver struct {
	baseDriver
	cl *minio.Client
}

// parseS3Endpoint 解析 endpoint：显式 http:// 为明文，https:// 或无 scheme 默认 TLS。
func parseS3Endpoint(raw string) (endpoint string, secure bool, err error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return "", false, fmt.Errorf("endpoint 为空")
	}
	if i := strings.Index(s, "://"); i >= 0 {
		switch strings.ToLower(s[:i]) {
		case "http":
			secure = false
		case "https":
			secure = true
		default:
			return "", false, fmt.Errorf("不支持的协议前缀: %s", s[:i])
		}
		s = s[i+3:]
	} else {
		secure = true
	}
	s = strings.TrimSuffix(s, "/")
	if s == "" || strings.Contains(s, "/") {
		return "", false, fmt.Errorf("endpoint 无效（不应包含路径）: %s", raw)
	}
	return s, secure, nil
}

func newS3Driver(cfg ConnConfig) (StorageDriver, error) {
	endpoint, secure, err := parseS3Endpoint(cfg.Endpoint)
	if err != nil {
		return nil, err
	}
	opts := minio.Options{
		Creds: credentials.NewStaticV4(cfg.AccessKeyID, cfg.AccessKeySecret, ""),
		// 自动模式：minio-go 对自定义端点默认走 path-style（MinIO 自建即开即用），
		// 显式开启 pathStyle 时强制 path-style（兼容 DNS 域名桶的 MinIO 部署）。
		Secure: secure,
	}
	if cfg.Region.String() != "" {
		opts.Region = cfg.Region.String()
	}
	if cfg.PathStyle {
		opts.BucketLookup = minio.BucketLookupPath
	}
	cl, err := minio.New(endpoint, &opts)
	if err != nil {
		return nil, err
	}
	return &s3Driver{baseDriver: baseDriver{cfg: cfg}, cl: cl}, nil
}

func (d *s3Driver) ListBuckets() ([]BucketInfo, error) {
	bs, err := d.cl.ListBuckets(context.Background())
	if err != nil {
		return nil, err
	}
	out := make([]BucketInfo, 0, len(bs))
	for _, b := range bs {
		out = append(out, BucketInfo{Name: b.Name})
	}
	return out, nil
}

func (d *s3Driver) ListObjects(req ListReq) (ListPage, error) {
	bucket, err := d.pickBucket(req.Bucket)
	if err != nil {
		return ListPage{}, err
	}
	delim := req.Delimiter
	if delim == "" {
		delim = "/"
	}
	max := req.MaxKeys
	if max <= 0 {
		max = 200
	}
	if max > 1000 {
		max = 1000
	}

	// token 为不透明分页标记 = 最后一条已交付条目的 key / 目录折叠前缀（V1 marker 语义）。

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel() // 提前跳出时释放 minio-go 内部分页 goroutine

	// V1 路径：delimiter 固定 "/"；StartAfter 即 marker（支持目录折叠前缀续页）。
	it := d.cl.ListObjects(ctx, bucket, minio.ListObjectsOptions{
		Prefix:     req.Prefix,
		MaxKeys:    max,
		StartAfter: req.Token,
		UseV1:      true,
		// Recursive 时 minio-go 不传 delimiter，返回 prefix 下全部对象而非折叠前缀。
		Recursive: req.Recursive,
	})

	// 消费 max+1 条：第 max+1 条仅用于判定是否截断，不交付。
	type entry struct {
		info minio.ObjectInfo
		dir  bool
	}
	var consumed []entry
	nextToken := ""
	truncated := false
	for obj := range it {
		if obj.Err != nil {
			return ListPage{}, obj.Err
		}
		if req.Prefix != "" && obj.Key == req.Prefix {
			continue // 跳过目录标记对象本身（对齐阿里云行为）
		}
		if len(consumed) == max {
			truncated = true
			nextToken = consumed[len(consumed)-1].info.Key
			break
		}
		consumed = append(consumed, entry{info: obj, dir: strings.HasSuffix(obj.Key, delim) && obj.ETag == ""})
	}

	page := ListPage{Truncated: truncated, NextToken: nextToken}
	// 展示顺序与阿里云对齐：先目录（CommonPrefixes），后文件；各组内保持服务端字典序。
	for _, e := range consumed {
		if !e.dir {
			continue
		}
		page.Items = append(page.Items, ListItem{Name: e.info.Key, IsDir: true, Mime: "application/x-directory"})
	}
	for _, e := range consumed {
		if e.dir {
			continue
		}
		item := ListItem{Name: e.info.Key, Size: e.info.Size, Mime: guessMime(e.info.Key)}
		if !e.info.LastModified.IsZero() {
			item.Modified = e.info.LastModified.Format(time.RFC3339)
		}
		page.Items = append(page.Items, item)
	}
	return page, nil
}

func (d *s3Driver) Stat(bucket, path string) (ObjMeta, error) {
	b, err := d.pickBucket(bucket)
	if err != nil {
		return ObjMeta{}, err
	}
	st, err := d.cl.StatObject(context.Background(), b, path, minio.StatObjectOptions{})
	if err != nil {
		return ObjMeta{}, err
	}
	m := ObjMeta{
		Size:     st.Size,
		MIME:     st.ContentType,
		ETag:     strings.Trim(st.ETag, `"`),
		Modified: st.LastModified.Format(time.RFC3339),
	}
	if m.MIME == "" {
		m.MIME = guessMime(path)
	}
	return m, nil
}

func (d *s3Driver) OpenRange(bucket, path string, offset, limit int64) (ObjMeta, io.ReadCloser, error) {
	b, err := d.pickBucket(bucket)
	if err != nil {
		return ObjMeta{}, nil, err
	}
	ctx := context.Background()
	meta, err := d.Stat(bucket, path)
	if err != nil {
		return ObjMeta{}, nil, fmt.Errorf("读取元数据失败: %w", err)
	}
	opts := minio.GetObjectOptions{}
	if limit > 0 {
		opts.Set("Range", fmt.Sprintf("bytes=%d-%d", offset, offset+limit-1))
	}
	obj, err := d.cl.GetObject(ctx, b, path, opts)
	if err != nil {
		return ObjMeta{}, nil, err
	}
	return meta, obj, nil
}

func (d *s3Driver) OpenStream(bucket, path string) (io.ReadCloser, error) {
	b, err := d.pickBucket(bucket)
	if err != nil {
		return nil, err
	}
	return d.cl.GetObject(context.Background(), b, path, minio.GetObjectOptions{})
}

func (d *s3Driver) Put(bucket, path string, r io.Reader, size int64, mime string) error {
	b, err := d.pickBucket(bucket)
	if err != nil {
		return err
	}
	_, err = d.cl.PutObject(context.Background(), b, path, r, size, minio.PutObjectOptions{
		ContentType: mime,
	})
	return err
}

// PutFromFile 流式上传本地文件；minio-go 对超过分片阈值的对象自动走 multipart。
func (d *s3Driver) PutFromFile(bucket, path, filePath, mime string) error {
	b, err := d.pickBucket(bucket)
	if err != nil {
		return err
	}
	f, err := os.Open(filePath)
	if err != nil {
		return err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return err
	}
	_, err = d.cl.PutObject(context.Background(), b, path, f, st.Size(), minio.PutObjectOptions{
		ContentType: mime,
	})
	return err
}

// Presign 计算 V4 预签名 GET URL。
func (d *s3Driver) Presign(bucket, path string, expires int64) (string, error) {
	b, err := d.pickBucket(bucket)
	if err != nil {
		return "", err
	}
	u, err := d.cl.PresignedGetObject(context.Background(), b, path, time.Duration(expires)*time.Second, nil)
	if err != nil {
		return "", err
	}
	return u.String(), nil
}

// GetObjectAcl 读取对象 ACL，返回是否为公共读。
// minio-go 的 GetObjectACL 会把服务端返回的 canned ACL 放进 Metadata 的
// X-Amz-Acl；若服务返回的是完整 Grant 列表（非 canned），则退回到
// 「AllUsers + READ」的授权项判定（公共读的标准表达）。
func (d *s3Driver) GetObjectAcl(bucket, path string) (bool, error) {
	b, err := d.pickBucket(bucket)
	if err != nil {
		return false, err
	}
	info, err := d.cl.GetObjectACL(context.Background(), b, path)
	if err != nil {
		return false, err
	}
	if v := info.Metadata.Get("X-Amz-Acl"); v != "" {
		return strings.EqualFold(strings.TrimSpace(v), "public-read"), nil
	}
	for _, g := range info.Grant {
		if strings.Contains(g.Grantee.URI, "AllUsers") && strings.EqualFold(g.Permission, "READ") {
			return true, nil
		}
	}
	return false, nil
}

// SetObjectAcl S3 兼容侧不支持在线改对象 ACL：minio-go v7 只提供 GetObjectACL，
// 未提供 PutObjectAcl。公共读需由用户在服务商侧配置（对象 ACL 或桶策略），
// 插件只负责读取状态与生成不带签名的公共链接。
func (d *s3Driver) SetObjectAcl(bucket, path string, public bool) error {
	return errors.New("S3 兼容驱动不支持在线设置对象 ACL（minio-go 未提供 PutObjectAcl）：请在服务商控制台将该对象设为公共读，或配置桶策略后重试")
}

func (d *s3Driver) Delete(bucket, path string) error {
	b, err := d.pickBucket(bucket)
	if err != nil {
		return err
	}
	return d.cl.RemoveObject(context.Background(), b, path, minio.RemoveObjectOptions{})
}

// listPrefixKeys 平铺列举 prefix 下的全部对象 key（Recursive 不折叠子目录）。
// 最多收集 limit+1 个：多出的一个仅用于判定是否超限，避免为判断多拉一整页。
func (d *s3Driver) listPrefixKeys(ctx context.Context, bucket, prefix string, limit int) ([]string, bool, error) {
	keys := make([]string, 0, limit+1)
	it := d.cl.ListObjects(ctx, bucket, minio.ListObjectsOptions{
		Prefix:    prefix,
		Recursive: true,
	})
	for obj := range it {
		if obj.Err != nil {
			return nil, false, obj.Err
		}
		keys = append(keys, obj.Key)
		if len(keys) > limit {
			return keys[:limit], true, nil
		}
	}
	return keys, false, nil
}

// DeletePrefix 先完整收集 prefix 下的 key（超限即中止，不做任何删除），
// 再用 RemoveObjects 批量删除，保证「超限中止」是原子的。
func (d *s3Driver) DeletePrefix(bucket, prefix string, limit int) (int, error) {
	b, err := d.pickBucket(bucket)
	if err != nil {
		return 0, err
	}
	if limit <= 0 {
		limit = deleteBatchSize
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel() // 提前跳出时释放 minio-go 内部分页 goroutine

	keys, hasMore, err := d.listPrefixKeys(ctx, b, prefix, limit)
	if err != nil {
		return 0, err
	}
	if hasMore {
		return 0, fmt.Errorf("目录内对象超过 %d 个，已中止删除；请分批处理或改用服务端工具", limit)
	}

	deleted := 0
	var failed []string
	// RemoveObjects 是流式接口：channel 供 key、channel 回错误，天然支持大批量。
	objCh := make(chan minio.ObjectInfo)
	resCh := d.cl.RemoveObjects(ctx, b, objCh, minio.RemoveObjectsOptions{})
	go func() {
		defer close(objCh)
		for _, k := range keys {
			select {
			case objCh <- minio.ObjectInfo{Key: k}:
			case <-ctx.Done():
				return
			}
		}
	}()
	for res := range resCh {
		if res.Err != nil {
			failed = append(failed, res.ObjectName)
			continue
		}
		deleted++
	}
	if len(failed) > 0 {
		return deleted, fmt.Errorf("有 %d 个对象删除失败（首个：%s）", len(failed), failed[0])
	}

	// prefix 自身的目录标记对象（若存在）不在上面列举结果里时单独补删一次。
	// MinIO 对不存在的 key 按幂等语义返回成功，不影响结果。
	if err := d.cl.RemoveObject(ctx, b, prefix, minio.RemoveObjectOptions{}); err != nil {
		log.Printf("补删目录标记对象失败 %s: %v", prefix, err)
	}
	return deleted, nil
}

func (d *s3Driver) Move(bucket, from, to string) error {
	b, err := d.pickBucket(bucket)
	if err != nil {
		return err
	}
	ctx := context.Background()
	_, err = d.cl.CopyObject(ctx,
		minio.CopyDestOptions{Bucket: b, Object: to},
		minio.CopySrcOptions{Bucket: b, Object: from},
	)
	if err != nil {
		return fmt.Errorf("复制失败: %w", err)
	}
	if err := d.cl.RemoveObject(ctx, b, from, minio.RemoveObjectOptions{}); err != nil {
		return fmt.Errorf("删除源失败: %w", err)
	}
	return nil
}

// MovePrefix 递归移动目录：把 fromPrefix 下的全部对象复制到 toPrefix 之下，
// 全部复制成功后再删除源对象。语义与阿里云实现一致，详见该方法的注释。
func (d *s3Driver) MovePrefix(bucket, fromPrefix, toPrefix string, limit int) (int, error) {
	b, err := d.pickBucket(bucket)
	if err != nil {
		return 0, err
	}
	if limit <= 0 {
		limit = deleteBatchSize
	}
	fromP := normalizeDirPrefix(fromPrefix)
	toP := normalizeDirPrefix(toPrefix)
	if fromP == toP {
		return 0, fmt.Errorf("源目录与目标目录相同")
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// 列举源前缀下的全部对象（递归）。超限即中止，不做任何改动。
	keys, hasMore, err := d.listPrefixKeys(ctx, b, fromP, limit)
	if err != nil {
		return 0, fmt.Errorf("列举源目录失败: %w", err)
	}
	if hasMore {
		return 0, fmt.Errorf("目录内对象超过 %d 个，已中止移动；请分批处理", limit)
	}
	// listPrefixKeys 会把 prefix 自身的目录标记对象也列进来（它以 prefix 开头），
	// 需剔除：它应作为整体标记单独搬移，而非按相对路径展开。
	objKeys := make([]string, 0, len(keys))
	for _, k := range keys {
		if k == fromP {
			continue
		}
		objKeys = append(objKeys, k)
	}

	if len(objKeys) == 0 {
		// 目录下无对象：仍需搬移目录标记对象，否则改名后目录「凭空消失」。
		if _, e := d.cl.CopyObject(ctx,
			minio.CopyDestOptions{Bucket: b, Object: toP},
			minio.CopySrcOptions{Bucket: b, Object: fromP},
		); e != nil {
			return 0, fmt.Errorf("移动目录标记对象失败: %w", e)
		}
		if e := d.cl.RemoveObject(ctx, b, fromP, minio.RemoveObjectOptions{}); e != nil {
			return 0, fmt.Errorf("删除源目录标记对象失败: %w", e)
		}
		return 0, nil
	}

	// 阶段一：全量复制，失败即回滚已复制目标。
	copied := make([]string, 0, len(objKeys))
	rollback := func() {
		for _, dst := range copied {
			_ = d.cl.RemoveObject(ctx, b, dst, minio.RemoveObjectOptions{})
		}
	}
	for _, src := range objKeys {
		dst := toP + strings.TrimPrefix(src, fromP)
		if _, e := d.cl.CopyObject(ctx,
			minio.CopyDestOptions{Bucket: b, Object: dst},
			minio.CopySrcOptions{Bucket: b, Object: src},
		); e != nil {
			rollback()
			return 0, fmt.Errorf("复制对象失败（%s → %s），已回滚 %d 个已复制对象: %w",
				src, dst, len(copied), e)
		}
		copied = append(copied, dst)
	}

	// 阶段二：批量删除源对象（RemoveObjects 流式接口，天然支持大批量）。
	deleted := 0
	objCh := make(chan minio.ObjectInfo)
	resCh := d.cl.RemoveObjects(ctx, b, objCh, minio.RemoveObjectsOptions{})
	go func() {
		defer close(objCh)
		for _, k := range objKeys {
			select {
			case objCh <- minio.ObjectInfo{Key: k}:
			case <-ctx.Done():
				return
			}
		}
	}()
	for res := range resCh {
		if res.Err != nil {
			return len(copied), fmt.Errorf("重命名已完成但清理源对象失败（已复制 %d 个，请手动核对）: %w", len(copied), res.Err)
		}
		deleted++
	}
	// 补删源目录标记对象（幂等）。
	if e := d.cl.RemoveObject(ctx, b, fromP, minio.RemoveObjectOptions{}); e != nil {
		log.Printf("补删源目录标记对象失败 %s: %v", fromP, e)
	}
	return deleted, nil
}
