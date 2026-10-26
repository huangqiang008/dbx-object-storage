package main

// feature_test.go — 第一批 + 第二批新功能的单测。
//
// 覆盖：
//   - 1.1 下载保留目录层级：相对路径解析（含路径逃逸防护）、落盘保层级
//   - 2.1 元数据编辑：patch 语义（空=不改、nil=不动已有 meta）
//   - 2.2 跨桶复制：源/目标桶分离
//   - 2.4 STS 临时凭证：parseConn 解析 session_token
//   - 2.5 存储类别：归一化映射

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ---------- 1.1 相对路径解析 ----------

func TestResolveRelPath_RejectsEscape(t *testing.T) {
	cases := []struct {
		name string
		in   string
	}{
		{"绝对路径", "/etc/passwd"},
		{"Windows 盘符", "C:/Windows/system32"},
		{"父目录", "../outside.txt"},
		{"中间父目录", "a/../../b.txt"},
		{"反斜杠绝对路径", "\\Windows\\system32"},
	}
	for _, c := range cases {
		if _, _, err := resolveRelPath("/tmp", c.in); err == nil {
			t.Errorf("%s (%q) 应被拒绝", c.name, c.in)
		}
	}
}

func TestResolveRelPath_SplitsDirAndFile(t *testing.T) {
	sub, file, err := resolveRelPath("/tmp", "a/b/c.txt")
	if err != nil {
		t.Fatalf("不应报错: %v", err)
	}
	if file != "c.txt" {
		t.Errorf("文件名应为 c.txt, got %q", file)
	}
	want := filepath.Join("a", "b")
	if sub != want {
		t.Errorf("子目录应为 %q, got %q", want, sub)
	}
}

func TestResolveRelPath_SanitizesEachSegment(t *testing.T) {
	// 非法字符逐段净化，而不是整串替换（整串替换会把 / 也换掉）
	sub, file, err := resolveRelPath("/tmp", "a:b/c?d.txt")
	if err != nil {
		t.Fatalf("不应报错: %v", err)
	}
	if strings.ContainsAny(file, "?") {
		t.Errorf("文件名应净化掉 ?, got %q", file)
	}
	if strings.ContainsAny(sub, "?") {
		t.Errorf("子目录应净化掉 ?, got %q", sub)
	}
}

func TestResolveRelPath_EmptyReturnsEmpty(t *testing.T) {
	sub, file, err := resolveRelPath("/tmp", "")
	if err != nil || sub != "" || file != "" {
		t.Errorf("空相对路径应返回空子目录与空文件名, got %q %q %v", sub, file, err)
	}
}

// TestSavePreservesRelativePath 批量下载时应按相对路径落盘并建子目录。
func TestSavePreservesRelativePath(t *testing.T) {
	dir := t.TempDir()
	objs := map[string]mockObject{
		"a/b/c.txt": {data: []byte("hello"), etag: "e1"},
	}
	withMockDriver(t, objs)

	raw, _ := json.Marshal(SaveParams{
		Bucket: "b", Path: "a/b/c.txt", DownloadDir: dir,
		RelPath: "a/b/c.txt",
	})
	res, rerr := handleObjectSave(raw)
	if rerr != nil {
		t.Fatalf("下载失败: %v", rerr.Message)
	}
	_ = res

	// 层级应被保留：<dir>/a/b/c.txt
	target := filepath.Join(dir, "a", "b", "c.txt")
	bb, e := os.ReadFile(target)
	if e != nil {
		t.Fatalf("应落盘到 %s: %v", target, e)
	}
	if string(bb) != "hello" {
		t.Errorf("内容应为 hello, got %q", string(bb))
	}
}

// TestSaveFlatWhenNoRelPath 未传相对路径时应保持旧的拍平行为。
func TestSaveFlatWhenNoRelPath(t *testing.T) {
	dir := t.TempDir()
	objs := map[string]mockObject{
		"a/b/c.txt": {data: []byte("hello"), etag: "e1"},
	}
	withMockDriver(t, objs)

	raw, _ := json.Marshal(SaveParams{
		Bucket: "b", Path: "a/b/c.txt", DownloadDir: dir,
	})
	_, rerr := handleObjectSave(raw)
	if rerr != nil {
		t.Fatalf("下载失败: %v", rerr.Message)
	}
	// 应落盘为 <dir>/c.txt（无子目录）
	if _, e := os.Stat(filepath.Join(dir, "c.txt")); e != nil {
		t.Fatalf("应拍平落盘到 c.txt: %v", e)
	}
	if _, e := os.Stat(filepath.Join(dir, "a")); e == nil {
		t.Errorf("未传 relPath 时不应创建子目录 a")
	}
}

// TestSaveRejectsEscapingRelPath 相对路径逃逸必须被拒绝（不能写到目录外）。
func TestSaveRejectsEscapingRelPath(t *testing.T) {
	dir := t.TempDir()
	outside := filepath.Join(filepath.Dir(dir), "evil.txt")
	objs := map[string]mockObject{
		"p": {data: []byte("x"), etag: "e1"},
	}
	withMockDriver(t, objs)

	raw, _ := json.Marshal(SaveParams{
		Bucket: "b", Path: "p", DownloadDir: dir,
		RelPath: "../" + filepath.Base(outside),
	})
	_, rerr := handleObjectSave(raw)
	if rerr == nil {
		t.Fatalf("逃逸的相对路径应被拒绝")
	}
	if _, e := os.Stat(outside); e == nil {
		t.Errorf("不应在目录外创建文件")
	}
}

// ---------- 上传会话 release（取消场景保留分片） ----------

// TestUploadRelease_KeepsPartFile release 应保留磁盘上的分片文件，
// 只释放内存会话——否则用户取消后重传无法从断点继续。
func TestUploadRelease_KeepsPartFile(t *testing.T) {
	// 直接构造会话，走 handleUploadRelease
	dir := t.TempDir()
	partPath := filepath.Join(dir, "dbx-up-test.part")
	metaPath := filepath.Join(dir, "dbx-up-test.meta")
	if err := os.WriteFile(partPath, []byte("partial"), 0o600); err != nil {
		t.Fatalf("写分片失败: %v", err)
	}
	if err := os.WriteFile(metaPath, []byte(`{"bucket":"b","key":"k","size":7}`), 0o600); err != nil {
		t.Fatalf("写元数据失败: %v", err)
	}
	f, err := os.OpenFile(partPath, os.O_RDWR|os.O_APPEND, 0o600)
	if err != nil {
		t.Fatalf("打开分片失败: %v", err)
	}
	sess := &uploadSession{
		id: "sess-1", file: f, tmpPath: partPath, metaPath: metaPath,
		bucket: "b", key: "k", size: 7, written: 7,
	}
	uploadsMu.Lock()
	uploads["sess-1"] = sess
	uploadsMu.Unlock()

	raw, _ := json.Marshal(map[string]string{"uploadId": "sess-1"})
	_, rerr := handleUploadRelease(raw)
	if rerr != nil {
		t.Fatalf("release 失败: %v", rerr.Message)
	}

	// 会话应从内存 map 摘除
	uploadsMu.Lock()
	_, stillThere := uploads["sess-1"]
	uploadsMu.Unlock()
	if stillThere {
		t.Errorf("release 后会话应从内存 map 移除")
	}
	// 分片与元数据应保留
	if _, e := os.Stat(partPath); e != nil {
		t.Errorf("release 后分片文件应保留: %v", e)
	}
	if _, e := os.Stat(metaPath); e != nil {
		t.Errorf("release 后元数据应保留: %v", e)
	}
	// 文件句柄应已关闭（Windows 上删不掉就是没关）
	f.Close() // 幂等：若 release 已关闭，这里是重复 close（忽略错误）
}

// TestUploadAbort_RemovesPartFile abort 应删掉分片与元数据（失败场景）。
func TestUploadAbort_RemovesPartFile(t *testing.T) {
	dir := t.TempDir()
	partPath := filepath.Join(dir, "dbx-up-test2.part")
	metaPath := filepath.Join(dir, "dbx-up-test2.meta")
	os.WriteFile(partPath, []byte("partial"), 0o600)
	os.WriteFile(metaPath, []byte(`{"bucket":"b","key":"k","size":7}`), 0o600)
	f, _ := os.OpenFile(partPath, os.O_RDWR|os.O_APPEND, 0o600)
	sess := &uploadSession{
		id: "sess-2", file: f, tmpPath: partPath, metaPath: metaPath,
		bucket: "b", key: "k", size: 7, written: 7,
	}
	uploadsMu.Lock()
	uploads["sess-2"] = sess
	uploadsMu.Unlock()

	raw, _ := json.Marshal(map[string]string{"uploadId": "sess-2"})
	_, rerr := handleUploadAbort(raw)
	if rerr != nil {
		t.Fatalf("abort 失败: %v", rerr.Message)
	}
	if _, e := os.Stat(partPath); e == nil {
		t.Errorf("abort 后分片文件应被删除")
	}
	if _, e := os.Stat(metaPath); e == nil {
		t.Errorf("abort 后元数据应被删除")
	}
}

// ---------- 2.1 元数据编辑 ----------

// TestSetMetaPatch_EmptyMeansNoChange patch 中空字段 = 不改该项。
func TestSetMetaPatch_EmptyMeansNoChange(t *testing.T) {
	objs := map[string]mockObject{
		"p.txt": {
			data: []byte("x"), etag: "e1",
			meta: ObjMeta{
				MIME:               "text/plain",
				ContentType:        "text/plain",
				ContentDisposition: "attachment; filename=\"a.txt\"",
				CacheControl:       "max-age=100",
				UserMetadata:       map[string]string{"k": "v"},
			},
		},
	}
	withMockDriver(t, objs)

	// 只改 Content-Type，其余应保持不变
	err := state.driver.SetMeta("b", "p.txt", MetaPatch{ContentType: "text/markdown"})
	if err != nil {
		t.Fatalf("SetMeta 失败: %v", err)
	}
	m, _ := state.driver.Stat("b", "p.txt")
	if m.ContentType != "text/markdown" {
		t.Errorf("ContentType 应被改为 text/markdown, got %q", m.ContentType)
	}
	if m.ContentDisposition != "attachment; filename=\"a.txt\"" {
		t.Errorf("未指定的 ContentDisposition 不应被清空, got %q", m.ContentDisposition)
	}
	if m.CacheControl != "max-age=100" {
		t.Errorf("未指定的 CacheControl 不应被清空, got %q", m.CacheControl)
	}
	if m.UserMetadata["k"] != "v" {
		t.Errorf("UserMetadata 为 nil 时不应动已有 meta, got %v", m.UserMetadata)
	}
}

// TestSetMetaPatch_UserMetadataReplace 传非 nil map = 整体替换。
func TestSetMetaPatch_UserMetadataReplace(t *testing.T) {
	objs := map[string]mockObject{
		"p.txt": {
			data: []byte("x"), etag: "e1",
			meta: ObjMeta{UserMetadata: map[string]string{"old": "1"}},
		},
	}
	withMockDriver(t, objs)

	err := state.driver.SetMeta("b", "p.txt", MetaPatch{
		UserMetadata: map[string]string{"new": "2"},
	})
	if err != nil {
		t.Fatalf("SetMeta 失败: %v", err)
	}
	m, _ := state.driver.Stat("b", "p.txt")
	if m.UserMetadata["new"] != "2" {
		t.Errorf("新 meta 应生效, got %v", m.UserMetadata)
	}
	if _, ok := m.UserMetadata["old"]; ok {
		t.Errorf("整体替换应移除旧键, got %v", m.UserMetadata)
	}
}

// ---------- 2.2 跨桶复制 ----------

// TestCopyAcross_SeparatesBuckets 跨桶复制不应把源桶当成目标桶。
func TestCopyAcross_SeparatesBuckets(t *testing.T) {
	objs := map[string]mockObject{
		"src.txt": {data: []byte("data"), etag: "e1"},
	}
	withMockDriver(t, objs)

	if err := state.driver.CopyAcross("b1", "b2", "src.txt", "dst.txt"); err != nil {
		t.Fatalf("跨桶复制失败: %v", err)
	}
	if _, ok := objs["dst.txt"]; !ok {
		t.Errorf("目标对象应存在")
	}
	if _, ok := objs["src.txt"]; !ok {
		t.Errorf("复制不应删除源对象")
	}
}

// TestMoveAcross_DeletesSource 跨桶移动应删除源对象。
func TestMoveAcross_DeletesSource(t *testing.T) {
	objs := map[string]mockObject{
		"src.txt": {data: []byte("data"), etag: "e1"},
	}
	withMockDriver(t, objs)

	if err := state.driver.MoveAcross("b1", "b2", "src.txt", "dst.txt"); err != nil {
		t.Fatalf("跨桶移动失败: %v", err)
	}
	if _, ok := objs["src.txt"]; ok {
		t.Errorf("移动后源对象应被删除")
	}
	if _, ok := objs["dst.txt"]; !ok {
		t.Errorf("移动后目标对象应存在")
	}
}

// ---------- 2.4 STS 临时凭证 ----------

// TestParseConn_SessionTokenFlat 扁平直发形状应解析 sessionToken。
func TestParseConn_SessionTokenFlat(t *testing.T) {
	raw := json.RawMessage(`{"provider":"s3","endpoint":"https://e.com","accessKeyId":"AK","accessKeySecret":"SK","sessionToken":"TOKEN"}`)
	c, err := parseConn(raw)
	if err != nil {
		t.Fatalf("解析失败: %v", err.Message)
	}
	if c.SessionToken != "TOKEN" {
		t.Errorf("sessionToken 应为 TOKEN, got %q", c.SessionToken)
	}
}

// TestParseConn_SessionTokenHostShape 宿主形状应从 connection_secrets 读 session_token。
func TestParseConn_SessionTokenHostShape(t *testing.T) {
	raw := json.RawMessage(`{"connection":{"name":"n","external_config":{"provider":"aliyun","endpoint":"oss-cn-hangzhou.aliyuncs.com","access_key_id":"AK"},"connection_secrets":{"access_key_secret":"SK","session_token":"HOSTTOKEN"}}}`)
	c, err := parseConn(raw)
	if err != nil {
		t.Fatalf("解析失败: %v", err.Message)
	}
	if c.SessionToken != "HOSTTOKEN" {
		t.Errorf("session_token 应为 HOSTTOKEN, got %q", c.SessionToken)
	}
}

// TestParseConn_HostEnvelopeProvider issue #3 回归：宿主在顶层下发 provider 信封对象时，
// 不应污染驱动 provider；external_config.provider 必须生效，且 path_style 必须被解析。
func TestParseConn_HostEnvelopeProvider(t *testing.T) {
	raw := json.RawMessage(`{
		"provider": {"id":"com.object.browser.connection","databaseType":"oss"},
		"connection": {
			"name":"n",
			"external_config": {
				"provider":"s3",
				"endpoint":"https://s3.example.com",
				"access_key_id":"AK",
				"bucket":"example-bucket",
				"path_style":true
			},
			"connection_secrets": {"access_key_secret":"SK"}
		}
	}`)
	c, err := parseConn(raw)
	if err != nil {
		t.Fatalf("解析失败: %v", err.Message)
	}
	if c.Provider.String() != "s3" {
		t.Errorf("provider 应为 s3, got %q（信封污染未修复）", c.Provider.String())
	}
	if got := normalizeProvider(c.Provider.String()); got != ProviderS3 {
		t.Errorf("normalizeProvider 应为 s3, got %q", got)
	}
	if !c.PathStyle {
		t.Errorf("path_style 应为 true")
	}
	if c.Bucket != "example-bucket" {
		t.Errorf("bucket 应为 example-bucket, got %q", c.Bucket)
	}
}

// TestParseConn_NoSessionToken 空 token 时应保持为空（长期密钥路径不变）。
func TestParseConn_NoSessionToken(t *testing.T) {
	raw := json.RawMessage(`{"provider":"s3","endpoint":"https://e.com","accessKeyId":"AK","accessKeySecret":"SK"}`)
	c, err := parseConn(raw)
	if err != nil {
		t.Fatalf("解析失败: %v", err.Message)
	}
	if c.SessionToken != "" {
		t.Errorf("未传时 sessionToken 应为空, got %q", c.SessionToken)
	}
}

// TestParseConn_FlatProviderPreserved 扁平直发形状（插件自带表单）必须保留顶层 provider，
// 不应被宿主形状的 external_config 缺失逻辑清空。对齐外部贡献 PR 的覆盖。
func TestParseConn_FlatProviderPreserved(t *testing.T) {
	raw := json.RawMessage(`{
		"provider":"s3","accessKeyId":"AK","accessKeySecret":"SK",
		"endpoint":"https://s3.example.com","pathStyle":true,"bucket":"example-bucket"
	}`)
	c, err := parseConn(raw)
	if err != nil {
		t.Fatalf("解析失败: %v", err.Message)
	}
	if c.Provider.String() != ProviderS3 {
		t.Errorf("扁平形状 provider 应为 s3, got %q", c.Provider.String())
	}
	if !c.PathStyle {
		t.Errorf("扁平形状 pathStyle 应保留")
	}
	if c.Bucket != "example-bucket" {
		t.Errorf("扁平形状 bucket 应为 example-bucket, got %q", c.Bucket)
	}
}

// TestParseConn_TLSFields issue #5 回归：skip_verify_tls / ca_cert 应从 external_config 与扁平形状解析。
func TestParseConn_TLSFields(t *testing.T) {
	// 宿主形状：external_config 走蛇形键。
	raw := json.RawMessage(`{
		"provider":"s3","connection":{
			"external_config":{
				"endpoint":"https://self.signed","access_key_id":"AK","path_style":true,
				"skip_verify_tls":true,"ca_cert":"-----BEGIN CERTIFICATE-----FAKE-----END CERTIFICATE-----"
			},
			"connection_secrets":{"access_key_secret":"SK"}
		}
	}`)
	c, err := parseConn(raw)
	if err != nil {
		t.Fatalf("解析失败: %v", err.Message)
	}
	if !c.SkipVerifyTLS {
		t.Errorf("skip_verify_tls 应为 true")
	}
	if c.CACert == "" {
		t.Errorf("ca_cert 应被解析")
	}

	// 扁平形状也兼容蛇形键。
	flat := json.RawMessage(`{"provider":"s3","endpoint":"https://e.com","accessKeyId":"AK","accessKeySecret":"SK","skip_verify_tls":true,"ca_cert":"PEM"}`)
	c2, err := parseConn(flat)
	if err != nil {
		t.Fatalf("扁平解析失败: %v", err.Message)
	}
	if !c2.SkipVerifyTLS || c2.CACert != "PEM" {
		t.Errorf("扁平形状未解析 TLS 字段: skip=%v ca=%q", c2.SkipVerifyTLS, c2.CACert)
	}
}

// TestBuildTransport 验证传输层构造的三种分支。
func TestBuildTransport(t *testing.T) {
	// 1) 未配置 → nil，调用方沿用 SDK 默认传输。
	if tr := buildTransport(ConnConfig{}); tr != nil {
		t.Errorf("未配置时应返回 nil, got %#v", tr)
	}
	// 2) 仅跳过校验 → 开启 InsecureSkipVerify，且保留系统根证书池。
	tr2 := buildTransport(ConnConfig{SkipVerifyTLS: true})
	if tr2 == nil || !tr2.TLSClientConfig.InsecureSkipVerify {
		t.Errorf("仅 skip 时 InsecureSkipVerify 应为 true")
	}
	if tr2 != nil && tr2.TLSClientConfig.RootCAs == nil {
		t.Errorf("应保留系统根证书池（RootCAs 非 nil）")
	}
	// 3) 设了自定义 CA → 仍做校验（InsecureSkipVerify=false），RootCAs 非 nil。
	tr3 := buildTransport(ConnConfig{CACert: "-----BEGIN CERTIFICATE-----FAKE-----END CERTIFICATE-----"})
	if tr3 == nil || tr3.TLSClientConfig.InsecureSkipVerify {
		t.Errorf("设 CA 后 InsecureSkipVerify 应为 false")
	}
	if tr3 != nil && tr3.TLSClientConfig.RootCAs == nil {
		t.Errorf("设 CA 后 RootCAs 应非 nil")
	}
	// 4) 同时设 CA 与 skip → CA 优先（仍校验）。
	tr4 := buildTransport(ConnConfig{CACert: "x", SkipVerifyTLS: true})
	if tr4 != nil && tr4.TLSClientConfig.InsecureSkipVerify {
		t.Errorf("同时设置时 CA 应优先，InsecureSkipVerify 应为 false")
	}
}


// ---------- 2.5 存储类别 ----------

func TestNormalizeStorageClass(t *testing.T) {
	cases := map[string]string{
		"standard":        StorageClassStandard,
		"STANDARD":        StorageClassStandard,
		"ia":              StorageClassIA,
		"STANDARD_IA":     StorageClassIA,
		"archive":         StorageClassArchive,
		"GLACIER":         StorageClassArchive,
		"deep_archive":    StorageClassArchive,
		"":                "",
		"not-a-class":     "",
		"unknown_storage": "",
	}
	for in, want := range cases {
		if got := normalizeStorageClass(in); got != want {
			t.Errorf("normalizeStorageClass(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestNormalizeStorageClass_RejectsUnknown 未知值应归一为空（由调用方决定报错）。
func TestNormalizeStorageClass_RejectsUnknown(t *testing.T) {
	if got := normalizeStorageClass("glacier-ir"); got != "" {
		t.Errorf("未知存储类别应归一为空, got %q", got)
	}
}

// TestMergeUserMetadata 空值 = 删除该键。
func TestMergeUserMetadata(t *testing.T) {
	out := MergeUserMetadata(
		map[string]string{"a": "1", "b": "2"},
		map[string]string{"b": "", "c": "3"},
	)
	if _, ok := out["b"]; ok {
		t.Errorf("空值应删除该键, got %v", out)
	}
	if out["a"] != "1" || out["c"] != "3" {
		t.Errorf("合并结果不对: %v", out)
	}
}
