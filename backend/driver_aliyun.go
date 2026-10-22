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
	"time"

	"github.com/aliyun/aliyun-oss-go-sdk/oss"
)

type aliyunDriver struct {
	baseDriver
	client *oss.Client
}

func newAliyunDriver(cfg ConnConfig) (StorageDriver, error) {
	client, err := oss.New(cfg.Endpoint, cfg.AccessKeyID, cfg.AccessKeySecret)
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
		MIME: h.Get("Content-Type"),
		ETag: strings.Trim(h.Get("ETag"), `"`),
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
	b, err := d.bucket(bucket)
	if err != nil {
		return err
	}
	var opts []oss.Option
	if mime != "" {
		opts = append(opts, oss.ContentType(mime))
	}
	return b.PutObject(path, r, opts...)
}

// PutFromFile 分片并发上传本地文件（5MB 分片 + 断点），不整文件进内存。
func (d *aliyunDriver) PutFromFile(bucket, path, filePath, mime string) error {
	b, err := d.bucket(bucket)
	if err != nil {
		return err
	}
	var opts []oss.Option
	if mime != "" {
		opts = append(opts, oss.ContentType(mime))
	}
	opts = append(opts, oss.Checkpoint(true, ""), oss.Routines(3))
	return b.UploadFile(path, filePath, 5*1024*1024, opts...)
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

// listPrefixKeys 平铺列举 prefix 下的全部对象 key（不传 delimiter，故含各层级子对象）。
// 最多收集 limit+1 个：多出的那一个只用于判定「是否超过上限」，超出即返回 hasMore=true，
// 由调用方决定中止还是放行，从而避免为了一次判断而多拉一整页。
func (d *aliyunDriver) listPrefixKeys(b *oss.Bucket, prefix string, limit int) ([]string, bool, error) {
	keys := make([]string, 0, limit+1)
	marker := oss.Marker("")
	for {
		resp, err := b.ListObjects(oss.Prefix(prefix), marker, oss.MaxKeys(1000))
		if err != nil {
			return nil, false, err
		}
		for _, o := range resp.Objects {
			keys = append(keys, o.Key)
			if len(keys) > limit {
				return keys[:limit], true, nil
			}
		}
		if !resp.IsTruncated {
			return keys, false, nil
		}
		marker = oss.Marker(resp.NextMarker)
	}
}

// DeletePrefix 先完整收集 prefix 下的 key（超限即中止，不做任何删除），
// 再分批调用 DeleteObjects。这样「超限中止」是原子的，不会删一半留下残缺目录。
func (d *aliyunDriver) DeletePrefix(bucket, prefix string, limit int) (int, error) {
	b, err := d.bucket(bucket)
	if err != nil {
		return 0, err
	}
	if limit <= 0 {
		limit = deleteBatchSize
	}
	keys, hasMore, err := d.listPrefixKeys(b, prefix, limit)
	if err != nil {
		return 0, err
	}
	if hasMore {
		return 0, fmt.Errorf("目录内对象超过 %d 个，已中止删除；请分批处理或改用服务端工具", limit)
	}
	deleted := 0
	for start := 0; start < len(keys); start += deleteBatchSize {
		end := start + deleteBatchSize
		if end > len(keys) {
			end = len(keys)
		}
		res, err := b.DeleteObjects(keys[start:end])
		if err != nil {
			return deleted, fmt.Errorf("批量删除失败（已删除 %d 个）: %w", deleted, err)
		}
		deleted += len(res.DeletedObjects)
	}
	// prefix 自身的目录标记对象（若存在）不在上面的列举结果里时，单独补删一次。
	// 多数情况下该 key 并不存在，此处 DeleteObject 按幂等语义返回成功，不影响结果。
	if err := b.DeleteObject(prefix); err != nil {
		log.Printf("补删目录标记对象失败 %s: %v", prefix, err)
	}
	return deleted, nil
}

func (d *aliyunDriver) Move(bucket, from, to string) error {
	b, err := d.bucket(bucket)
	if err != nil {
		return err
	}
	if _, err := b.CopyObject(from, to); err != nil {
		return fmt.Errorf("复制失败: %w", err)
	}
	if err := b.DeleteObject(from); err != nil {
		return fmt.Errorf("删除源失败: %w", err)
	}
	return nil
}

// MovePrefix 递归移动目录：把 fromPrefix 下的全部对象复制到 toPrefix 之下，
// 全部复制成功后再删除源对象。
//
// 关键设计：
//   - 源集合在移动前一次性列举（含各层级子对象，不折叠目录）。超限即中止，
//     不做任何改动——「超限中止」是原子的。
//   - 先全量复制、后批量删除。若复制中途失败，已复制的目标对象会被回滚删除，
//     源对象保持原样，不留半吊子状态。
//   - 删除阶段失败只影响部分源对象（已复制成功的目标对象保留），此时返回
//     明确的错误说明，让用户知道「重命名已完成但清理未净」，而不是假装成功。
func (d *aliyunDriver) MovePrefix(bucket, fromPrefix, toPrefix string, limit int) (int, error) {
	b, err := d.bucket(bucket)
	if err != nil {
		return 0, err
	}
	if limit <= 0 {
		limit = deleteBatchSize
	}
	// 源前缀与目标前缀都必须以 "/" 结尾：尾部斜杠缺失会导致
	// 「a/b」误匹配「a/bak/...」这类同前缀兄弟目录。
	fromP := normalizeDirPrefix(fromPrefix)
	toP := normalizeDirPrefix(toPrefix)
	if fromP == toP {
		return 0, fmt.Errorf("源目录与目标目录相同")
	}

	// 列举源前缀下的全部对象（递归，不折叠子目录）
	var keys []string
	marker := oss.Marker("")
	for {
		resp, e := b.ListObjects(oss.Prefix(fromP), marker, oss.MaxKeys(1000))
		if e != nil {
			return 0, fmt.Errorf("列举源目录失败: %w", e)
		}
		for _, o := range resp.Objects {
			if o.Key == fromP {
				continue // 目录标记对象本身单独处理
			}
			keys = append(keys, o.Key)
			if len(keys) > limit {
				return 0, fmt.Errorf("目录内对象超过 %d 个，已中止移动；请分批处理", limit)
			}
		}
		if !resp.IsTruncated {
			break
		}
		marker = oss.Marker(resp.NextMarker)
	}
	if len(keys) == 0 {
		// 源前缀下没有对象：可能只有目录标记对象，也可能根本不存在。
		// 仍需把目录标记对象搬过去，否则改名后目录会「凭空消失」。
		if _, e := b.CopyObject(fromP, toP); e != nil {
			return 0, fmt.Errorf("移动目录标记对象失败: %w", e)
		}
		if e := b.DeleteObject(fromP); e != nil {
			return 0, fmt.Errorf("删除源目录标记对象失败: %w", e)
		}
		return 0, nil
	}

	// 阶段一：全量复制。逐个 CopyObject（小批量，OSS 单次 CopyObject 上限
	// 只针对一次请求里的多个 key，逐个调用天然规避）。
	copied := make([]string, 0, len(keys))
	rollback := func() {
		// 回滚：删除已复制的目标对象，避免留下重复数据。
		for _, dst := range copied {
			_ = b.DeleteObject(dst)
		}
	}
	for _, src := range keys {
		dst := toP + strings.TrimPrefix(src, fromP)
		if _, e := b.CopyObject(src, dst); e != nil {
			rollback()
			return 0, fmt.Errorf("复制对象失败（%s → %s），已回滚 %d 个已复制对象: %w",
				src, dst, len(copied), e)
		}
		copied = append(copied, dst)
	}

	// 阶段二：批量删除源对象。
	deleted := 0
	for start := 0; start < len(keys); start += deleteBatchSize {
		end := start + deleteBatchSize
		if end > len(keys) {
			end = len(keys)
		}
		res, e := b.DeleteObjects(keys[start:end])
		if e != nil {
			return len(copied), fmt.Errorf("重命名已完成但清理源对象失败（已复制 %d 个，请手动核对）: %w", len(copied), e)
		}
		deleted += len(res.DeletedObjects)
	}
	// 补删目录标记对象：多数情况下该 key 不存在，按幂等语义返回成功。
	if e := b.DeleteObject(fromP); e != nil {
		log.Printf("补删源目录标记对象失败 %s: %v", fromP, e)
	}
	return deleted, nil
}
