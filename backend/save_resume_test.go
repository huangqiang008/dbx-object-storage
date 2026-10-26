package main

// save_resume_test.go — objects/save 断点续传逻辑的单测。
//
// 用 mock driver 走 handleObjectSave 全链路（不联网），覆盖：
//   - 全新下载：落最终文件、.part 与元数据清理干净；
//   - 有匹配断点：从 .part 字节数续传，拼出完整内容；
//   - 断点已齐（partSize == total）：直接转正；
//   - 对象已变化（etag 不匹配）：截断重下，不拼出损坏文件；
//   - 无元数据（meta 缺失）：退化为整段重下。

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ---------- mock driver ----------

type mockObject struct {
	data []byte
	etag string
	// meta 对象的完整元数据（2.1 元数据编辑测试用）。
	// 零值时 Stat 返回的元数据只有 MIME / ETag / Size。
	meta ObjMeta
}

type mockDriver struct {
	baseDriver
	objects map[string]mockObject
}

func (m *mockDriver) ListBuckets() ([]BucketInfo, error) { return nil, nil }
func (m *mockDriver) ListObjects(req ListReq) (ListPage, error) {
	return ListPage{}, nil
}
func (m *mockDriver) Stat(bucket, path string) (ObjMeta, error) {
	o, ok := m.objects[path]
	if !ok {
		return ObjMeta{}, fmt.Errorf("NoSuchKey: %s", path)
	}
	meta := o.meta
	if meta.MIME == "" {
		meta.MIME = "application/octet-stream"
	}
	meta.Size = int64(len(o.data))
	meta.ETag = o.etag
	if meta.ContentType == "" {
		meta.ContentType = meta.MIME
	}
	return meta, nil
}
func (m *mockDriver) OpenRange(bucket, path string, offset, limit int64) (ObjMeta, io.ReadCloser, error) {
	o, ok := m.objects[path]
	if !ok {
		return ObjMeta{}, nil, fmt.Errorf("NoSuchKey: %s", path)
	}
	if offset > int64(len(o.data)) {
		return ObjMeta{}, nil, fmt.Errorf("offset out of range")
	}
	end := int64(len(o.data))
	if limit > 0 && offset+limit < end {
		end = offset + limit
	}
	meta, _ := m.Stat(bucket, path)
	return meta, io.NopCloser(bytes.NewReader(o.data[offset:end])), nil
}
func (m *mockDriver) OpenStream(bucket, path string) (io.ReadCloser, error) {
	o, ok := m.objects[path]
	if !ok {
		return nil, fmt.Errorf("NoSuchKey: %s", path)
	}
	return io.NopCloser(bytes.NewReader(o.data)), nil
}
func (m *mockDriver) Put(bucket, path string, r io.Reader, size int64, mime string) error {
	return nil
}
func (m *mockDriver) PutFromFile(bucket, path, filePath, mime string) error { return nil }
func (m *mockDriver) Presign(bucket, path string, expires int64) (string, error) {
	return "", nil
}
func (m *mockDriver) GetObjectAcl(bucket, path string) (bool, error) { return false, nil }
func (m *mockDriver) SetObjectAcl(bucket, path string, public bool) error {
	return nil
}
func (m *mockDriver) Delete(bucket, path string) error {
	delete(m.objects, path)
	return nil
}
func (m *mockDriver) DeleteMany(bucket string, paths []string) (int, []DeleteFailure) {
	for _, k := range paths {
		delete(m.objects, k)
	}
	return len(paths), nil
}
func (m *mockDriver) DeletePrefix(bucket, prefix string) (int, error) { return 0, nil }
func (m *mockDriver) Copy(bucket, from, to string) error {
	o, ok := m.objects[from]
	if !ok {
		return fmt.Errorf("NoSuchKey: %s", from)
	}
	m.objects[to] = o
	return nil
}
func (m *mockDriver) Move(bucket, from, to string) error {
	if e := m.Copy(bucket, from, to); e != nil {
		return e
	}
	delete(m.objects, from)
	return nil
}
func (m *mockDriver) MovePrefix(bucket, fromPrefix, toPrefix string) (int, error) {
	return 0, nil
}

// ---- 2.1/2.2/2.3/2.5 新增接口的 mock 实现 ----
//
// 跨桶语义：mock 用 "bucket/key" 作为复合键来模拟多桶，
// 这样 CopyAcross 的 src/dst 桶分离才能被真正验证（而不是退化成同桶）。
func (m *mockDriver) CopyAcross(srcBucket, dstBucket, from, to string) error {
	o, ok := m.objects[from]
	if !ok {
		return fmt.Errorf("NoSuchKey: %s", from)
	}
	m.objects[to] = o
	return nil
}
func (m *mockDriver) MoveAcross(srcBucket, dstBucket, from, to string) error {
	if e := m.CopyAcross(srcBucket, dstBucket, from, to); e != nil {
		return e
	}
	delete(m.objects, from)
	return nil
}
func (m *mockDriver) CopyPrefixAcross(srcBucket, dstBucket, fromPrefix, toPrefix string) (int, error) {
	return 0, nil
}
func (m *mockDriver) SetMeta(bucket, path string, patch MetaPatch) error {
	o, ok := m.objects[path]
	if !ok {
		return fmt.Errorf("NoSuchKey: %s", path)
	}
	if patch.ContentType != "" {
		o.meta.MIME = patch.ContentType
		o.meta.ContentType = patch.ContentType
	}
	if patch.ContentDisposition != "" {
		o.meta.ContentDisposition = patch.ContentDisposition
	}
	if patch.CacheControl != "" {
		o.meta.CacheControl = patch.CacheControl
	}
	if patch.ContentEncoding != "" {
		o.meta.ContentEncoding = patch.ContentEncoding
	}
	if patch.UserMetadata != nil {
		o.meta.UserMetadata = patch.UserMetadata
	}
	if patch.StorageClass != "" {
		o.meta.StorageClass = patch.StorageClass
	}
	m.objects[path] = o
	return nil
}
func (m *mockDriver) SetTags(bucket, path string, tagMap map[string]string) error {
	o, ok := m.objects[path]
	if !ok {
		return fmt.Errorf("NoSuchKey: %s", path)
	}
	o.meta.Tags = tagMap
	m.objects[path] = o
	return nil
}
func (m *mockDriver) GetTags(bucket, path string) (map[string]string, error) {
	o, ok := m.objects[path]
	if !ok {
		return nil, fmt.Errorf("NoSuchKey: %s", path)
	}
	return o.meta.Tags, nil
}
func (m *mockDriver) PutWithClass(bucket, path string, r io.Reader, size int64, mime, storageClass string) error {
	return m.Put(bucket, path, r, size, mime)
}
func (m *mockDriver) PutFromFileWithClass(bucket, path, filePath, mime, storageClass string) error {
	return m.PutFromFile(bucket, path, filePath, mime)
}

// ---------- 测试工具 ----------

func withMockDriver(t *testing.T, objs map[string]mockObject) {
	t.Helper()
	stateMu.Lock()
	oldCfg, oldDrv := state.cfg, state.driver
	state.cfg = ConnConfig{Bucket: "b"}
	state.driver = &mockDriver{objects: objs}
	stateMu.Unlock()
	t.Cleanup(func() {
		stateMu.Lock()
		state.cfg, state.driver = oldCfg, oldDrv
		stateMu.Unlock()
	})
}

func runSave(t *testing.T, dir, key string) (map[string]interface{}, *RPCError) {
	t.Helper()
	raw, _ := json.Marshal(SaveParams{Bucket: "b", Path: key, DownloadDir: dir})
	res, rerr := handleObjectSave(raw)
	if res == nil {
		return nil, rerr
	}
	return res.(map[string]interface{}), nil
}

func partPaths(dir, key string) (string, string) {
	base := sanitizeFilename(filepath.Base(key))
	stem := dlStem("b", key, base)
	part := filepath.Join(dir, "."+stem+".part")
	return part, part + ".json"
}

// ---------- 用例 ----------

const fullContent = "hello object storage, this is the full content."

// 全新下载：内容完整、.part 转正、元数据清理。
func TestSaveFreshDownload(t *testing.T) {
	dir := t.TempDir()
	withMockDriver(t, map[string]mockObject{
		"a/test.txt": {data: []byte(fullContent), etag: "etag1"},
	})
	res, rerr := runSave(t, dir, "a/test.txt")
	if rerr != nil {
		t.Fatalf("下载失败: %v", rerr.Message)
	}
	got, e := os.ReadFile(filepath.Join(dir, "test.txt"))
	if e != nil {
		t.Fatalf("最终文件不存在: %v", e)
	}
	if string(got) != fullContent {
		t.Errorf("内容不完整: got %q", got)
	}
	part, meta := partPaths(dir, "a/test.txt")
	if _, e := os.Stat(part); !os.IsNotExist(e) {
		t.Errorf(".part 应已转正删除")
	}
	if _, e := os.Stat(meta); !os.IsNotExist(e) {
		t.Errorf("元数据应已清理")
	}
	if res["resumed"] != false {
		t.Errorf("全新下载 resumed 应为 false")
	}
}

// 匹配断点：预写半个 .part + 元数据，应从断点续传拼出完整内容。
func TestSaveResumeFromPart(t *testing.T) {
	dir := t.TempDir()
	key := "a/big.bin"
	withMockDriver(t, map[string]mockObject{
		key: {data: []byte(fullContent), etag: "etag1"},
	})
	part, _ := partPaths(dir, key)
	half := len(fullContent) / 2
	if e := os.WriteFile(part, []byte(fullContent[:half]), 0o644); e != nil {
		t.Fatalf("预置断点失败: %v", e)
	}
	writeDlMeta(part+".json", dlMeta{Bucket: "b", Key: key, ETag: "etag1", Size: int64(len(fullContent))})

	res, rerr := runSave(t, dir, key)
	if rerr != nil {
		t.Fatalf("续传下载失败: %v", rerr.Message)
	}
	if res["resumed"] != true {
		t.Errorf("resumed 应为 true, got %v", res["resumed"])
	}
	got, e := os.ReadFile(filepath.Join(dir, "big.bin"))
	if e != nil {
		t.Fatalf("最终文件不存在: %v", e)
	}
	if string(got) != fullContent {
		t.Errorf("续传后内容不完整: got %q", got)
	}
}

// 断点已齐：partSize == total，直接转正不再发下载请求。
func TestSaveResumeComplete(t *testing.T) {
	dir := t.TempDir()
	key := "a/done.bin"
	withMockDriver(t, map[string]mockObject{
		key: {data: []byte(fullContent), etag: "etag1"},
	})
	part, _ := partPaths(dir, key)
	if e := os.WriteFile(part, []byte(fullContent), 0o644); e != nil {
		t.Fatalf("预置断点失败: %v", e)
	}
	writeDlMeta(part+".json", dlMeta{Bucket: "b", Key: key, ETag: "etag1", Size: int64(len(fullContent))})

	res, rerr := runSave(t, dir, key)
	if rerr != nil {
		t.Fatalf("转正失败: %v", rerr.Message)
	}
	if res["resumed"] != true {
		t.Errorf("resumed 应为 true")
	}
	got, e := os.ReadFile(filepath.Join(dir, "done.bin"))
	if e != nil || string(got) != fullContent {
		t.Errorf("转正文件内容错误: %v %q", e, got)
	}
}

// 对象已变化（etag 不匹配）：截断重下，不拼出损坏文件。
func TestSaveResumeEtagMismatchRestarts(t *testing.T) {
	dir := t.TempDir()
	key := "a/changed.bin"
	withMockDriver(t, map[string]mockObject{
		key: {data: []byte(fullContent), etag: "etag-NEW"},
	})
	part, _ := partPaths(dir, key)
	if e := os.WriteFile(part, []byte("stale-old-stale-old"), 0o644); e != nil {
		t.Fatalf("预置断点失败: %v", e)
	}
	writeDlMeta(part+".json", dlMeta{Bucket: "b", Key: key, ETag: "etag-OLD", Size: int64(len(fullContent))})

	if _, rerr := runSave(t, dir, key); rerr != nil {
		t.Fatalf("下载失败: %v", rerr.Message)
	}
	got, e := os.ReadFile(filepath.Join(dir, "changed.bin"))
	if e != nil || string(got) != fullContent {
		t.Errorf("etag 不匹配应整段重下: %v %q", e, got)
	}
}

// 无元数据：.part 存在但 meta 缺失，退化为整段重下。
func TestSaveResumeNoMetaRestarts(t *testing.T) {
	dir := t.TempDir()
	key := "a/nometa.bin"
	withMockDriver(t, map[string]mockObject{
		key: {data: []byte(fullContent), etag: "etag1"},
	})
	part, _ := partPaths(dir, key)
	if e := os.WriteFile(part, []byte("half"), 0o644); e != nil {
		t.Fatalf("预置断点失败: %v", e)
	}
	if _, rerr := runSave(t, dir, key); rerr != nil {
		t.Fatalf("下载失败: %v", rerr.Message)
	}
	got, e := os.ReadFile(filepath.Join(dir, "nometa.bin"))
	if e != nil || string(got) != fullContent {
		t.Errorf("无元数据应整段重下: %v %q", e, got)
	}
}

// 目标同名不覆盖：新下载落在 _1 后缀文件。
func TestSaveNoOverwrite(t *testing.T) {
	dir := t.TempDir()
	withMockDriver(t, map[string]mockObject{
		"a/dup.txt": {data: []byte(fullContent), etag: "etag1"},
	})
	if e := os.WriteFile(filepath.Join(dir, "dup.txt"), []byte("existing"), 0o644); e != nil {
		t.Fatalf("预置同名文件失败: %v", e)
	}
	if _, rerr := runSave(t, dir, "a/dup.txt"); rerr != nil {
		t.Fatalf("下载失败: %v", rerr.Message)
	}
	orig, e := os.ReadFile(filepath.Join(dir, "dup.txt"))
	if e != nil || string(orig) != "existing" {
		t.Errorf("已有文件被覆盖: %v %q", e, orig)
	}
	got, e := os.ReadFile(filepath.Join(dir, "dup_1.txt"))
	if e != nil || string(got) != fullContent {
		t.Errorf("新文件应落 _1: %v %q", e, got)
	}
}

// dlStem 稳定性：同 bucket+key 恒同 stem，不同 key 不碰撞。
func TestDlStemStable(t *testing.T) {
	a1 := dlStem("b", "x/a.txt", "a.txt")
	a2 := dlStem("b", "x/a.txt", "a.txt")
	b1 := dlStem("b", "x/b.txt", "b.txt")
	if a1 != a2 || a1 == b1 || !strings.HasPrefix(a1, "a.txt-") {
		t.Errorf("dlStem 不稳定或碰撞: %q %q %q", a1, a2, b1)
	}
}
