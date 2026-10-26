package main

// s3_integration_test.go — S3 驱动对真实 HTTP 端点的集成验证。
//
// 用一个内存态的迷你 S3 服务端（只实现本测试用到的操作）跑通 s3Driver：
// 列举、Stat、上传（Put/PutFromFile）、下载、删除、复制、移动、
// 跨桶复制、元数据编辑（自复制 + REPLACE）、标签读写。
//
// 目的：验证 minio-go 的调用姿势正确（头名、参数、语义），
// 特别是几个容易写错的地方：
//   - x-amz-meta-* 用户元数据的读写往返
//   - CopyObject 自复制 + x-amz-metadata-directive=REPLACE 是否真的替换元数据
//   - PutObjectTagging / GetObjectTagging 的往返
//   - 跨桶 CopyObject 的 src/dst bucket 分离
//
// 这个测试不依赖外部服务，go test 直接跑。

import (
	"bytes"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
)

// ---------- 迷你 S3 服务端 ----------

type fakeS3Object struct {
	data         []byte
	contentType  string
	disposition  string
	cacheControl string
	userMeta     map[string]string
	tags         map[string]string
	storageClass string
	etag         string
	modTime      string
}

type fakeS3 struct {
	mu      sync.Mutex
	buckets map[string]map[string]*fakeS3Object // bucket → key → object
}

func newFakeS3() *fakeS3 {
	return &fakeS3{buckets: map[string]map[string]*fakeS3Object{}}
}

func (f *fakeS3) put(bucket, key string, obj *fakeS3Object) {
	if f.buckets[bucket] == nil {
		f.buckets[bucket] = map[string]*fakeS3Object{}
	}
	f.buckets[bucket][key] = obj
}

// etagFor 造一个稳定的 ETag（内容 md5 的简化版：长度+散列）。
func etagFor(data []byte) string {
	h := 0
	for _, b := range data {
		h = h*31 + int(b)
	}
	return fmt.Sprintf("%08x", h)
}

func (f *fakeS3) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()

	// 路径形如 /<bucket>/<key...>（path-style）
	path := strings.TrimPrefix(r.URL.Path, "/")
	parts := strings.SplitN(path, "/", 2)
	bucket := parts[0]
	key := ""
	if len(parts) > 1 {
		key = parts[1]
	}
	if bucket == "" {
		w.WriteHeader(http.StatusBadRequest)
		return
	}

	switch r.Method {
	case "HEAD":
		// StatObject 走 HEAD：返回对象元数据头，不带 body
		obj := f.get(bucket, key)
		if obj == nil {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("ETag", `"`+obj.etag+`"`)
		w.Header().Set("Content-Type", obj.contentType)
		w.Header().Set("Last-Modified", "Thu, 01 Jan 2026 00:00:00 GMT")
		w.Header().Set("Content-Length", strconv.Itoa(len(obj.data)))
		if obj.disposition != "" {
			w.Header().Set("Content-Disposition", obj.disposition)
		}
		if obj.cacheControl != "" {
			w.Header().Set("Cache-Control", obj.cacheControl)
		}
		for k, v := range obj.userMeta {
			w.Header().Set("x-amz-meta-"+k, v)
		}
		if obj.storageClass != "" {
			w.Header().Set("x-amz-storage-class", obj.storageClass)
		}
		w.WriteHeader(http.StatusOK)

	case "GET":
		// GetBucketLocation：?location —— minio-go 在未指定 region 时会先探测。
		// 返回 LocationConstraint XML，否则后续所有请求都会因签名区域不匹配而失败。
		if r.URL.Query().Has("location") {
			w.Header().Set("Content-Type", "application/xml")
			w.WriteHeader(http.StatusOK)
			w.Write([]byte(`<?xml version="1.0" encoding="UTF-8"?><LocationConstraint xmlns="http://s3.amazonaws.com/doc/2006-03-01/">us-east-1</LocationConstraint>`))
			return
		}
		// 列举（无 key）或取对象（有 key）
		if key == "" {
			f.listObjects(w, r, bucket)
			return
		}
		// 列举（无 key）或取对象（有 key）
		if key == "" {
			f.listObjects(w, r, bucket)
			return
		}
		obj := f.get(bucket, key)
		if obj == nil {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("ETag", `"`+obj.etag+`"`)
		w.Header().Set("Content-Type", obj.contentType)
		// Last-Modified 必须是 HTTP 日期格式（RFC1123 GMT），
		// minio-go 解析不了 RFC3339——这是 mock 的责任，驱动无错。
		w.Header().Set("Last-Modified", "Thu, 01 Jan 2026 00:00:00 GMT")
		w.Header().Set("Content-Length", strconv.Itoa(len(obj.data)))
		if obj.disposition != "" {
			w.Header().Set("Content-Disposition", obj.disposition)
		}
		if obj.cacheControl != "" {
			w.Header().Set("Cache-Control", obj.cacheControl)
		}
		for k, v := range obj.userMeta {
			w.Header().Set("x-amz-meta-"+k, v)
		}
		if obj.storageClass != "" {
			w.Header().Set("x-amz-storage-class", obj.storageClass)
		}
		w.WriteHeader(http.StatusOK)
		w.Write(obj.data)

	case "PUT":
		// CopyObject：带 x-amz-copy-source 头
		if src := r.Header.Get("x-amz-copy-source"); src != "" {
			f.copyObject(w, r, bucket, key, src)
			return
		}
		// 上传
		body, _ := io.ReadAll(r.Body)
		// minio-go 对超过阈值的内容走 aws-chunked 流式签名
		//（x-amz-content-sha256: STREAMING-AWS4-HMAC-SHA256-PAYLOAD），
		// body 是 "<hex-size>;chunk-signature=...\r\n<data>\r\n0;...\r\n\r\n"
		// 的分块格式。真实 S3 会解开它，mock 也得解，否则内容不对。
		if isAwsChunked(r) {
			body = decodeAwsChunked(body)
		}
		obj := &fakeS3Object{
			data:         body,
			contentType:  r.Header.Get("Content-Type"),
			disposition:  r.Header.Get("Content-Disposition"),
			cacheControl: r.Header.Get("Cache-Control"),
			storageClass: r.Header.Get("x-amz-storage-class"),
			userMeta:     map[string]string{},
			tags:         map[string]string{},
			etag:         etagFor(body),
			modTime:      "2026-01-01T00:00:00Z",
		}
		for k, v := range r.Header {
			lk := strings.ToLower(k)
			if strings.HasPrefix(lk, "x-amz-meta-") && len(v) > 0 {
				obj.userMeta[lk[len("x-amz-meta-"):]] = v[0]
			}
		}
		if tc := r.Header.Get("x-amz-tagging"); tc != "" {
			for _, pair := range strings.Split(tc, "&") {
				kv := strings.SplitN(pair, "=", 2)
				if len(kv) == 2 {
					obj.tags[decodeURI(kv[0])] = decodeURI(kv[1])
				}
			}
		}
		f.put(bucket, key, obj)
		w.Header().Set("ETag", `"`+obj.etag+`"`)
		w.WriteHeader(http.StatusOK)

	case "DELETE":
		// 删除对象（也用于清标签：带 x-amz-tagging 头）
		if tagHdr := r.Header.Get("x-amz-tagging"); tagHdr != "" && r.URL.Query().Get("tagging") != "" {
			if obj := f.get(bucket, key); obj != nil {
				obj.tags = map[string]string{}
				w.WriteHeader(http.StatusOK)
				return
			}
		}
		if obj := f.get(bucket, key); obj != nil {
			if r.URL.Query().Get("tagging") != "" {
				w.WriteHeader(http.StatusOK)
				return
			}
			delete(f.buckets[bucket], key)
			w.WriteHeader(http.StatusNoContent)
			return
		}
		w.WriteHeader(http.StatusNoContent)

	case "POST":
		// 批量删除：POST /<bucket>?delete （body 为 XML 列表）
		if r.URL.Query().Has("delete") {
			body, _ := io.ReadAll(r.Body)
			var doc struct {
				Objects []struct {
					Key string `xml:"Key"`
				} `xml:"Object"`
			}
			xml.Unmarshal(body, &doc)
			deleted := []string{}
			for _, o := range doc.Objects {
				if f.get(bucket, o.Key) != nil {
					delete(f.buckets[bucket], o.Key)
					deleted = append(deleted, o.Key)
				}
			}
			out := struct {
				XMLName xml.Name `xml:"DeleteResult"`
				Deleted []struct {
					Key string `xml:"Key"`
				} `xml:"Deleted"`
			}{}
			for _, k := range deleted {
				out.Deleted = append(out.Deleted, struct {
					Key string `xml:"Key"`
				}{k})
			}
			bb, _ := xml.Marshal(out)
			if os.Getenv("FAKE_S3_DEBUG") != "" {
				fmt.Printf("[fake-s3] delete resp: %s\n", string(bb))
			}
			w.Header().Set("Content-Type", "application/xml")
			w.WriteHeader(http.StatusOK)
			// 真实 S3 的 DeleteResult 带 S3 命名空间
			// 真实 S3 的 DeleteResult 带 S3 命名空间；每个被删 key 一个 <Deleted> 元素
			w.Write([]byte(`<DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` + deletedXMLKeys(deleted) + `</DeleteResult>`))
			return
		}
		// PutObjectTagging：?tagging
		if r.URL.Query().Get("tagging") != "" {
			body, _ := io.ReadAll(r.Body)
			obj := f.get(bucket, key)
			if obj == nil {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			tags := map[string]string{}
			if err := xml.Unmarshal(body, &taggingXML{}); err == nil {
				// 已在下面用结构体解析
			}
			var doc struct {
				TagSet struct {
					Tag []struct {
						Key   string `xml:"Key"`
						Value string `xml:"Value"`
					} `xml:"Tag"`
				} `xml:"TagSet"`
			}
			xml.Unmarshal(body, &doc)
			for _, t := range doc.TagSet.Tag {
				tags[t.Key] = t.Value
			}
			obj.tags = tags
			w.WriteHeader(http.StatusOK)
			return
		}
		// GetObjectTagging：?tagging
		if r.URL.Query().Get("tagging") != "" {
			obj := f.get(bucket, key)
			if obj == nil {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			doc := struct {
				XMLName xml.Name `xml:"Tagging"`
				TagSet  struct {
					Tag []struct {
						Key   string `xml:"Key"`
						Value string `xml:"Value"`
					} `xml:"Tag"`
				} `xml:"TagSet"`
			}{}
			for k, v := range obj.tags {
				doc.TagSet.Tag = append(doc.TagSet.Tag, struct {
					Key   string `xml:"Key"`
					Value string `xml:"Value"`
				}{k, v})
			}
			out, _ := xml.Marshal(doc)
			w.Header().Set("Content-Type", "application/xml")
			w.WriteHeader(http.StatusOK)
			w.Write(out)
			return
		}
		w.WriteHeader(http.StatusBadRequest)
	}
}

type taggingXML struct {
	XMLName xml.Name `xml:"Tagging"`
}

// isAwsChunked 判断请求是否使用了 aws-chunked 流式签名。
//
// minio-go 的判据是 x-amz-content-sha256 头的值为
// STREAMING-AWS4-HMAC-SHA256-PAYLOAD（或带 -TRAILER 后缀）；
// Content-Encoding: aws-chunked 只在带 trailer 时才设，不能作为唯一判据。
func isAwsChunked(r *http.Request) bool {
	sha := r.Header.Get("x-amz-content-sha256")
	if strings.HasPrefix(sha, "STREAMING-") {
		return true
	}
	return strings.Contains(strings.ToLower(r.Header.Get("Transfer-Encoding")), "aws-chunked") ||
		strings.Contains(strings.ToLower(r.Header.Get("Content-Encoding")), "aws-chunked")
}

// decodeAwsChunked 解开 aws-chunked 流式签名格式的请求体。
//
// 格式：
//
//	<hex-size>;chunk-signature=<sig>\r\n
//	<data of hex-size bytes>\r\n
//	...重复...
//	0;chunk-signature=<sig>\r\n
//	\r\n
func decodeAwsChunked(body []byte) []byte {
	var out []byte
	pos := 0
	for pos < len(body) {
		// 读 chunk 头（到 \r\n）
		nl := bytes.Index(body[pos:], []byte("\r\n"))
		if nl < 0 {
			break
		}
		header := string(body[pos : pos+nl])
		pos += nl + 2
		// 头格式：<hex-size>;chunk-signature=...
		sizeHex := header
		if i := strings.Index(header, ";"); i >= 0 {
			sizeHex = header[:i]
		}
		size, err := strconv.ParseInt(strings.TrimSpace(sizeHex), 16, 64)
		if err != nil {
			break
		}
		if size == 0 {
			break // 结束块
		}
		end := pos + int(size)
		if end > len(body) {
			end = len(body)
		}
		out = append(out, body[pos:end]...)
		pos = end
		// 跳过数据后的 \r\n
		if pos+2 <= len(body) && body[pos] == '\r' && body[pos+1] == '\n' {
			pos += 2
		}
	}
	return out
}

func decodeURI(s string) string {
	s = strings.ReplaceAll(s, "+", " ")
	out := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		if s[i] == '%' && i+2 < len(s) {
			v, err := strconv.ParseUint(s[i+1:i+3], 16, 8)
			if err == nil {
				out = append(out, byte(v))
				i += 2
				continue
			}
		}
		out = append(out, s[i])
	}
	return string(out)
}

func (f *fakeS3) get(bucket, key string) *fakeS3Object {
	m, ok := f.buckets[bucket]
	if !ok {
		return nil
	}
	return m[key]
}

func (f *fakeS3) copyObject(w http.ResponseWriter, r *http.Request, dstBucket, dstKey, src string) {
	// x-amz-copy-source 形如 /<bucket>/<key>（可能带 ?versionId=）
	src = strings.TrimPrefix(src, "/")
	if i := strings.Index(src, "?"); i >= 0 {
		src = src[:i]
	}
	parts := strings.SplitN(src, "/", 2)
	srcBucket, srcKey := parts[0], ""
	if len(parts) > 1 {
		srcKey = parts[1]
	}
	obj := f.get(srcBucket, srcKey)
	if obj == nil {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	// 默认 COPY 语义：元数据沿用源对象
	newObj := &fakeS3Object{
		data:         obj.data,
		contentType:  obj.contentType,
		disposition:  obj.disposition,
		cacheControl: obj.cacheControl,
		userMeta:     map[string]string{},
		tags:         map[string]string{},
		etag:         obj.etag,
		modTime:      obj.modTime,
	}
	for k, v := range obj.userMeta {
		newObj.userMeta[k] = v
	}
	for k, v := range obj.tags {
		newObj.tags[k] = v
	}
	// REPLACE 语义：用请求头里的值整体替换
	if r.Header.Get("x-amz-metadata-directive") == "REPLACE" {
		newObj.contentType = r.Header.Get("Content-Type")
		newObj.disposition = r.Header.Get("Content-Disposition")
		newObj.cacheControl = r.Header.Get("Cache-Control")
		newObj.userMeta = map[string]string{}
		for k, v := range r.Header {
			lk := strings.ToLower(k)
			if strings.HasPrefix(lk, "x-amz-meta-") && len(v) > 0 {
				newObj.userMeta[lk[len("x-amz-meta-"):]] = v[0]
			}
		}
	}
	if sc := r.Header.Get("x-amz-storage-class"); sc != "" {
		newObj.storageClass = sc
	}
	f.put(dstBucket, dstKey, newObj)
	w.Header().Set("ETag", `"`+newObj.etag+`"`)
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(`<CopyObjectResult><ETag>"` + newObj.etag + `"</ETag></CopyObjectResult>`))
}

// listObjects 实现 ListObjects（V1 用 marker 翻页，V2 用 continuation-token）。
//
// 两种协议的请求参数都能解析；响应按请求版本给出对应的游标元素。
func (f *fakeS3) listObjects(w http.ResponseWriter, r *http.Request, bucket string) {
	prefix := r.URL.Query().Get("prefix")
	delimiter := r.URL.Query().Get("delimiter")
	maxKeys := 1000
	if v := r.URL.Query().Get("max-keys"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			maxKeys = n
		}
	}
	isV2 := r.URL.Query().Get("list-type") == "2"
	// 游标：V1 用 marker，V2 用 continuation-token
	cursor := r.URL.Query().Get("marker")
	if isV2 {
		cursor = r.URL.Query().Get("continuation-token")
	}
	if cursor == "" {
		cursor = r.URL.Query().Get("start-after")
	}

	keys := make([]string, 0)
	for k := range f.buckets[bucket] {
		if strings.HasPrefix(k, prefix) {
			keys = append(keys, k)
		}
	}
	// 排序（Go map 无序，必须排）
	for i := 0; i < len(keys); i++ {
		for j := i + 1; j < len(keys); j++ {
			if keys[j] < keys[i] {
				keys[i], keys[j] = keys[j], keys[i]
			}
		}
	}

	type contentEntry struct {
		Key          string `xml:"Key"`
		Size         int64  `xml:"Size"`
		ETag         string `xml:"ETag"`
		LastModified string `xml:"LastModified"`
		StorageClass string `xml:"StorageClass,omitempty"`
	}
	type commonPrefix struct {
		Prefix string `xml:"Prefix"`
	}
	var contents []contentEntry
	var prefixes []commonPrefix
	seenPrefix := map[string]bool{}
	count := 0
	truncated := false
	for _, k := range keys {
		// 游标语义：跳过 <= cursor 的 key
		if cursor != "" && k <= cursor {
			continue
		}
		if delimiter != "" {
			rest := strings.TrimPrefix(k, prefix)
			if i := strings.Index(rest, delimiter); i >= 0 {
				cp := prefix + rest[:i+len(delimiter)]
				if !seenPrefix[cp] {
					seenPrefix[cp] = true
					prefixes = append(prefixes, commonPrefix{Prefix: cp})
				}
				continue
			}
		}
		if count >= maxKeys {
			truncated = true
			break
		}
		obj := f.get(bucket, k)
		contents = append(contents, contentEntry{
			Key: k, Size: int64(len(obj.data)), ETag: `"` + obj.etag + `"`,
			// minio-go 会把 LastModified 解析成 time.Time，格式必须是 RFC3339
			LastModified: "2026-01-01T00:00:00.000Z",
		})
		count++
	}

	// encoding-type=url：minio-go 请求了这个参数，返回的 key 需要 URL 编码
	// （真实 S3 行为）。
	//
	// 注意：只编码 Contents 里的 Key，不编码 CommonPrefixes。
	// minio-go 的 V1 列举路径（listObjectsQuery）对 CommonPrefixes 不做
	// decodeS3Name 解码（只有 V2 路径 listObjectsV2 才解码），
	// 编码了反而会让驱动拿到 "a%2F" 而不是 "a/"。
	if r.URL.Query().Get("encoding-type") == "url" {
		for i := range contents {
			contents[i].Key = url.QueryEscape(contents[i].Key)
		}
	}

	// 根元素名随协议版本不同：V1 是 ListBucketResult，V2 是 ListBucketV2Result
	//（minio-go 的 ListBucketV2Result 结构没有 XMLName tag，靠根元素名匹配）。
	// 列举结果体。根元素名随协议版本不同（V1=ListBucketResult,
	// V2=ListBucketV2Result），minio-go 的两个结构体用不同根名匹配，
	// 故用两个结构体分别构造。
	//
	// EncodingType 必须带上：minio-go 的 decodeS3Name 靠它决定是否对 key
	// 做 URL 解码。少了它，驱动拿到的就是 "x%2F1.txt" 而不是 "x/1.txt"。
	encType := ""
	if r.URL.Query().Get("encoding-type") == "url" {
		encType = "url"
	}
	// 截断时给出下一页游标：V2 用 NextContinuationToken，V1 用 NextMarker
	nextTok := ""
	if truncated && len(contents) > 0 {
		nextTok = contents[len(contents)-1].Key
	}
	var out []byte
	if isV2 {
		doc := struct {
			XMLName             xml.Name       `xml:"ListBucketV2Result"`
			Name                string         `xml:"Name"`
			Prefix              string         `xml:"Prefix"`
			MaxKeys             int            `xml:"MaxKeys"`
			IsTruncated         bool           `xml:"IsTruncated"`
			Contents            []contentEntry `xml:"Contents"`
			Prefixes            []commonPrefix `xml:"CommonPrefixes"`
			NextContinuationTok string         `xml:"NextContinuationToken,omitempty"`
			EncodingType        string         `xml:"EncodingType,omitempty"`
		}{
			Name: bucket, Prefix: prefix, MaxKeys: maxKeys,
			IsTruncated: truncated, Contents: contents, Prefixes: prefixes,
			NextContinuationTok: nextTok, EncodingType: encType,
		}
		out, _ = xml.Marshal(doc)
	} else {
		doc := struct {
			XMLName      xml.Name       `xml:"ListBucketResult"`
			Name         string         `xml:"Name"`
			Prefix       string         `xml:"Prefix"`
			MaxKeys      int            `xml:"MaxKeys"`
			IsTruncated  bool           `xml:"IsTruncated"`
			Contents     []contentEntry `xml:"Contents"`
			Prefixes     []commonPrefix `xml:"CommonPrefixes"`
			NextMarker   string         `xml:"NextMarker,omitempty"`
			EncodingType string         `xml:"EncodingType,omitempty"`
		}{
			Name: bucket, Prefix: prefix, MaxKeys: maxKeys,
			IsTruncated: truncated, Contents: contents, Prefixes: prefixes,
			NextMarker: nextTok, EncodingType: encType,
		}
		out, _ = xml.Marshal(doc)
	}
	if os.Getenv("FAKE_S3_DEBUG") != "" {
		fmt.Printf("[fake-s3] XML: %s\n", string(out))
		fmt.Printf("[fake-s3] list bucket=%s prefix=%q delim=%q cursor=%q v2=%v truncated=%v contents=%d prefixes=%d\n",
			bucket, prefix, delimiter, cursor, isV2, truncated, len(contents), len(prefixes))
		for _, c := range contents {
			fmt.Printf("        content: %q\n", c.Key)
		}
		for _, p := range prefixes {
			fmt.Printf("        prefix : %q\n", p.Prefix)
		}
	}
	w.Header().Set("Content-Type", "application/xml")
	w.WriteHeader(http.StatusOK)
	w.Write(out)
}

// ---------- 测试 ----------

// newTestS3Driver 起一个内存 S3 服务并连上 s3Driver。
func newTestS3Driver(t *testing.T) (*s3Driver, *fakeS3) {
	t.Helper()
	fake := newFakeS3()
	srv := httptest.NewServer(fake)
	t.Cleanup(srv.Close)

	cfg := ConnConfig{
		Provider:        ProviderS3,
		Endpoint:        srv.URL,
		AccessKeyID:     "AK",
		AccessKeySecret: "SK",
		PathStyle:       true,
	}
	d, err := newS3Driver(cfg)
	if err != nil {
		t.Fatalf("创建 s3Driver 失败: %v", err)
	}
	return d.(*s3Driver), fake
}

func TestS3Driver_UploadAndStat(t *testing.T) {
	d, fake := newTestS3Driver(t)
	fake.put("buck1", "hello.txt", &fakeS3Object{
		data: []byte("hello"), contentType: "text/plain",
		etag: "e1", modTime: "2026-01-01T00:00:00Z",
	})

	m, err := d.Stat("buck1", "hello.txt")
	if err != nil {
		t.Fatalf("Stat 失败: %v", err)
	}
	if m.Size != 5 {
		t.Errorf("Size 应为 5, got %d", m.Size)
	}
	if m.MIME != "text/plain" {
		t.Errorf("MIME 应为 text/plain, got %q", m.MIME)
	}
	if m.ETag != "e1" {
		t.Errorf("ETag 应为 e1, got %q", m.ETag)
	}
}

// TestS3Driver_UserMetadataRoundTrip 用户自定义元数据的读写往返。
func TestS3Driver_UserMetadataRoundTrip(t *testing.T) {
	d, fake := newTestS3Driver(t)
	fake.put("buck1", "m.txt", &fakeS3Object{
		data: []byte("x"), contentType: "text/plain",
		userMeta: map[string]string{"owner": "alice", "dept": "rnd"},
		etag:     "e1", modTime: "2026-01-01T00:00:00Z",
	})

	m, err := d.Stat("buck1", "m.txt")
	if err != nil {
		t.Fatalf("Stat 失败: %v", err)
	}
	if m.UserMetadata["owner"] != "alice" {
		t.Errorf("UserMetadata[owner] 应为 alice, got %q", m.UserMetadata["owner"])
	}
	if m.UserMetadata["dept"] != "rnd" {
		t.Errorf("UserMetadata[dept] 应为 rnd, got %q", m.UserMetadata["dept"])
	}
}

// TestS3Driver_SetMetaUsesReplaceDirective 元数据编辑必须走
// CopyObject + x-amz-metadata-directive=REPLACE（自复制）。
func TestS3Driver_SetMetaUsesReplaceDirective(t *testing.T) {
	d, fake := newTestS3Driver(t)
	fake.put("buck1", "m.txt", &fakeS3Object{
		data: []byte("content"), contentType: "text/plain",
		cacheControl: "max-age=60",
		userMeta:     map[string]string{"owner": "alice"},
		etag:         "e1", modTime: "2026-01-01T00:00:00Z",
	})

	err := d.SetMeta("buck1", "m.txt", MetaPatch{
		ContentType:  "application/json",
		CacheControl: "max-age=600",
		UserMetadata: map[string]string{"owner": "bob"},
	})
	if err != nil {
		t.Fatalf("SetMeta 失败: %v", err)
	}

	obj := fake.get("buck1", "m.txt")
	if obj.contentType != "application/json" {
		t.Errorf("ContentType 应被替换为 application/json, got %q", obj.contentType)
	}
	if obj.cacheControl != "max-age=600" {
		t.Errorf("CacheControl 应被替换为 max-age=600, got %q", obj.cacheControl)
	}
	if obj.userMeta["owner"] != "bob" {
		t.Errorf("UserMetadata 应被替换为 owner=bob, got %q", obj.userMeta["owner"])
	}
	// 内容不应被改动
	if string(obj.data) != "content" {
		t.Errorf("内容不应被改动, got %q", string(obj.data))
	}
}

// TestS3Driver_SetMetaKeepsUnchangedFields patch 中未指定的项应保留原值。
func TestS3Driver_SetMetaKeepsUnchangedFields(t *testing.T) {
	d, fake := newTestS3Driver(t)
	fake.put("buck1", "m.txt", &fakeS3Object{
		data: []byte("content"), contentType: "text/plain",
		cacheControl: "max-age=60",
		disposition:  "attachment; filename=\"a.txt\"",
		userMeta:     map[string]string{"owner": "alice"},
		etag:         "e1", modTime: "2026-01-01T00:00:00Z",
	})

	// 只改 Content-Type
	if err := d.SetMeta("buck1", "m.txt", MetaPatch{ContentType: "text/markdown"}); err != nil {
		t.Fatalf("SetMeta 失败: %v", err)
	}
	obj := fake.get("buck1", "m.txt")
	if obj.contentType != "text/markdown" {
		t.Errorf("ContentType 应被改, got %q", obj.contentType)
	}
	if obj.cacheControl != "max-age=60" {
		t.Errorf("未指定的 CacheControl 应保留, got %q", obj.cacheControl)
	}
	if obj.disposition != "attachment; filename=\"a.txt\"" {
		t.Errorf("未指定的 Content-Disposition 应保留, got %q", obj.disposition)
	}
	if obj.userMeta["owner"] != "alice" {
		t.Errorf("UserMetadata 为 nil 时应保留原值, got %q", obj.userMeta["owner"])
	}
}

// TestS3Driver_CopyAcrossBuckets 跨桶复制：源桶与目标桶必须分离。
func TestS3Driver_CopyAcrossBuckets(t *testing.T) {
	d, fake := newTestS3Driver(t)
	fake.put("srcb", "a.txt", &fakeS3Object{
		data: []byte("data"), contentType: "text/plain",
		etag: "e1", modTime: "2026-01-01T00:00:00Z",
	})

	if err := d.CopyAcross("srcb", "dstb", "a.txt", "a.txt"); err != nil {
		t.Fatalf("跨桶复制失败: %v", err)
	}
	if fake.get("dstb", "a.txt") == nil {
		t.Fatalf("目标桶 dst 中应存在 a.txt")
	}
	if fake.get("srcb", "a.txt") == nil {
		t.Errorf("源对象不应被删除")
	}
}

// TestS3Driver_MoveAcrossBuckets 跨桶移动应删源。
func TestS3Driver_MoveAcrossBuckets(t *testing.T) {
	d, fake := newTestS3Driver(t)
	fake.put("srcb", "a.txt", &fakeS3Object{
		data: []byte("data"), contentType: "text/plain",
		etag: "e1", modTime: "2026-01-01T00:00:00Z",
	})

	if err := d.MoveAcross("srcb", "dstb", "a.txt", "b.txt"); err != nil {
		t.Fatalf("跨桶移动失败: %v", err)
	}
	if fake.get("srcb", "a.txt") != nil {
		t.Errorf("源对象应被删除")
	}
	if fake.get("dstb", "b.txt") == nil {
		t.Errorf("目标对象应存在")
	}
}

// TestS3Driver_TagsRoundTrip 标签读写往返。
func TestS3Driver_TagsRoundTrip(t *testing.T) {
	d, fake := newTestS3Driver(t)
	fake.put("buck1", "t.txt", &fakeS3Object{
		data: []byte("x"), contentType: "text/plain",
		etag: "e1", modTime: "2026-01-01T00:00:00Z",
	})

	if err := d.SetTags("buck1", "t.txt", map[string]string{"env": "prod", "team": "core"}); err != nil {
		t.Fatalf("SetTags 失败: %v", err)
	}
	got, err := d.GetTags("buck1", "t.txt")
	if err != nil {
		t.Fatalf("GetTags 失败: %v", err)
	}
	if got["env"] != "prod" {
		t.Errorf("标签 env 应为 prod, got %q", got["env"])
	}
	if got["team"] != "core" {
		t.Errorf("标签 team 应为 core, got %q", got["team"])
	}
}

// TestS3Driver_PutWithStorageClass 上传时指定存储类别。
func TestS3Driver_PutWithStorageClass(t *testing.T) {
	d, fake := newTestS3Driver(t)

	err := d.PutWithClass("buck1", "arc.txt", bytes.NewReader([]byte("data")), 4, "text/plain", StorageClassArchive)
	if err != nil {
		t.Fatalf("PutWithClass 失败: %v", err)
	}
	obj := fake.get("buck1", "arc.txt")
	if obj == nil {
		t.Fatalf("对象应存在")
	}
	if obj.storageClass != "GLACIER" {
		t.Errorf("存储类别应为 GLACIER（归档层的 S3 枚举）, got %q", obj.storageClass)
	}
}

// TestS3Driver_ListObjects 分页列举（含目录折叠）。
func TestS3Driver_ListObjects(t *testing.T) {
	d, fake := newTestS3Driver(t)
	fake.put("buck1", "a/1.txt", &fakeS3Object{data: []byte("1"), etag: "e1", modTime: "2026-01-01T00:00:00Z"})
	fake.put("buck1", "a/b/2.txt", &fakeS3Object{data: []byte("22"), etag: "e2", modTime: "2026-01-01T00:00:00Z"})
	fake.put("buck1", "c.txt", &fakeS3Object{data: []byte("333"), etag: "e3", modTime: "2026-01-01T00:00:00Z"})

	page, err := d.ListObjects(ListReq{Bucket: "buck1", Prefix: "", Delimiter: "/", MaxKeys: 100})
	if err != nil {
		t.Fatalf("ListObjects 失败: %v", err)
	}
	// 期望：目录 a/ + 文件 c.txt
	if len(page.Items) != 2 {
		t.Fatalf("应返回 2 项（目录 a/ + 文件 c.txt）, got %d: %+v", len(page.Items), page.Items)
	}
	dirFound := false
	fileFound := false
	for _, it := range page.Items {
		if it.IsDir && it.Name == "a/" {
			dirFound = true
		}
		if !it.IsDir && it.Name == "c.txt" {
			fileFound = true
		}
	}
	if !dirFound {
		t.Errorf("应折叠出目录 a/")
	}
	if !fileFound {
		t.Errorf("应返回文件 c.txt")
	}
}

// TestS3Driver_DeleteAndPrefixDelete 删除与递归删除。
func TestS3Driver_DeleteAndPrefixDelete(t *testing.T) {
	d, fake := newTestS3Driver(t)
	fake.put("buck1", "x/1.txt", &fakeS3Object{data: []byte("1"), etag: "e1", modTime: "2026-01-01T00:00:00Z"})
	fake.put("buck1", "x/2.txt", &fakeS3Object{data: []byte("2"), etag: "e2", modTime: "2026-01-01T00:00:00Z"})
	fake.put("buck1", "y.txt", &fakeS3Object{data: []byte("y"), etag: "e3", modTime: "2026-01-01T00:00:00Z"})

	if err := d.Delete("buck1", "y.txt"); err != nil {
		t.Fatalf("Delete 失败: %v", err)
	}
	if fake.get("buck1", "y.txt") != nil {
		t.Errorf("y.txt 应被删除")
	}

	n, err := d.DeletePrefix("buck1", "x/")
	if err != nil {
		t.Fatalf("DeletePrefix 失败: %v", err)
	}
	if n != 2 {
		t.Errorf("应删除 2 个对象, got %d", n)
	}
	if fake.get("buck1", "x/1.txt") != nil || fake.get("buck1", "x/2.txt") != nil {
		t.Errorf("x/ 下的对象应被清空")
	}
}

// TestS3Driver_PutFromFile 本地文件流式上传。
func TestS3Driver_PutFromFile(t *testing.T) {
	d, fake := newTestS3Driver(t)
	dir := t.TempDir()
	p := filepath.Join(dir, "up.txt")
	if err := os.WriteFile(p, []byte("file-content"), 0o644); err != nil {
		t.Fatalf("写临时文件失败: %v", err)
	}

	if err := d.PutFromFile("buck1", "up.txt", p, "text/plain"); err != nil {
		t.Fatalf("PutFromFile 失败: %v", err)
	}
	obj := fake.get("buck1", "up.txt")
	if obj == nil {
		t.Fatalf("对象应存在")
	}
	if string(obj.data) != "file-content" {
		t.Errorf("内容应为 file-content, got %q", string(obj.data))
	}
	if obj.contentType != "text/plain" {
		t.Errorf("ContentType 应为 text/plain, got %q", obj.contentType)
	}
}

// TestS3Driver_CopyPrefixAcross 跨桶递归复制目录（不删源）。
func TestS3Driver_CopyPrefixAcross(t *testing.T) {
	d, fake := newTestS3Driver(t)
	fake.put("srcb", "dir/1.txt", &fakeS3Object{data: []byte("1"), etag: "e1", modTime: "2026-01-01T00:00:00Z"})
	fake.put("srcb", "dir/sub/2.txt", &fakeS3Object{data: []byte("22"), etag: "e2", modTime: "2026-01-01T00:00:00Z"})

	n, err := d.CopyPrefixAcross("srcb", "dstb", "dir/", "moved/")
	if err != nil {
		t.Fatalf("CopyPrefixAcross 失败: %v", err)
	}
	if n != 2 {
		t.Errorf("应复制 2 个对象, got %d", n)
	}
	if fake.get("dstb", "moved/1.txt") == nil {
		t.Errorf("dst/moved/1.txt 应存在")
	}
	if fake.get("dstb", "moved/sub/2.txt") == nil {
		t.Errorf("dst/moved/sub/2.txt 应存在（子层级应保留）")
	}
	// 源不应被删除（这是 copy 不是 move）
	if fake.get("srcb", "dir/1.txt") == nil {
		t.Errorf("复制不应删除源对象")
	}
}

// deletedXMLKeys 把已删除的 key 拼成 XML 片段（每个 key 一个 <Deleted> 元素）。
func deletedXMLKeys(keys []string) string {
	out := ""
	for _, k := range keys {
		out += "<Deleted><Key>" + xmlEscape(k) + "</Key></Deleted>"
	}
	return out
}

// xmlEscape 转义 XML 特殊字符。
func xmlEscape(s string) string {
	var buf bytes.Buffer
	xml.EscapeText(&buf, []byte(s))
	return buf.String()
}
