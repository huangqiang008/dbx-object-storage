package main

// driver_aliyun.go — 阿里云 OSS 原生驱动（aliyun-oss-go-sdk）。
// 逻辑自原 oss.go 平移，行为保持不变。

import (
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/aliyun/aliyun-oss-go-sdk/oss"
)

type aliyunDriver struct {
	baseDriver
	client *oss.Client
}

func newAliyunDriver(cfg ConnConfig) (StorageDriver, error) {
	// 有 SessionToken 说明是 STS 临时凭证：必须走 oss.SecurityToken，
	// 否则服务端会因签名缺少 x-oss-security-token 而拒绝所有请求。
	// 走 oss.New 的默认路径（无 token）时行为与之前完全一致。
	opts := []oss.ClientOption{oss.SecurityToken(cfg.SessionToken)}
	// 自定义 CA / 跳过校验：显式配置时才注入，否则沿用 SDK 默认传输。
	if tr := buildTransport(cfg); tr != nil {
		opts = append(opts, oss.HTTPClient(&http.Client{Transport: tr}))
	}
	client, err := oss.New(cfg.Endpoint, cfg.AccessKeyID, cfg.AccessKeySecret, opts...)
	if err != nil {
		return nil, err
	}
	return &aliyunDriver{baseDriver: baseDriver{cfg: cfg}, client: client}, nil
}

// bucket 按名取 bucket；name 为空时回落默认 bucket。
func (d *aliyunDriver) bucket(name string) (*oss.Bucket, error) {
	n, err := d.pickBucket(name)
	if err != nil {
		return nil, err
	}
	return d.client.Bucket(n)
}

func (d *aliyunDriver) ListBuckets() ([]BucketInfo, error) {
	res, err := d.client.ListBuckets()
	if err != nil {
		return nil, err
	}
	out := make([]BucketInfo, 0, len(res.Buckets))
	for _, b := range res.Buckets {
		out = append(out, BucketInfo{Name: b.Name})
	}
	return out, nil
}

func (d *aliyunDriver) ListObjects(req ListReq) (ListPage, error) {
	b, err := d.bucket(req.Bucket)
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
	opts := []oss.Option{oss.Prefix(req.Prefix), oss.MaxKeys(max)}
	if req.Recursive {
		// 递归列举不传 delimiter，OSS 即返回 prefix 下全部对象而非公共前缀。
	} else {
		opts = append(opts, oss.Delimiter(delim))
	}
	if req.Token != "" {
		opts = append(opts, oss.Marker(req.Token))
	}
	resp, err := b.ListObjects(opts...)
	if err != nil {
		return ListPage{}, err
	}
	page := ListPage{Truncated: resp.IsTruncated, NextToken: resp.NextMarker}
	for _, cp := range resp.CommonPrefixes {
		page.Items = append(page.Items, ListItem{Name: cp, IsDir: true, Mime: "application/x-directory"})
	}
	for _, o := range resp.Objects {
		if o.Key == req.Prefix {
			continue
		}
		page.Items = append(page.Items, ListItem{
			Name:     o.Key,
			Size:     o.Size,
			Mime:     guessMime(o.Key),
			Modified: o.LastModified.Format(time.RFC3339),
		})
	}
	return page, nil
}

func (d *aliyunDriver) Stat(bucket, path string) (ObjMeta, error) {
	b, err := d.bucket(bucket)
	if err != nil {
		return ObjMeta{}, err
	}
	h, err := b.GetObjectMeta(path)
	if err != nil {
		return ObjMeta{}, err
	}
	m := ObjMeta{
		MIME:               h.Get("Content-Type"),
		ETag:               strings.Trim(h.Get("ETag"), `"`),
		ContentType:        h.Get("Content-Type"),
		ContentDisposition: h.Get("Content-Disposition"),
		CacheControl:       h.Get("Cache-Control"),
		ContentEncoding:    h.Get("Content-Encoding"),
		UserMetadata:       map[string]string{},
	}
	// 阿里云把用户自定义元数据放在 x-oss-meta-* 头里，剥掉前缀存裸键名，
	// 与 S3 侧的 x-amz-meta-* 归一化到同一形状。
	for k, vs := range h {
		lk := strings.ToLower(k)
		if strings.HasPrefix(lk, "x-oss-meta-") && len(vs) > 0 {
			m.UserMetadata[lk[len("x-oss-meta-"):]] = vs[0]
		}
	}
	if s := h.Get("Content-Length"); s != "" {
		m.Size, _ = strconv.ParseInt(s, 10, 64)
	}
	if lm := h.Get("Last-Modified"); lm != "" {
		if t, e := http.ParseTime(lm); e == nil {
			m.Modified = t.Format(time.RFC3339)
		}
	}
	if m.MIME == "" {
		m.MIME = guessMime(path)
	}
	m.ContentType = m.MIME
	return m, nil
}

func (d *aliyunDriver) OpenRange(bucket, path string, offset, limit int64) (ObjMeta, io.ReadCloser, error) {
	b, err := d.bucket(bucket)
	if err != nil {
		return ObjMeta{}, nil, err
	}
	meta, err := d.Stat(bucket, path)
	if err != nil {
		return ObjMeta{}, nil, fmt.Errorf("读取元数据失败: %w", err)
	}
	body, err := b.GetObject(path, oss.Range(offset, offset+limit-1))
	if err != nil {
		return ObjMeta{}, nil, err
	}
	return meta, body, nil
}

func (d *aliyunDriver) OpenStream(bucket, path string) (io.ReadCloser, error) {
	b, err := d.bucket(bucket)
	if err != nil {
		return nil, err
	}
	return b.GetObject(path)
}

func (d *aliyunDriver) Put(bucket, path string, r io.Reader, _ int64, mime string) error {
	return d.PutWithClass(bucket, path, r, 0, mime, "")
}

// PutWithClass 上传对象并指定存储类别（2.5）。
// storageClass 为归一化值（standard/ia/archive），空串 = 服务端默认。
func (d *aliyunDriver) PutWithClass(bucket, path string, r io.Reader, _ int64, mime, storageClass string) error {
	b, err := d.bucket(bucket)
	if err != nil {
		return err
	}
	opts, err := aliyunUploadOpts(mime, storageClass)
	if err != nil {
		return err
	}
	return b.PutObject(path, r, opts...)
}

// PutFromFile 分片并发上传本地文件（5MB 分片 + 断点），不整文件进内存。
func (d *aliyunDriver) PutFromFile(bucket, path, filePath, mime string) error {
	return d.PutFromFileWithClass(bucket, path, filePath, mime, "")
}

// PutFromFileWithClass 分片上传并指定存储类别（2.5）。
func (d *aliyunDriver) PutFromFileWithClass(bucket, path, filePath, mime, storageClass string) error {
	b, err := d.bucket(bucket)
	if err != nil {
		return err
	}
	opts, err := aliyunUploadOpts(mime, storageClass)
	if err != nil {
		return err
	}
	opts = append(opts, oss.Checkpoint(true, ""), oss.Routines(3))
	return b.UploadFile(path, filePath, 5*1024*1024, opts...)
}

// aliyunUploadOpts 组装上传选项：Content-Type + 存储类别。
//
// 阿里云与 S3 的存储类别枚举名不同（阿里云 Archive / S3 GLACIER），
// 归一化在 driver 层完成，UI 只认 standard/ia/archive 三个值。
func aliyunUploadOpts(mime, storageClass string) ([]oss.Option, error) {
	var opts []oss.Option
	if mime != "" {
		opts = append(opts, oss.ContentType(mime))
	}
	switch storageClass {
	case "":
	case StorageClassStandard:
		opts = append(opts, oss.StorageClass(oss.StorageStandard))
	case StorageClassIA:
		opts = append(opts, oss.StorageClass(oss.StorageIA))
	case StorageClassArchive:
		opts = append(opts, oss.StorageClass(oss.StorageArchive))
	default:
		return nil, fmt.Errorf("不支持的存储类别: %s", storageClass)
	}
	return opts, nil
}

// Presign 离线计算签名 URL（V1 签名，不发网络请求）。
func (d *aliyunDriver) Presign(bucket, path string, expires int64) (string, error) {
	b, err := d.bucket(bucket)
	if err != nil {
		return "", err
	}
	return b.SignURL(path, oss.HTTPGet, expires)
}

// GetObjectAcl 读取对象 ACL，返回是否为公共读。
//
// 为何不直接用 SDK 的 GetObjectACL：该版本 SDK 的返回结构（GetBucketACLResult 别名）
// 仅含 ACL / Owner 两个字段，根本没有 Grant 列表；且 ACL 字段的 xml tag 是
// `AccessControlList>Grant`——Go 会把它解析为 <Grant> 元素的文本（而 <Grant> 内只有
// 子元素 Grantee / Permission），因此 r.ACL 恒为空字符串，永远判定为「非公共读」。
// 这正是此前「公开后无法取消公开」的根因：get_acl 总是返回 false，前端永远走不到
// 「恢复私有」分支。
//
// 替代方案：匿名（不签名）探测对象是否可被任何人访问。公共读对象允许匿名 GET/HEAD，
// 返回 2xx；私有对象返回 403。复用了 SDK 的 http.Client（含代理 / 传输设置），
// 仅去掉签名这一项，最大限度复用既有网络环境，避免探测因环境差异而失败。
func (d *aliyunDriver) GetObjectAcl(bucket, path string) (bool, error) {
	return d.probePublic(bucket, path)
}

// probePublic 匿名探测对象是否可公开访问。
// 优先用与签名请求相同的 http.Client；优先 virtual-hosted URL，再退到 path-style，
// 以兼容自定义域名 / CNAME / path-style 端点。仅取首字节（Range bytes=0-0），避免
// 大对象整文件下载。
func (d *aliyunDriver) probePublic(bucket, path string) (bool, error) {
	cfg := d.client.Config
	ep := normalizeAclEndpoint(cfg.Endpoint)
	enc := encodeKeySegments(path)
	var urls []string
	if cfg.IsCname {
		// CNAME 自定义域名通常直接绑定到某个桶：https://<ep>/<key>
		urls = []string{fmt.Sprintf("https://%s/%s", ep, enc)}
	} else if cfg.IsPathStyle {
		urls = []string{fmt.Sprintf("https://%s/%s/%s", ep, bucket, enc)}
	} else {
		urls = []string{
			fmt.Sprintf("https://%s.%s/%s", bucket, ep, enc),
			fmt.Sprintf("https://%s/%s/%s", ep, bucket, enc),
		}
	}
	hc := d.client.HTTPClient
	if hc == nil {
		hc = &http.Client{Timeout: 8 * time.Second}
	}
	var lastErr error
	for _, u := range urls {
		req, e := http.NewRequest("GET", u, nil)
		if e != nil {
			lastErr = e
			continue
		}
		req.Header.Set("Range", "bytes=0-0")
		resp, e := hc.Do(req)
		if e != nil {
			lastErr = e
			continue // 网络 / 解析错误：尝试下一候选 URL 样式
		}
		// 排空并关闭，避免复用连接时残留响应体
		_, _ = io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		switch {
		case resp.StatusCode >= 200 && resp.StatusCode < 300:
			return true, nil // 2xx（含 206 分片）：匿名可访问 => 公共读
		case resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusUnauthorized:
			return false, nil // 明确拒绝匿名访问 => 私有
		default:
			// 404（URL 样式不匹配）等：尝试候选样式，记录最近一次状态
			lastErr = fmt.Errorf("unexpected status %d for %s", resp.StatusCode, u)
			continue
		}
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("no candidate URL tried for %s/%s", bucket, path)
	}
	return false, lastErr
}

// normalizeAclEndpoint 去除端点的 scheme 与尾部斜杠。
func normalizeAclEndpoint(ep string) string {
	ep = strings.TrimSpace(ep)
	ep = strings.TrimPrefix(ep, "https://")
	ep = strings.TrimPrefix(ep, "http://")
	return strings.TrimSuffix(ep, "/")
}

// encodeKeySegments 按段（以 / 分隔）对对象 key 做路径编码。
// 必须逐段编码后再用 / 拼接——否则整串编码会把分隔斜杠也转义掉。
func encodeKeySegments(key string) string {
	parts := strings.Split(key, "/")
	for i, p := range parts {
		parts[i] = url.PathEscape(p)
	}
	return strings.Join(parts, "/")
}

// SetObjectAcl 切换对象公共读 / 私有（OSS 支持对象级 ACL，可在线修改）。
func (d *aliyunDriver) SetObjectAcl(bucket, path string, public bool) error {
	b, err := d.bucket(bucket)
	if err != nil {
		return err
	}
	acl := oss.ACLPrivate
	if public {
		acl = oss.ACLPublicRead
	}
	return b.SetObjectACL(path, acl)
}

func (d *aliyunDriver) Delete(bucket, path string) error {
	b, err := d.bucket(bucket)
	if err != nil {
		return err
	}
	return b.DeleteObject(path)
}

// deleteBatchSize 与 OSS DeleteObjects 单次 1000 个 key 的服务端上限一致。
const deleteBatchSize = 1000

// copyConcurrency 目录移动时对象复制阶段的并发路数。CopyObject 是服务端
// 服务端拷贝，单对象耗时主要在往返上，4 路并发即可把大目录搬迁提速约 4 倍，
// 又不至于触发服务端限流。
const copyConcurrency = 4

// DeleteMany 分块调用服务端批量删除接口（1000 key/次），把逐条 DELETE 的
// N 次往返压成 ⌈N/1000⌉ 次。请求级失败（网络/权限）无法细分逐 key 结果，
// 记为该块全部失败；请求成功则按服务端确认的 DeletedObjects 计数。
func (d *aliyunDriver) DeleteMany(bucket string, paths []string) (int, []DeleteFailure) {
	if len(paths) == 0 {
		return 0, nil
	}
	b, err := d.bucket(bucket)
	if err != nil {
		return 0, allFailed(paths, err)
	}
	deleted := 0
	var fails []DeleteFailure
	for start := 0; start < len(paths); start += deleteBatchSize {
		end := start + deleteBatchSize
		if end > len(paths) {
			end = len(paths)
		}
		chunk := paths[start:end]
		res, e := b.DeleteObjects(chunk)
		if e != nil {
			for _, k := range chunk {
				fails = append(fails, DeleteFailure{Key: k, Error: e.Error()})
			}
			continue
		}
		deleted += len(res.DeletedObjects)
	}
	return deleted, fails
}

// DeletePrefix 流式递归删除：列举一页（≤1000 key）删一页，循环到列举耗尽，
// 不设总量上限——任意大小的目录都能删。页与页之间用 marker 续接：已删 key
// 均不大于当前 marker，删除不影响后续页的列举起点。中途失败返回已删除数量
// （部分删除无法回滚，这是删除语义的固有性质，错误信息如实带出进度）。
func (d *aliyunDriver) DeletePrefix(bucket, prefix string) (int, error) {
	b, err := d.bucket(bucket)
	if err != nil {
		return 0, err
	}
	deleted := 0
	marker := oss.Marker("")
	for {
		resp, e := b.ListObjects(oss.Prefix(prefix), marker, oss.MaxKeys(deleteBatchSize))
		if e != nil {
			return deleted, fmt.Errorf("列举失败（已删除 %d 个）: %w", deleted, e)
		}
		if len(resp.Objects) > 0 {
			keys := make([]string, 0, len(resp.Objects))
			for _, o := range resp.Objects {
				keys = append(keys, o.Key)
			}
			res, e := b.DeleteObjects(keys)
			if e != nil {
				return deleted, fmt.Errorf("批量删除失败（已删除 %d 个）: %w", deleted, e)
			}
			deleted += len(res.DeletedObjects)
		}
		if !resp.IsTruncated || resp.NextMarker == "" {
			break
		}
		marker = oss.Marker(resp.NextMarker)
	}
	// prefix 自身的目录标记对象（若存在）补删一次：多数情况下该 key 并不存在，
	// DeleteObject 按幂等语义返回成功，不影响结果。
	if err := b.DeleteObject(prefix); err != nil {
		log.Printf("补删目录标记对象失败 %s: %v", prefix, err)
	}
	return deleted, nil
}

// Copy 复制单个对象（不删源）。Move 的复制阶段与批量复制共用。
func (d *aliyunDriver) Copy(bucket, from, to string) error {
	b, err := d.bucket(bucket)
	if err != nil {
		return err
	}
	if _, err := b.CopyObject(from, to); err != nil {
		return fmt.Errorf("复制失败: %w", err)
	}
	return nil
}

func (d *aliyunDriver) Move(bucket, from, to string) error {
	if err := d.Copy(bucket, from, to); err != nil {
		return err
	}
	b, err := d.bucket(bucket)
	if err != nil {
		return err
	}
	if err := b.DeleteObject(from); err != nil {
		return fmt.Errorf("删除源失败: %w", err)
	}
	return nil
}

// copyKeysConcurrently 并发复制一批 key（copyConcurrency 路）。返回已成功
// 的目标 key 列表与首个错误；失败时等待全部在途复制结束后返回，调用方据
// copied 列表回滚。
func (d *aliyunDriver) copyKeysConcurrently(b *oss.Bucket, pairs [][2]string) ([]string, error) {
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
			_, e := b.CopyObject(src, dst)
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
// 失败语义：
//   - 页内复制失败：回滚本页已复制的目标对象，源对象原样保留；此前各页
//     已复制且已删源、无法回滚，错误信息如实报告已移动数量。
//   - 页内删除失败：目标对象已就位，仅清理未净——重跑 move 即可续传
//     （CopyObject 覆盖写幂等，已搬迁对象会重复复制一次后继续）。
func (d *aliyunDriver) MovePrefix(bucket, fromPrefix, toPrefix string) (int, error) {
	b, err := d.bucket(bucket)
	if err != nil {
		return 0, err
	}
	// 源前缀与目标前缀都必须以 "/" 结尾：尾部斜杠缺失会导致
	// 「a/b」误匹配「a/bak/...」这类同前缀兄弟目录。
	fromP := normalizeDirPrefix(fromPrefix)
	toP := normalizeDirPrefix(toPrefix)
	if fromP == toP {
		return 0, fmt.Errorf("源目录与目标目录相同")
	}

	moved := 0
	marker := oss.Marker("")
	for {
		resp, e := b.ListObjects(oss.Prefix(fromP), marker, oss.MaxKeys(deleteBatchSize))
		if e != nil {
			return moved, fmt.Errorf("列举源目录失败（已移动 %d 个）: %w", moved, e)
		}
		if len(resp.Objects) > 0 {
			pairs := make([][2]string, 0, len(resp.Objects))
			for _, o := range resp.Objects {
				if o.Key == fromP {
					continue // 目录标记对象单独处理
				}
				pairs = append(pairs, [2]string{o.Key, toP + strings.TrimPrefix(o.Key, fromP)})
			}
			if len(pairs) > 0 {
				copied, cerr := d.copyKeysConcurrently(b, pairs)
				if cerr != nil {
					// 回滚本页已复制的目标对象，避免留下重复数据
					for _, dst := range copied {
						_ = b.DeleteObject(dst)
					}
					return moved, fmt.Errorf("复制对象失败（已移动 %d 个，本页已回滚）: %w", moved, cerr)
				}
				keys := make([]string, 0, len(pairs))
				for _, p := range pairs {
					keys = append(keys, p[0])
				}
				res, de := b.DeleteObjects(keys)
				if de != nil {
					return moved + len(keys), fmt.Errorf(
						"目标对象已全部复制，但清理源对象失败（可重试续传，已复制 %d 个）: %w",
						moved+len(keys), de)
				}
				moved += len(res.DeletedObjects)
			}
		}
		if !resp.IsTruncated || resp.NextMarker == "" {
			break
		}
		marker = oss.Marker(resp.NextMarker)
	}

	if moved == 0 {
		// 目录为空（或不存在）：仅剩目录标记对象需要搬移，否则改名后目录会
		// 「凭空消失」。目录标记对象不存在（目录本身不存在）时 CopyObject 报错，
		// 与旧行为一致地把错误返回给用户。
		if _, e := b.CopyObject(fromP, toP); e != nil {
			return 0, fmt.Errorf("移动目录标记对象失败: %w", e)
		}
		if e := b.DeleteObject(fromP); e != nil {
			return 0, fmt.Errorf("删除源目录标记对象失败: %w", e)
		}
		return 0, nil
	}
	// 有子对象被搬移：目标目录由子对象隐式重建，无需显式搬标记对象；
	// 仅补删源标记对象（多数情况下该 key 不存在，幂等）。
	if e := b.DeleteObject(fromP); e != nil {
		log.Printf("补删源目录标记对象失败 %s: %v", fromP, e)
	}
	return moved, nil
}

// ---------- 2.2 跨桶复制 ----------

// CopyAcross 跨桶复制单个对象（2.2）。
//
// 阿里云用 CopyObjectTo（源桶 = 当前 bucket，目标桶 = dstBucket）。
// 同桶时 dstBucket == bucket，走的是与 Copy 等价的一条路径。
func (d *aliyunDriver) CopyAcross(srcBucket, dstBucket, from, to string) error {
	src, err := d.bucket(srcBucket)
	if err != nil {
		return err
	}
	dstName, err := d.pickBucket(dstBucket)
	if err != nil {
		return err
	}
	if dstName == src.BucketName {
		if _, err := src.CopyObject(from, to); err != nil {
			return fmt.Errorf("复制失败: %w", err)
		}
		return nil
	}
	if _, err := src.CopyObjectTo(dstName, to, from); err != nil {
		return fmt.Errorf("跨桶复制失败: %w", err)
	}
	return nil
}

// MoveAcross 跨桶移动单个对象（copy + delete）。
func (d *aliyunDriver) MoveAcross(srcBucket, dstBucket, from, to string) error {
	if err := d.CopyAcross(srcBucket, dstBucket, from, to); err != nil {
		return err
	}
	b, err := d.bucket(srcBucket)
	if err != nil {
		return err
	}
	if err := b.DeleteObject(from); err != nil {
		return fmt.Errorf("删除源失败: %w", err)
	}
	return nil
}

// CopyPrefixAcross 跨桶递归复制一个前缀（2.2）。
//
// 与 MovePrefix 同构，但不删源对象。流式推进：每页（≤1000 key）并发复制，
// 页内失败回滚本页已复制的目标对象。跨桶时每页都要重新取目标桶句柄。
func (d *aliyunDriver) CopyPrefixAcross(srcBucket, dstBucket, fromPrefix, toPrefix string) (int, error) {
	src, err := d.bucket(srcBucket)
	if err != nil {
		return 0, err
	}
	dstName, err := d.pickBucket(dstBucket)
	if err != nil {
		return 0, err
	}
	fromP := normalizeDirPrefix(fromPrefix)
	toP := normalizeDirPrefix(toPrefix)
	if fromP == toP && src.BucketName == dstName {
		return 0, fmt.Errorf("源目录与目标目录相同")
	}

	copied := 0
	marker := oss.Marker("")
	for {
		resp, e := src.ListObjects(oss.Prefix(fromP), marker, oss.MaxKeys(deleteBatchSize))
		if e != nil {
			return copied, fmt.Errorf("列举源目录失败（已复制 %d 个）: %w", copied, e)
		}
		if len(resp.Objects) > 0 {
			pairs := make([][2]string, 0, len(resp.Objects))
			for _, o := range resp.Objects {
				if o.Key == fromP {
					continue // 目录标记对象单独处理
				}
				pairs = append(pairs, [2]string{o.Key, toP + strings.TrimPrefix(o.Key, fromP)})
			}
			if len(pairs) > 0 {
				ok, cerr := d.copyKeysAcrossConcurrently(src, dstName, pairs)
				if cerr != nil {
					// 回滚本页已复制的目标对象，避免留下重复数据
					dst, _ := d.client.Bucket(dstName)
					for _, key := range ok {
						_ = dst.DeleteObject(key)
					}
					return copied, fmt.Errorf("复制对象失败（已复制 %d 个，本页已回滚）: %w", copied, cerr)
				}
				copied += len(ok)
			}
		}
		if !resp.IsTruncated || resp.NextMarker == "" {
			break
		}
		marker = oss.Marker(resp.NextMarker)
	}

	if copied == 0 {
		// 源目录为空：仍需复制目录标记对象（若存在），否则目标目录会「凭空消失」
		if _, e := src.CopyObjectTo(dstName, toP, fromP); e != nil {
			return 0, fmt.Errorf("复制目录标记对象失败: %w", e)
		}
		return 0, nil
	}
	return copied, nil
}

// copyKeysAcrossConcurrently 跨桶并发复制一批 key（copyConcurrency 路）。
func (d *aliyunDriver) copyKeysAcrossConcurrently(src *oss.Bucket, dstName string, pairs [][2]string) ([]string, error) {
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
			_, e := src.CopyObjectTo(dstName, dstKey, srcKey)
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
// 对象存储没有「原地改元数据」的 API——阿里云与 S3 都只能靠
// CopyObject + MetadataDirective=REPLACE 把对象复制到自身并替换元数据。
// 因此这里是「自复制」：src == dst，服务端用新元数据覆盖原对象。
//
// 注意：自复制会重写对象的 Last-Modified 与 ETag（ETag 对同内容不变），
// 这是协议层面的固有代价，无法规避。
func (d *aliyunDriver) SetMeta(bucket, path string, patch MetaPatch) error {
	b, err := d.bucket(bucket)
	if err != nil {
		return err
	}
	// REPLACE 语义下不传任何元数据字段 = 全部清空。因此未修改的项
	// 必须先读出原值再回填，否则会误清。
	cur, err := d.Stat(bucket, path)
	if err != nil {
		return fmt.Errorf("读取原元数据失败: %w", err)
	}

	opts := []oss.Option{oss.MetadataDirective(oss.MetaReplace)}
	ct := patch.ContentType
	if ct == "" {
		ct = cur.ContentType
	}
	if ct != "" {
		opts = append(opts, oss.ContentType(ct))
	}
	cd := patch.ContentDisposition
	if cd == "" {
		cd = cur.ContentDisposition
	}
	if cd != "" {
		opts = append(opts, oss.ContentDisposition(cd))
	}
	cc := patch.CacheControl
	if cc == "" {
		cc = cur.CacheControl
	}
	if cc != "" {
		opts = append(opts, oss.CacheControl(cc))
	}
	ce := patch.ContentEncoding
	if ce == "" {
		ce = cur.ContentEncoding
	}
	if ce != "" {
		opts = append(opts, oss.ContentEncoding(ce))
	}
	// 自定义元数据：patch 为 nil 表示不动；非 nil 则整体替换
	meta := patch.UserMetadata
	if meta == nil {
		meta = cur.UserMetadata
	}
	for k, v := range meta {
		if v == "" {
			continue // 空值 = 删除该键，OSS 侧靠「不传」表达
		}
		opts = append(opts, oss.Meta(k, v))
	}
	if patch.StorageClass != "" {
		sc, err := aliyunStorageClass(patch.StorageClass)
		if err != nil {
			return err
		}
		opts = append(opts, oss.StorageClass(sc))
	}
	if _, err := b.CopyObject(path, path, opts...); err != nil {
		return fmt.Errorf("修改元数据失败: %w", err)
	}
	return nil
}

// aliyunStorageClass 把归一化存储类别翻译成阿里云枚举。
func aliyunStorageClass(v string) (oss.StorageClassType, error) {
	switch v {
	case StorageClassStandard:
		return oss.StorageStandard, nil
	case StorageClassIA:
		return oss.StorageIA, nil
	case StorageClassArchive:
		return oss.StorageArchive, nil
	default:
		return "", fmt.Errorf("不支持的存储类别: %s", v)
	}
}

// ---------- 2.3 对象标签 ----------

// SetTags 覆盖式设置对象标签（2.3）。传空 map 表示清空所有标签。
func (d *aliyunDriver) SetTags(bucket, path string, tags map[string]string) error {
	b, err := d.bucket(bucket)
	if err != nil {
		return err
	}
	tagging := oss.Tagging{}
	for k, v := range tags {
		if k == "" {
			continue
		}
		tagging.Tags = append(tagging.Tags, oss.Tag{Key: k, Value: v})
	}
	if err := b.PutObjectTagging(path, tagging); err != nil {
		return fmt.Errorf("设置标签失败: %w", err)
	}
	return nil
}

// GetTags 读取对象标签（2.3）。对象无标签时返回空 map 而非错误。
func (d *aliyunDriver) GetTags(bucket, path string) (map[string]string, error) {
	b, err := d.bucket(bucket)
	if err != nil {
		return nil, err
	}
	res, err := b.GetObjectTagging(path)
	if err != nil {
		return nil, fmt.Errorf("读取标签失败: %w", err)
	}
	out := make(map[string]string, len(res.Tags))
	for _, t := range res.Tags {
		out[t.Key] = t.Value
	}
	return out, nil
}
