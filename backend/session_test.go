package main

// session_test.go — 多连接会话隔离的回归测试。
//
// 复现的 bug（修复前）：Sidecar 跨标签页共享，连接状态是全局单例。
// 两个标签页分别连接 OSS-1 / OSS-2 后，后连接覆盖先连接——切回第一个
// 标签页操作时用的是第二个连接的凭证，轻则报错，重则写操作落到错误的
// 存储服务上。
//
// 修复后会话按 connectionId 隔离（session.go），本测试从 dispatch 入口
// 完整走一遍 RPC 路径验证隔离性：
//   - 两个连接并存，各自的读操作命中各自的服务端；
//   - 宿主 lifecycle 形状（connection.id）与前端扁平形状（connectionId）路由一致;
//   - disconnect 只拆除自己的会话；
//   - readOnly 是会话级属性，不跨连接串味。

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"testing"
)

// call 模拟主循环：构造 JSON-RPC 请求并走 dispatch（含 connectionId 解析）。
func call(t *testing.T, method string, params string) (interface{}, *RPCError) {
	t.Helper()
	result, rerr := dispatch(Request{
		JSONRPC: "2.0",
		ID:      json.RawMessage(`1`),
		Method:  method,
		Params:  json.RawMessage(params),
	})
	return result, rerr
}

// withTestSession 在 default 会话上安装指定 cfg/driver，并把 currentConn 指向它，
// 供直接调用 handler 的既有测试使用（等价于旧版直接改全局 state）。
// 测试结束自动清理。
func withTestSession(t *testing.T, cfg ConnConfig, driver StorageDriver) {
	t.Helper()
	putSession(defaultConnID, cfg, driver)
	currentConn = defaultConnID
	t.Cleanup(func() {
		dropSession(defaultConnID)
		currentConn = defaultConnID
	})
}

// newSessionTestS3 起一个内存 S3 服务，预置一个桶和一个对象。
func newSessionTestS3(t *testing.T, bucket, key, content string) string {
	t.Helper()
	fake := newFakeS3()
	fake.put(bucket, key, &fakeS3Object{
		data: []byte(content), contentType: "text/plain",
		etag: "e1", modTime: "2026-01-01T00:00:00Z",
	})
	srv := httptest.NewServer(fake)
	t.Cleanup(srv.Close)
	return srv.URL
}

// TestSession_TwoConnectionsDoNotOverride 核心回归：
// 标签页 A 连接服务 A，标签页 B 连接服务 B，切回 A 读取仍命中 A 的数据。
// 修复前：B 的 connect 覆盖全局单例，A 的 objects/read 打到服务 B → NoSuchKey 报错。
func TestSession_TwoConnectionsDoNotOverride(t *testing.T) {
	resetSessions()
	t.Cleanup(resetSessions)

	urlA := newSessionTestS3(t, "bucket-a", "a.txt", "content-from-A")
	urlB := newSessionTestS3(t, "bucket-b", "b.txt", "content-from-B")

	// 标签页 A 连接（前端扁平形状，OB.invoke 注入顶层 connectionId）
	if _, rerr := call(t, "connection/connect", `{
		"connectionId": "conn-A", "provider": "s3",
		"endpoint": "`+urlA+`", "accessKeyId": "AK-A", "accessKeySecret": "SK-A",
		"pathStyle": true
	}`); rerr != nil {
		t.Fatalf("连接 A 失败: %s", rerr.Message)
	}
	// 标签页 B 连接（宿主 lifecycle 形状，connection.id 作为会话 key）
	if _, rerr := call(t, "connection/connect", `{
		"connection": {
			"id": "conn-B",
			"external_config": {
				"provider": "s3", "endpoint": "`+urlB+`",
				"access_key_id": "AK-B", "path_style": true
			},
			"connection_secrets": { "access_key_secret": "SK-B" }
		}
	}`); rerr != nil {
		t.Fatalf("连接 B 失败: %s", rerr.Message)
	}

	// 两个会话并存
	if n := sessionCount(); n != 2 {
		t.Fatalf("应有 2 个并存会话, got %d", n)
	}

	// 切回标签页 A 读对象：必须命中服务 A（修复前这里会用 B 的驱动而失败）
	res, rerr := call(t, "objects/read", `{
		"connectionId": "conn-A", "bucket": "bucket-a", "path": "a.txt"
	}`)
	if rerr != nil {
		t.Fatalf("A 读取失败（会话被 B 覆盖？）: %s", rerr.Message)
	}
	content, _ := res.(map[string]interface{})["content"].(string)
	if got, _ := base64.StdEncoding.DecodeString(content); string(got) != "content-from-A" {
		t.Errorf("A 应读到自己的内容, got %q", string(got))
	}

	// 标签页 B 读对象：命中服务 B
	res, rerr = call(t, "objects/read", `{
		"connectionId": "conn-B", "bucket": "bucket-b", "path": "b.txt"
	}`)
	if rerr != nil {
		t.Fatalf("B 读取失败: %s", rerr.Message)
	}
	content, _ = res.(map[string]interface{})["content"].(string)
	if got, _ := base64.StdEncoding.DecodeString(content); string(got) != "content-from-B" {
		t.Errorf("B 应读到自己的内容, got %q", string(got))
	}

	// A 用 B 的桶名读取应失败（凭证/服务端隔离，不是碰巧同名桶都能读）
	if _, rerr := call(t, "objects/read", `{
		"connectionId": "conn-A", "bucket": "bucket-b", "path": "b.txt"
	}`); rerr == nil {
		t.Errorf("A 不应能读到 B 服务端的对象")
	}
}

// TestSession_StatusIsPerConnection connection/status 只报告本连接的状态，
// 不会把别的标签页的连接当作「自己已连接」。
func TestSession_StatusIsPerConnection(t *testing.T) {
	resetSessions()
	t.Cleanup(resetSessions)

	urlA := newSessionTestS3(t, "bucket-a", "a.txt", "x")
	if _, rerr := call(t, "connection/connect", `{
		"connectionId": "conn-A", "provider": "s3",
		"endpoint": "`+urlA+`", "accessKeyId": "AK", "accessKeySecret": "SK",
		"bucket": "bucket-a", "pathStyle": true
	}`); rerr != nil {
		t.Fatalf("连接失败: %s", rerr.Message)
	}

	// 本连接：已连接
	res, rerr := call(t, "connection/status", `{"connectionId": "conn-A"}`)
	if rerr != nil {
		t.Fatalf("status 失败: %s", rerr.Message)
	}
	if connected, _ := res.(map[string]interface{})["connected"].(bool); !connected {
		t.Errorf("conn-A 应为已连接")
	}

	// 其他连接（如快捷入口新开的标签页）：未连接——修复前这里会误报已连接，
	// 导致新标签页直接复刻别的连接内容
	res, _ = call(t, "connection/status", `{"connectionId": "conn-other"}`)
	if connected, _ := res.(map[string]interface{})["connected"].(bool); connected {
		t.Errorf("conn-other 不应继承 conn-A 的连接状态")
	}
}

// TestSession_DisconnectOnlyAffectsOwn disconnect 只拆除自己的会话。
func TestSession_DisconnectOnlyAffectsOwn(t *testing.T) {
	resetSessions()
	t.Cleanup(resetSessions)

	urlA := newSessionTestS3(t, "bucket-a", "a.txt", "x")
	urlB := newSessionTestS3(t, "bucket-b", "b.txt", "y")
	for _, c := range []struct{ id, url string }{{"conn-A", urlA}, {"conn-B", urlB}} {
		if _, rerr := call(t, "connection/connect", `{
			"connectionId": "`+c.id+`", "provider": "s3",
			"endpoint": "`+c.url+`", "accessKeyId": "AK", "accessKeySecret": "SK",
			"pathStyle": true
		}`); rerr != nil {
			t.Fatalf("连接 %s 失败: %s", c.id, rerr.Message)
		}
	}

	if _, rerr := call(t, "connection/disconnect", `{"connectionId": "conn-B"}`); rerr != nil {
		t.Fatalf("disconnect 失败: %s", rerr.Message)
	}
	if n := sessionCount(); n != 1 {
		t.Errorf("应只剩 1 个会话, got %d", n)
	}
	// A 不受影响
	if _, rerr := call(t, "objects/read", `{
		"connectionId": "conn-A", "bucket": "bucket-a", "path": "a.txt"
	}`); rerr != nil {
		t.Errorf("conn-B 断开不应影响 conn-A: %s", rerr.Message)
	}
	// 重复 disconnect 幂等
	if _, rerr := call(t, "connection/disconnect", `{"connectionId": "conn-B"}`); rerr != nil {
		t.Errorf("重复 disconnect 应幂等, got %s", rerr.Message)
	}
}

// TestSession_ReadOnlyIsPerSession readOnly 是会话级属性：
// 只读连接 A 拒绝写，普通连接 B 不受影响。
func TestSession_ReadOnlyIsPerSession(t *testing.T) {
	resetSessions()
	t.Cleanup(resetSessions)

	urlA := newSessionTestS3(t, "bucket-a", "a.txt", "x")
	urlB := newSessionTestS3(t, "bucket-b", "b.txt", "y")
	if _, rerr := call(t, "connection/connect", `{
		"connectionId": "conn-A", "provider": "s3",
		"endpoint": "`+urlA+`", "accessKeyId": "AK", "accessKeySecret": "SK",
		"bucket": "bucket-a", "pathStyle": true, "read_only": true
	}`); rerr != nil {
		t.Fatalf("连接 A 失败: %s", rerr.Message)
	}
	if _, rerr := call(t, "connection/connect", `{
		"connectionId": "conn-B", "provider": "s3",
		"endpoint": "`+urlB+`", "accessKeyId": "AK", "accessKeySecret": "SK",
		"bucket": "bucket-b", "pathStyle": true
	}`); rerr != nil {
		t.Fatalf("连接 B 失败: %s", rerr.Message)
	}

	// A 只读：写被拒
	if _, rerr := call(t, "objects/write", `{
		"connectionId": "conn-A", "bucket": "bucket-a", "path": "new.txt",
		"content": "`+base64.StdEncoding.EncodeToString([]byte("hi"))+`"
	}`); rerr == nil {
		t.Errorf("只读连接 A 的写操作应被拒绝")
	}
	// B 可写：同一时刻不受 A 的只读标记影响
	if _, rerr := call(t, "objects/write", `{
		"connectionId": "conn-B", "bucket": "bucket-b", "path": "new.txt",
		"content": "`+base64.StdEncoding.EncodeToString([]byte("hi"))+`"
	}`); rerr != nil {
		t.Errorf("普通连接 B 的写操作不应被拒: %s", rerr.Message)
	}
}

// TestSession_BackwardCompatibleDefault 不带任何连接标识的调用走 default 会话，
// 与旧版单会话行为一致（向后兼容旧前端 / 宿主旧版本）。
func TestSession_BackwardCompatibleDefault(t *testing.T) {
	resetSessions()
	t.Cleanup(resetSessions)

	urlA := newSessionTestS3(t, "bucket-a", "a.txt", "legacy")
	if _, rerr := call(t, "connection/connect", `{
		"provider": "s3", "endpoint": "`+urlA+`",
		"accessKeyId": "AK", "accessKeySecret": "SK", "bucket": "bucket-a", "pathStyle": true
	}`); rerr != nil {
		t.Fatalf("连接失败: %s", rerr.Message)
	}
	// 不带 connectionId 的请求应命中 default 会话
	if _, rerr := call(t, "objects/read", `{"bucket": "bucket-a", "path": "a.txt"}`); rerr != nil {
		t.Errorf("default 会话应可用: %s", rerr.Message)
	}
	res, _ := call(t, "connection/status", `{}`)
	if connected, _ := res.(map[string]interface{})["connected"].(bool); !connected {
		t.Errorf("default 会话应为已连接")
	}
}

// TestExtractConnID extractConnID 的解析优先级与容错。
func TestExtractConnID(t *testing.T) {
	cases := []struct {
		name   string
		params string
		want   string
	}{
		{"顶层 connectionId", `{"connectionId": "ui-1", "bucket": "b"}`, "ui-1"},
		{"宿主 connection.id", `{"connection": {"id": "host-1"}}`, "host-1"},
		{"顶层优先于信封", `{"connectionId": "ui-1", "connection": {"id": "host-1"}}`, "ui-1"},
		{"空白视为缺省", `{"connectionId": "  "}`, defaultConnID},
		{"无标识回落 default", `{"bucket": "b"}`, defaultConnID},
		{"空 params", ``, defaultConnID},
		{"非法 JSON 容错", `{broken`, defaultConnID},
		{"数组容错", `[1,2]`, defaultConnID},
		{"顶层 provider 信封对象不干扰", `{"provider": {"id": "com.object.browser.connection"}}`, defaultConnID},
	}
	for _, c := range cases {
		if got := extractConnID(json.RawMessage(c.params)); got != c.want {
			t.Errorf("%s: extractConnID = %q, want %q", c.name, got, c.want)
		}
	}
}

// TestSession_LruEviction 超过上限时淘汰最久未用的会话，凭据不会无限累积。
func TestSession_LruEviction(t *testing.T) {
	resetSessions()
	t.Cleanup(resetSessions)

	for i := 0; i < maxSessions+5; i++ {
		putSession(connIDFor(i), ConnConfig{Endpoint: "e"}, &mockDriver{objects: map[string]mockObject{}})
	}
	if n := sessionCount(); n != maxSessions {
		t.Errorf("会话数应被钳制在 %d, got %d", maxSessions, n)
	}
	// 最早写入且未被访问的会话应已被淘汰
	if s := getSession(connIDFor(0)); s != nil {
		t.Errorf("最旧会话应已被淘汰")
	}
	// 最新的会话仍在
	if s := getSession(connIDFor(maxSessions + 4)); s == nil {
		t.Errorf("最新会话不应被淘汰")
	}
}

func connIDFor(i int) string {
	return fmt.Sprintf("conn-%03d", i)
}
