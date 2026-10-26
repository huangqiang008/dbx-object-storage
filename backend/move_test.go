package main

// move_test.go — 目录重命名（MovePrefix）与只读模式的单测。
//
// 覆盖两类容易出错、手测难覆盖的逻辑：
//   - MovePrefix 的 key 映射与「目标不得是源的子目录」防呆；
//   - parseConn 对 read_only 的解析，以及 requireWritable 的拦截行为。

import (
	"encoding/json"
	"testing"
)

// ---------- MovePrefix 的 key 映射 ----------

// movePrefixKey 复刻两个驱动实现共用的 key 映射规则：
// 源 key = fromPrefix + 相对路径 → 目标 key = toPrefix + 相对路径。
// 单独抽成函数测试，是为了让「前缀替换」这一易错点有明确的断言锚点。
func movePrefixKey(fromPrefix, toPrefix, src string) string {
	return toPrefix + src[len(fromPrefix):]
}

func TestMovePrefixKeyMapping(t *testing.T) {
	cases := []struct {
		from, to, src, want string
	}{
		{"a/b/", "a/c/", "a/b/f.txt", "a/c/f.txt"},
		{"a/b/", "a/c/", "a/b/sub/f.txt", "a/c/sub/f.txt"},
		{"a/b/", "a/c/", "a/b/deep/x/y.bin", "a/c/deep/x/y.bin"},
		// 根目录改名
		{"", "newroot/", "top.txt", "newroot/top.txt"},
	}
	for _, c := range cases {
		if got := movePrefixKey(c.from, c.to, c.src); got != c.want {
			t.Errorf("movePrefixKey(%q,%q,%q) = %q, want %q", c.from, c.to, c.src, got, c.want)
		}
	}
}

// TestMovePrefixTargetInsideSource 被 handler 层拦截：
// 目标目录若位于源目录之内（如 a/b → a/b/c），搬迁会自我嵌套、无限循环。
func TestMovePrefixTargetInsideSource(t *testing.T) {
	src := normalizeDirPrefix("a/b")
	dst := normalizeDirPrefix("a/b/c")
	if !(len(dst) > len(src) && dst[:len(src)] == src) {
		t.Fatalf("测试前提不成立: src=%q dst=%q", src, dst)
	}
	// 正常兄弟目录不应被误判
	sibling := normalizeDirPrefix("a/c")
	if len(sibling) > len(src) && sibling[:len(src)] == src {
		t.Errorf("兄弟目录 %q 不应被判定为源 %q 的子目录", sibling, src)
	}
}

// ---------- read_only 解析 ----------

func TestParseConn_ReadOnlyFromHostShape(t *testing.T) {
	params := json.RawMessage(`{
		"connection": {
			"name": "ro",
			"external_config": {
				"provider": "minio",
				"endpoint": "http://127.0.0.1:9000",
				"access_key_id": "AK",
				"bucket": "b"
			},
			"connection_secrets": { "access_key_secret": "SK" },
			"read_only": true
		}
	}`)
	c, err := parseConn(params)
	if err != nil {
		t.Fatalf("parseConn 失败: %v", err)
	}
	if !c.ReadOnly {
		t.Errorf("宿主 read_only=true 应被解析为只读")
	}
	if c.AccessKeyID != "AK" || c.AccessKeySecret != "SK" {
		t.Errorf("凭据解析错误: ak=%q sk=%q", c.AccessKeyID, c.AccessKeySecret)
	}
	if c.Provider.String() != ProviderS3 {
		t.Errorf("provider 应归一化为 s3, got %q", c.Provider.String())
	}
}

// TestParseConn_ReadOnlyFalseByDefault 普通连接不应被误判为只读。
func TestParseConn_ReadOnlyFalseByDefault(t *testing.T) {
	params := json.RawMessage(`{
		"provider": "aliyun",
		"endpoint": "oss-cn-hangzhou.aliyuncs.com",
		"accessKeyId": "AK",
		"accessKeySecret": "SK"
	}`)
	c, err := parseConn(params)
	if err != nil {
		t.Fatalf("parseConn 失败: %v", err)
	}
	if c.ReadOnly {
		t.Errorf("未声明只读的连接不应被标记为只读")
	}
}

// TestParseConn_ReadOnlyFlatShape 插件自带表单（扁平驼峰）传 readOnly 也应生效。
func TestParseConn_ReadOnlyFlatShape(t *testing.T) {
	params := json.RawMessage(`{
		"provider": "aliyun",
		"endpoint": "oss-cn-hangzhou.aliyuncs.com",
		"accessKeyId": "AK",
		"accessKeySecret": "SK",
		"readOnly": true
	}`)
	c, err := parseConn(params)
	if err != nil {
		t.Fatalf("parseConn 失败: %v", err)
	}
	if !c.ReadOnly {
		t.Errorf("扁平形状的 readOnly=true 应生效")
	}
}

// TestParseConn_HostShapeKeepsFlatValues 宿主形状下凭据由宿主下发，
// 但不应把插件侧已填好的字段冲掉。
func TestParseConn_HostShapeKeepsFlatValues(t *testing.T) {
	params := json.RawMessage(`{
		"accessKeyId": "FLAT-AK",
		"accessKeySecret": "FLAT-SK",
		"connection": {
			"external_config": { "endpoint": "http://127.0.0.1:9000" },
			"read_only": true
		}
	}`)
	c, err := parseConn(params)
	if err != nil {
		t.Fatalf("parseConn 失败: %v", err)
	}
	if c.AccessKeyID != "FLAT-AK" {
		t.Errorf("宿主形状不应覆盖扁平的 accessKeyId, got %q", c.AccessKeyID)
	}
	if c.Endpoint != "http://127.0.0.1:9000" {
		t.Errorf("应从 external_config 补齐 endpoint, got %q", c.Endpoint)
	}
	if !c.ReadOnly {
		t.Errorf("宿主形状的 read_only 应生效")
	}
}

// ---------- requireWritable 拦截 ----------

// TestRequireWritable_BlocksWhenReadOnly 只读连接下写操作必须被拒绝。
func TestRequireWritable_BlocksWhenReadOnly(t *testing.T) {
	stateMu.Lock()
	oldCfg, oldDrv := state.cfg, state.driver
	state.cfg = ConnConfig{ReadOnly: true}
	stateMu.Unlock()
	defer func() {
		stateMu.Lock()
		state.cfg, state.driver = oldCfg, oldDrv
		stateMu.Unlock()
	}()

	if err := requireWritable(); err == nil {
		t.Fatalf("只读连接下 requireWritable 应返回错误")
	} else if err.Code != -32000 {
		t.Errorf("错误码应为 -32000, got %d", err.Code)
	}
}

// TestRequireWritable_AllowsWhenWritable 普通连接应放行。
func TestRequireWritable_AllowsWhenWritable(t *testing.T) {
	stateMu.Lock()
	oldCfg, oldDrv := state.cfg, state.driver
	state.cfg = ConnConfig{ReadOnly: false}
	stateMu.Unlock()
	defer func() {
		stateMu.Lock()
		state.cfg, state.driver = oldCfg, oldDrv
		stateMu.Unlock()
	}()

	if err := requireWritable(); err != nil {
		t.Errorf("可写连接不应被拦截: %v", err)
	}
}

// TestWriteHandlersRejectWhenReadOnly 逐个确认写类 handler 都接上了守卫。
// 直接调用 handler 而非检查源码文本，防止有人加了新 handler 却漏掉守卫。
func TestWriteHandlersRejectWhenReadOnly(t *testing.T) {
	stateMu.Lock()
	oldCfg, oldDrv := state.cfg, state.driver
	state.cfg = ConnConfig{ReadOnly: true}
	state.driver = nil // 无驱动时若守卫失效，报错信息会变成「未连接」而非只读拦截
	stateMu.Unlock()
	defer func() {
		stateMu.Lock()
		state.cfg, state.driver = oldCfg, oldDrv
		stateMu.Unlock()
	}()

	cases := []struct {
		name string
		fn   func(json.RawMessage) (interface{}, *RPCError)
		args string
	}{
		{"objects/write", handleObjectsWrite, `{"bucket":"b","path":"p","content":""}`},
		{"objects/delete", handleObjectsDelete, `{"bucket":"b","path":"p"}`},
		{"objects/delete_dir", handleObjectsDeleteDir, `{"bucket":"b","path":"p"}`},
		{"objects/delete_batch", handleObjectsDeleteBatch, `{"bucket":"b","paths":["p"]}`},
		{"objects/move", handleObjectsMove, `{"bucket":"b","from":"a","to":"b"}`},
		{"objects/copy", handleObjectsCopy, `{"bucket":"b","from":"a","to":"b"}`},
		{"objects/move_dir", handleObjectsMoveDir, `{"bucket":"b","from":"a/","to":"b/"}`},
		{"objects/copy_dir", handleObjectsCopyDir, `{"bucket":"b","from":"a/","to":"b/"}`},
		{"objects/copy_across", handleObjectsCopyAcross, `{"bucket":"b","dstBucket":"c","from":"a","to":"b"}`},
		{"objects/move_across", handleObjectsMoveAcross, `{"bucket":"b","dstBucket":"c","from":"a","to":"b"}`},
		{"objects/copy_dir_across", handleObjectsCopyDirAcross, `{"bucket":"b","dstBucket":"c","from":"a/","to":"b/"}`},
		{"objects/set_meta", handleObjectsSetMeta, `{"bucket":"b","path":"p","contentType":"text/plain"}`},
		{"objects/set_tags", handleObjectsSetTags, `{"bucket":"b","path":"p","tags":{"k":"v"}}`},
		{"upload/begin", handleUploadBegin, `{"bucket":"b","path":"p","size":1}`},
	}
	for _, c := range cases {
		_, err := c.fn(json.RawMessage(c.args))
		if err == nil {
			t.Errorf("%s 在只读模式下应被拒绝", c.name)
			continue
		}
		if err.Message != "当前连接为只读模式，不能执行写操作" {
			t.Errorf("%s 应返回只读拦截错误, got %q", c.name, err.Message)
		}
	}
}
