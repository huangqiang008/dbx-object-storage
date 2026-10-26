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
	"sync"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"github.com/minio/minio-go/v7/pkg/tags"
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
		// 有 SessionToken 说明是 STS 临时凭证：minio-go 的 NewStaticV4
		// 第三参就是 session token，签名时自动带 x-amz-security-token。
		// 留空 = 长期密钥，行为与之前完全一致。
		Creds: credentials.NewStaticV4(cfg.AccessKeyID, cfg.AccessKeySecret, cfg.SessionToken),
		// 自动模式：minio-go 对自定义端点默认走 path-style（MinIO 自建即开即用），
		// 显式开启 pathStyle 时强制 path-style（兼容 DNS 域名桶的 MinIO 部署）。
		Secure: secure,
	}
	// 自定义 CA / 跳过校验：仅当连接显式配置时才注入传输层，
	// 否则保持 nil，沿用 minio-go 默认传输（含代理 / 超时等默认行为）。
	if tr := buildTransport(cfg); tr != nil {
		opts.Transport = tr
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
		Size:         st.Size,
		MIME:         st.ContentType,
		ETag:         strings.Trim(st.ETag, `"`),
		Modified:     st.LastModified.Format(time.RFC3339),
		ContentType:  st.ContentType,
		UserMetadata: map[string]string{},
		StorageClass: normalizeStorageClass(st.StorageClass),
	}
	// S3 把用户自定义元数据放在 x-amz-meta-* 头里，剥掉前缀存裸键名，
	// 与阿里云侧的 x-oss-meta-* 归一化到同一形状。
	//
	// 注意：minio-go 的 ObjectInfo.UserMetadata 在 StatObject 路径上
	// 根本不填充（全仓只有 listObjectVersions 与 compose 路径给它赋值），
	// 所以必须从 Metadata 全量头里自己解析。
	for k, vs := range st.Metadata {
		lk := strings.ToLower(k)
		if strings.HasPrefix(lk, "x-amz-meta-") && len(vs) > 0 {
			m.UserMetadata[lk[len("x-amz-meta-"):]] = vs[0]
		}
	}
	// Content-Disposition / Cache-Control 不在 ObjectInfo 的固定字段里，
	// 但服务端一般会随 Metadata 头带回，一并解析。
	if v := st.Metadata.Get("Content-Disposition"); v != "" {
		m.ContentDisposition = v
	}
	if v := st.Metadata.Get("Cache-Control"); v != "" {
		m.CacheControl = v
	}
	if v := st.Metadata.Get("Content-Encoding"); v != "" {
		m.ContentEncoding = v
	}
	if m.MIME == "" {
		m.MIME = guessMime(path)
	}
	m.ContentType = m.MIME
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
	return d.PutWithClass(bucket, path, r, size, mime, "")
}

// PutWithClass 上传对象并指定存储类别（2.5）。
// storageClass 为归一化值（standard/ia/archive），空串 = 服务端默认。
func (d *s3Driver) PutWithClass(bucket, path string, r io.Reader, size int64, mime, storageClass string) error {
	b, err := d.pickBucket(bucket)
	if err != nil {
		return err
	}
	opts, err := s3PutOpts(mime, storageClass)
	if err != nil {
		return err
	}
	_, err = d.cl.PutObject(context.Background(), b, path, r, size, opts)
	return err
}

// PutFromFile 流式上传本地文件；minio-go 对超过分片阈值的对象自动走 multipart。
func (d *s3Driver) PutFromFile(bucket, path, filePath, mime string) error {
	return d.PutFromFileWithClass(bucket, path, filePath, mime, "")
}

// PutFromFileWithClass 流式上传并指定存储类别（2.5）。
func (d *s3Driver) PutFromFileWithClass(bucket, path, filePath, mime, storageClass string) error {
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
	opts, err := s3PutOpts(mime, storageClass)
	if err != nil {
		return err
	}
	_, err = d.cl.PutObject(context.Background(), b, path, f, st.Size(), opts)
	return err
}

// s3PutOpts 组装上传选项：Content-Type + 存储类别。
//
// S3 的存储类别枚举名与阿里云不同（GLACIER vs Archive），
// 归一化在 driver 层完成，UI 只认 standard/ia/archive 三个值。
func s3PutOpts(mime, storageClass string) (minio.PutObjectOptions, error) {
	opts := minio.PutObjectOptions{ContentType: mime}
	switch storageClass {
	case "":
	case StorageClassStandard:
		opts.StorageClass = "STANDARD"
	case StorageClassIA:
		opts.StorageClass = "STANDARD_IA"
	case StorageClassArchive:
		opts.StorageClass = "GLACIER"
	default:
		return opts, fmt.Errorf("不支持的存储类别: %s", storageClass)
	}
	return opts, nil
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

// DeleteMany 用 minio-go 批量删除（SDK 内部按 ≤1000 key 分请求），
// 把逐条 DELETE 的 N 次往返压成 ⌈N/1000⌉ 次。逐 key 失败如实记录。
//
// 必须用 RemoveObjectsWithResult 而非 RemoveObjects：后者只返回「失败」
// 通道（成功的结果被 SDK 内部丢弃），用它统计删除数永远得到 0。
// RemoveObjectsWithResult 同时返回成功与失败。
func (d *s3Driver) DeleteMany(bucket string, paths []string) (int, []DeleteFailure) {
	if len(paths) == 0 {
		return 0, nil
	}
	b, err := d.pickBucket(bucket)
	if err != nil {
		return 0, allFailed(paths, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	objCh := make(chan minio.ObjectInfo)
	resCh := d.cl.RemoveObjectsWithResult(ctx, b, objCh, minio.RemoveObjectsOptions{})
	go func() {
		defer close(objCh)
		for _, k := range paths {
			select {
			case objCh <- minio.ObjectInfo{Key: k}:
			case <-ctx.Done():
				return
			}
		}
	}()
	deleted := 0
	var fails []DeleteFailure
	for res := range resCh {
		if res.Err != nil {
			fails = append(fails, DeleteFailure{Key: res.ObjectName, Error: res.Err.Error()})
			continue
		}
		deleted++
	}
	return deleted, fails
}

// DeletePrefix 流式递归删除：列举与删除以管道衔接——列举出一页就送进
// RemoveObjects 批删，不设总量上限，任意大小目录都能删，内存占用恒定
// （只持有在途的一批 key）。中途失败返回已删除数量（部分删除无法回滚，
// 错误信息如实带出进度）。
func (d *s3Driver) DeletePrefix(bucket, prefix string) (int, error) {
	b, err := d.pickBucket(bucket)
	if err != nil {
		return 0, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel() // 提前跳出时释放 minio-go 内部分页 goroutine

	list := d.cl.ListObjects(ctx, b, minio.ListObjectsOptions{Prefix: prefix, Recursive: true})
	objCh := make(chan minio.ObjectInfo)
	// 必须用 RemoveObjectsWithResult：RemoveObjects 只回「失败」通道，
	// 用它统计删除数永远得到 0（SDK 内部丢弃了成功结果）。
	resCh := d.cl.RemoveObjectsWithResult(ctx, b, objCh, minio.RemoveObjectsOptions{})
	listErr := make(chan error, 1)
	go func() {
		defer close(objCh)
		for obj := range list {
			if obj.Err != nil {
				listErr <- obj.Err
				return
			}
			select {
			case objCh <- minio.ObjectInfo{Key: obj.Key}:
			case <-ctx.Done():
				return
			}
		}
	}()
	deleted := 0
	for res := range resCh {
		if res.Err != nil {
			return deleted, fmt.Errorf("批量删除失败（已删除 %d 个）: %w", deleted, res.Err)
		}
		deleted++
	}
	// listErr 在 close(objCh) 之前写入，resCh 耗尽后才读取，时序有保证。
	select {
	case e := <-listErr:
		return deleted, fmt.Errorf("列举失败（已删除 %d 个）: %w", deleted, e)
	default:
	}
	// prefix 自身的目录标记对象（若存在）补删一次：MinIO 对不存在的 key
	// 按幂等语义返回成功，不影响结果。
	if err := d.cl.RemoveObject(ctx, b, prefix, minio.RemoveObjectOptions{}); err != nil {
		log.Printf("补删目录标记对象失败 %s: %v", prefix, err)
	}
	return deleted, nil
}

// Copy 复制单个对象（不删源）。Move 的复制阶段与批量复制共用。
func (d *s3Driver) Copy(bucket, from, to string) error {
	b, err := d.pickBucket(bucket)
	if err != nil {
		return err
	}
	_, err = d.cl.CopyObject(context.Background(),
		minio.CopyDestOptions{Bucket: b, Object: to},
		minio.CopySrcOptions{Bucket: b, Object: from},
	)
	if err != nil {
		return fmt.Errorf("复制失败: %w", err)
	}
	return nil
}

func (d *s3Driver) Move(bucket, from, to string) error {
	if err := d.Copy(bucket, from, to); err != nil {
		return err
	}
	b, err := d.pickBucket(bucket)
	if err != nil {
		return err
	}
	if err := d.cl.RemoveObject(context.Background(), b, from, minio.RemoveObjectOptions{}); err != nil {
		return fmt.Errorf("删除源失败: %w", err)
	}
	return nil
}

// listPage 取一页源 key（≤pageSize 个，剔除目录标记对象自身）。为了精确知道
// 「是否还有下一页」，向服务端请求 pageSize+1 条：多出的那一条不丢弃，直接作为
// 下一页的 StartAfter 起点；列举耗尽时 next 返回空串。
func (d *s3Driver) listPage(ctx context.Context, bucket, prefix, startAfter string, pageSize int) (keys []string, next string, err error) {
	it := d.cl.ListObjects(ctx, bucket, minio.ListObjectsOptions{
		Prefix:     prefix,
		Recursive:  true,
		UseV1:      true,
		StartAfter: startAfter,
		MaxKeys:    pageSize + 1,
	})
	for obj := range it {
		if obj.Err != nil {
			return nil, "", obj.Err
		}
		if len(keys) == pageSize {
			next = obj.Key
			break // 剩余条目随 defer cancel() 释放
		}
		if obj.Key == prefix {
			continue // 目录标记对象单独处理
		}
		keys = append(keys, obj.Key)
	}
	return keys, next, nil
}

// copyBatchConcurrently 并发复制一批 key（copyConcurrency 路）。返回已成功
// 的目标 key 列表与首个错误；失败时等待全部在途复制结束后返回，调用方据
// copied 列表回滚。
func (d *s3Driver) copyBatchConcurrently(ctx context.Context, b string, pairs [][2]string) ([]string, error) {
	type result struct {
		dst string
		err error
	}
	results := make(chan result, len(pairs))
	sem := make(chan struct{}, copyConcurrency)
	var wg sync.WaitGroup
	for _, p := range pairs {
		wg.Add(1)
		go func(src, dst string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			_, e := d.cl.CopyObject(ctx,
				minio.CopyDestOptions{Bucket: b, Object: dst},
				minio.CopySrcOptions{Bucket: b, Object: src},
			)
			results <- result{dst, e}
		}(p[0], p[1])
	}
	wg.Wait()
	close(results)
	copied := make([]string, 0, len(pairs))
	var firstErr error
	for r := range results {
		if r.err != nil {
			if firstErr == nil {
				firstErr = r.err
			}
			continue
		}
		copied = append(copied, r.dst)
	}
	return copied, firstErr
}

// MovePrefix 分页流式移动目录：每页（≤1000 key）先并发复制、页内全部成功后
// 批量删除该页源对象，再处理下一页。不设总量上限。
//
// 失败语义与阿里云驱动一致（见该实现注释）：页内复制失败回滚本页；
// 页内删除失败目标已就位、重跑可续传（CopyObject 覆盖写幂等）。
func (d *s3Driver) MovePrefix(bucket, fromPrefix, toPrefix string) (int, error) {
	b, err := d.pickBucket(bucket)
	if err != nil {
		return 0, err
	}
	fromP := normalizeDirPrefix(fromPrefix)
	toP := normalizeDirPrefix(toPrefix)
	if fromP == toP {
		return 0, fmt.Errorf("源目录与目标目录相同")
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	moved := 0
	startAfter := ""
	for {
		keys, next, e := d.listPage(ctx, b, fromP, startAfter, deleteBatchSize)
		if e != nil {
			return moved, fmt.Errorf("列举源目录失败（已移动 %d 个）: %w", moved, e)
		}
		if len(keys) > 0 {
			pairs := make([][2]string, 0, len(keys))
			for _, src := range keys {
				pairs = append(pairs, [2]string{src, toP + strings.TrimPrefix(src, fromP)})
			}
			copied, cerr := d.copyBatchConcurrently(ctx, b, pairs)
			if cerr != nil {
				// 回滚本页已复制的目标对象，避免留下重复数据
				for _, dst := range copied {
					_ = d.cl.RemoveObject(ctx, b, dst, minio.RemoveObjectOptions{})
				}
				return moved, fmt.Errorf("复制对象失败（已移动 %d 个，本页已回滚）: %w", moved, cerr)
			}
			if _, fails := d.DeleteMany(bucket, keys); len(fails) > 0 {
				return moved + len(keys), fmt.Errorf(
					"目标对象已全部复制，但清理源对象失败（可重试续传，已复制 %d 个，首个失败: %s）",
					moved+len(keys), fails[0].Error)
			}
			moved += len(keys)
		}
		if next == "" {
			break
		}
		startAfter = next
	}

	if moved == 0 {
		// 目录为空（或不存在）：仅剩目录标记对象需要搬移。标记对象不存在时
		// CopyObject 报错，与旧行为一致地把错误返回给用户。
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
	// 有子对象被搬移：目标目录由子对象隐式重建，仅补删源标记对象（幂等）。
	if e := d.cl.RemoveObject(ctx, b, fromP, minio.RemoveObjectOptions{}); e != nil {
		log.Printf("补删源目录标记对象失败 %s: %v", fromP, e)
	}
	return moved, nil
}

// ---------- 2.2 跨桶复制 ----------

// CopyAcross 跨桶复制单个对象（2.2）。
//
// minio-go 的 CopyObject 天然支持跨桶：CopyDestOptions.Bucket 是目标桶，
// CopySrcOptions.Bucket 是源桶，两者独立。同桶时即等价于 Copy。
func (d *s3Driver) CopyAcross(srcBucket, dstBucket, from, to string) error {
	src, err := d.pickBucket(srcBucket)
	if err != nil {
		return err
	}
	dst, err := d.pickBucket(dstBucket)
	if err != nil {
		return err
	}
	if _, e := d.cl.CopyObject(context.Background(),
		minio.CopyDestOptions{Bucket: dst, Object: to},
		minio.CopySrcOptions{Bucket: src, Object: from},
	); e != nil {
		if src != dst {
			return fmt.Errorf("跨桶复制失败: %w", e)
		}
		return fmt.Errorf("复制失败: %w", e)
	}
	return nil
}

// MoveAcross 跨桶移动单个对象（copy + delete）。
func (d *s3Driver) MoveAcross(srcBucket, dstBucket, from, to string) error {
	if err := d.CopyAcross(srcBucket, dstBucket, from, to); err != nil {
		return err
	}
	src, err := d.pickBucket(srcBucket)
	if err != nil {
		return err
	}
	if err := d.cl.RemoveObject(context.Background(), src, from, minio.RemoveObjectOptions{}); err != nil {
		return fmt.Errorf("删除源失败: %w", err)
	}
	return nil
}

// CopyPrefixAcross 跨桶递归复制一个前缀（2.2）。
//
// 与 MovePrefix 同构，但不删源对象。流式推进：每页（≤1000 key）并发复制，
// 页内失败回滚本页已复制的目标对象。
func (d *s3Driver) CopyPrefixAcross(srcBucket, dstBucket, fromPrefix, toPrefix string) (int, error) {
	src, err := d.pickBucket(srcBucket)
	if err != nil {
		return 0, err
	}
	dst, err := d.pickBucket(dstBucket)
	if err != nil {
		return 0, err
	}
	ctx := context.Background()
	fromP := normalizeDirPrefix(fromPrefix)
	toP := normalizeDirPrefix(toPrefix)
	if fromP == toP && src == dst {
		return 0, fmt.Errorf("源目录与目标目录相同")
	}

	copied := 0
	startAfter := ""
	for {
		keys, next, e := d.listPage(ctx, src, fromP, startAfter, deleteBatchSize)
		if e != nil {
			return copied, fmt.Errorf("列举源目录失败（已复制 %d 个）: %w", copied, e)
		}
		if len(keys) > 0 {
			pairs := make([][2]string, 0, len(keys))
			for _, k := range keys {
				pairs = append(pairs, [2]string{k, toP + strings.TrimPrefix(k, fromP)})
			}
			ok, cerr := d.copyBatchAcrossConcurrently(ctx, src, dst, pairs)
			if cerr != nil {
				// 回滚本页已复制的目标对象，避免留下重复数据
				for _, key := range ok {
					_ = d.cl.RemoveObject(ctx, dst, key, minio.RemoveObjectOptions{})
				}
				return copied, fmt.Errorf("复制对象失败（已复制 %d 个，本页已回滚）: %w", copied, cerr)
			}
			copied += len(ok)
		}
		if next == "" {
			break
		}
		startAfter = next
	}

	if copied == 0 {
		// 源目录为空：仍需复制目录标记对象（若存在），否则目标目录会「凭空消失」
		if _, e := d.cl.CopyObject(ctx,
			minio.CopyDestOptions{Bucket: dst, Object: toP},
			minio.CopySrcOptions{Bucket: src, Object: fromP},
		); e != nil {
			return 0, fmt.Errorf("复制目录标记对象失败: %w", e)
		}
		return 0, nil
	}
	return copied, nil
}

// copyBatchAcrossConcurrently 跨桶并发复制一批 key（copyConcurrency 路）。
func (d *s3Driver) copyBatchAcrossConcurrently(ctx context.Context, src, dst string, pairs [][2]string) ([]string, error) {
	type result struct {
		dst string
		err error
	}
	results := make(chan result, len(pairs))
	sem := make(chan struct{}, copyConcurrency)
	var wg sync.WaitGroup
	for _, p := range pairs {
		wg.Add(1)
		go func(srcKey, dstKey string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			_, e := d.cl.CopyObject(ctx,
				minio.CopyDestOptions{Bucket: dst, Object: dstKey},
				minio.CopySrcOptions{Bucket: src, Object: srcKey},
			)
			results <- result{dstKey, e}
		}(p[0], p[1])
	}
	wg.Wait()
	close(results)
	copied := make([]string, 0, len(pairs))
	var firstErr error
	for r := range results {
		if r.err != nil {
			if firstErr == nil {
				firstErr = r.err
			}
			continue
		}
		copied = append(copied, r.dst)
	}
	return copied, firstErr
}

// ---------- 2.1 元数据编辑 ----------

// SetMeta 改写对象元数据（2.1）。
//
// 对象存储没有「原地改元数据」的 API——S3 与阿里云都只能靠
// CopyObject + MetadataDirective=REPLACE 把对象复制到自身并替换元数据。
// 因此这里是「自复制」：src == dst，服务端用新元数据覆盖原对象。
//
// minio-go 的 ReplaceMetadata 为 true 时才写入 UserMetadata，
// 否则保留源对象的自定义元数据——正好对应「不动已有 meta」的语义。
func (d *s3Driver) SetMeta(bucket, path string, patch MetaPatch) error {
	b, err := d.pickBucket(bucket)
	if err != nil {
		return err
	}
	// REPLACE 语义下不传元数据 = 全部清空。因此未修改的项必须先读出原值再回填。
	cur, err := d.Stat(bucket, path)
	if err != nil {
		return fmt.Errorf("读取原元数据失败: %w", err)
	}

	dst := minio.CopyDestOptions{
		Bucket: b,
		Object: path,
		// 恒为 true：patch.UserMetadata 为 nil 时用原值回填，
		// 等价于「保持原样」，不会误清已有自定义元数据。
		ReplaceMetadata: true,
	}
	ct := patch.ContentType
	if ct == "" {
		ct = cur.ContentType
	}
	dst.UserMetadata = map[string]string{}
	if ct != "" {
		dst.UserMetadata["Content-Type"] = ct
	}
	cd := patch.ContentDisposition
	if cd == "" {
		cd = cur.ContentDisposition
	}
	if cd != "" {
		dst.UserMetadata["Content-Disposition"] = cd
	}
	cc := patch.CacheControl
	if cc == "" {
		cc = cur.CacheControl
	}
	if cc != "" {
		dst.UserMetadata["Cache-Control"] = cc
	}
	ce := patch.ContentEncoding
	if ce == "" {
		ce = cur.ContentEncoding
	}
	if ce != "" {
		dst.UserMetadata["Content-Encoding"] = ce
	}
	// 自定义元数据：patch 为 nil 表示不动；非 nil 则整体替换
	meta := patch.UserMetadata
	if meta == nil {
		meta = cur.UserMetadata
	}
	for k, v := range meta {
		if v == "" {
			continue // 空值 = 删除该键，S3 侧靠「不传」表达
		}
		dst.UserMetadata[k] = v
	}
	// 存储类别：S3 侧通过 CopyDestOptions 无法直接改（CopyObject 不带
	// x-amz-storage-class 覆盖语义，AWS 会忽略），因此改类别走 PutObject。
	// 这里只在明确指定时处理，且归档类需要额外恢复流程，报错提示而非静默失败。
	if patch.StorageClass != "" {
		return fmt.Errorf("S3 兼容协议不支持通过复制修改存储类别，请重新上传或使用服务商控制台")
	}
	if _, err := d.cl.CopyObject(context.Background(), dst, minio.CopySrcOptions{Bucket: b, Object: path}); err != nil {
		return fmt.Errorf("修改元数据失败: %w", err)
	}
	return nil
}

// ---------- 2.3 对象标签 ----------

// SetTags 覆盖式设置对象标签（2.3）。传空 map 表示清空所有标签。
func (d *s3Driver) SetTags(bucket, path string, tagMap map[string]string) error {
	b, err := d.pickBucket(bucket)
	if err != nil {
		return err
	}
	t := make(map[string]string, len(tagMap))
	for k, v := range tagMap {
		if k == "" {
			continue
		}
		t[k] = v
	}
	// NewTags(map, isObject) 的 isObject=true 表示这是对象级标签
	//（x-amz-tagging 头的对象标签语义，而非桶标签）。
	tg, err := tags.NewTags(t, true)
	if err != nil {
		return fmt.Errorf("设置标签失败: %w", err)
	}
	if err := d.cl.PutObjectTagging(context.Background(), b, path, tg, minio.PutObjectTaggingOptions{}); err != nil {
		return fmt.Errorf("设置标签失败: %w", err)
	}
	return nil
}

// GetTags 读取对象标签（2.3）。对象无标签时返回空 map 而非错误。
func (d *s3Driver) GetTags(bucket, path string) (map[string]string, error) {
	b, err := d.pickBucket(bucket)
	if err != nil {
		return nil, err
	}
	res, err := d.cl.GetObjectTagging(context.Background(), b, path, minio.GetObjectTaggingOptions{})
	if err != nil {
		return nil, fmt.Errorf("读取标签失败: %w", err)
	}
	out := make(map[string]string)
	for k, v := range res.ToMap() {
		out[k] = v
	}
	return out, nil
}
