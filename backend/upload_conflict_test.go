package main

// upload_conflict_test.go — 上传冲突检测（issue #11 第三批）的行为测试。
//
// 修复前的行为：上传同名对象直接覆盖，不询问、不提示、不可逆——静默覆盖
// 是数据丢失。现在 begin 时前置检测目标是否存在：
//   - 存在且未声明 overwrite → 返回 exists 标记（不创建分片、无 uploadId），
//     由前端弹框让用户决定；
//   - 存在且声明 overwrite → 照常创建；
//   - 断点续传命中 → 跳过检测（能走到续传说明用户此前已决定上传该文件）；
//   - Stat 出错 → 按"不存在"放行（fail-open，与旧行为一致，不新增失败模式）。

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
)

// TestBegin_ExistingObjectReturnsExists 目标已存在且未声明覆盖：
// 返回 exists 标记，**不返回 uploadId**（前端以"有没有 uploadId"区分是否进入传输）。
func TestBegin_ExistingObjectReturnsExists(t *testing.T) {
	uploadE2E(t, func() {
		objs := map[string]mockObject{
			"dup.txt": {data: []byte("old-content"), etag: "etag-old"},
		}
		drv := withMockDriver(t, objs)

		raw, _ := json.Marshal(map[string]interface{}{
			"bucket": "b", "path": "dup.txt", "size": 5,
		})
		res, rerr := call(t, "upload/begin", string(raw))
		if rerr != nil {
			t.Fatalf("begin 不应报错: %s", rerr.Message)
		}
		m := res.(map[string]interface{})
		if exists, _ := m["exists"].(bool); !exists {
			t.Fatalf("已存在的对象应返回 exists 标记, got %v", m)
		}
		if uid, _ := m["uploadId"].(string); uid != "" {
			t.Errorf("冲突返回不应创建分片（uploadId 应为空）, got %q", uid)
		}
		// 进程内直调 dispatch，数值是 Go 原生 int64（未经 JSON 往返）
		if sz := toInt64(t, m["size"]); sz != int64(len("old-content")) {
			t.Errorf("exists 应带回已有对象大小供弹框展示, got %v", m["size"])
		}
		_ = drv
	})
}

// TestBegin_OverwriteProceeds 声明 overwrite:true 时照常创建分片。
func TestBegin_OverwriteProceeds(t *testing.T) {
	uploadE2E(t, func() {
		objs := map[string]mockObject{
			"dup.txt": {data: []byte("old")},
		}
		withMockDriver(t, objs)

		raw, _ := json.Marshal(map[string]interface{}{
			"bucket": "b", "path": "dup.txt", "size": 5, "overwrite": true,
		})
		res, rerr := call(t, "upload/begin", string(raw))
		if rerr != nil {
			t.Fatalf("overwrite 的 begin 不应报错: %s", rerr.Message)
		}
		m := res.(map[string]interface{})
		if _, has := m["exists"]; has {
			t.Errorf("声明覆盖后不应再返回 exists 标记, got %v", m)
		}
		if uid, _ := m["uploadId"].(string); uid == "" {
			t.Errorf("声明覆盖后应正常创建分片（返回 uploadId）, got %v", m)
		}
	})
}

// TestBegin_NewObjectNoExistsMark 目标不存在时不返回 exists 标记（主路径不回归）。
func TestBegin_NewObjectNoExistsMark(t *testing.T) {
	uploadE2E(t, func() {
		withMockDriver(t, map[string]mockObject{})

		raw, _ := json.Marshal(map[string]interface{}{
			"bucket": "b", "path": "new.txt", "size": 3,
		})
		res, rerr := call(t, "upload/begin", string(raw))
		if rerr != nil {
			t.Fatalf("begin 失败: %s", rerr.Message)
		}
		m := res.(map[string]interface{})
		if exists, _ := m["exists"].(bool); exists {
			t.Errorf("不存在的对象不应返回 exists 标记, got %v", m)
		}
		if uid, _ := m["uploadId"].(string); uid == "" {
			t.Errorf("应正常创建分片, got %v", m)
		}
	})
}

// TestBegin_ResumeSkipsConflictCheck 续传命中时跳过冲突检测。
//
// 场景：用户此前已开始上传（.part/.meta 在），期间对象被别人传了同名——
// 此时续传不应再被冲突弹框打断（用户早就做过决定了）。
func TestBegin_ResumeSkipsConflictCheck(t *testing.T) {
	uploadE2E(t, func() {
		// 云端对象已存在（如果检测就会命中冲突）
		objs := map[string]mockObject{
			"res.txt": {data: []byte("existing-on-cloud")},
		}
		withMockDriver(t, objs)

		// 本地也有历史分片（模拟上传一半后中断）
		const content = "half-uploaded"
		stem := uploadStem(defaultConnID, "b", "res.txt", int64(len(content)))
		partPath := joinTemp(stem + ".part")
		metaPath := joinTemp(stem + ".meta")
		if e := os.WriteFile(partPath, []byte(content[:4]), 0o600); e != nil {
			t.Fatal(e)
		}
		raw, _ := json.Marshal(uploadMeta{
			Bucket: "b", Key: "res.txt", Size: int64(len(content)),
			ConnID: defaultConnID,
		})
		if e := os.WriteFile(metaPath, raw, 0o600); e != nil {
			t.Fatal(e)
		}
		t.Cleanup(func() {
			os.Remove(partPath)
			os.Remove(metaPath)
		})

		raw2, _ := json.Marshal(map[string]interface{}{
			"bucket": "b", "path": "res.txt", "size": len(content),
		})
		res, rerr := call(t, "upload/begin", string(raw2))
		if rerr != nil {
			t.Fatalf("续传 begin 失败: %s", rerr.Message)
		}
		m := res.(map[string]interface{})
		if resumed, _ := m["resumed"].(bool); !resumed {
			t.Fatalf("应命中续传, got %v", m)
		}
		if _, has := m["exists"]; has {
			t.Errorf("续传命中不应再做冲突检测, got %v", m)
		}
	})
}

// TestBegin_StatErrorFailsOpen Stat 出错时按"不存在"放行（fail-open）。
//
// 不能给上传新增失败模式：检测是体验增强，不是写入前置条件。
func TestBegin_StatErrorFailsOpen(t *testing.T) {
	uploadE2E(t, func() {
		// mockDriver.Stat 对 map 中不存在的 key 返回错误（NoSuchKey），
		// 这里借助一个 Stat 恒错的驱动验证 fail-open：
		drv := &statErrorDriver{mockDriver: &mockDriver{objects: map[string]mockObject{}}}
		withTestSession(t, ConnConfig{Bucket: "b"}, drv)

		raw, _ := json.Marshal(map[string]interface{}{
			"bucket": "b", "path": "any.txt", "size": 3,
		})
		res, rerr := call(t, "upload/begin", string(raw))
		if rerr != nil {
			t.Fatalf("Stat 出错时 begin 应照常放行（fail-open）, got %s", rerr.Message)
		}
		m := res.(map[string]interface{})
		if exists, _ := m["exists"].(bool); exists {
			t.Errorf("Stat 出错不应误报冲突, got %v", m)
		}
		if uid, _ := m["uploadId"].(string); uid == "" {
			t.Errorf("Stat 出错应照常创建分片, got %v", m)
		}
	})
}

// statErrorDriver Stat 恒返回错误（模拟网络抖动等），其余复用 mockDriver。
type statErrorDriver struct {
	*mockDriver
}

func (d *statErrorDriver) Stat(bucket, path string) (ObjMeta, error) {
	return ObjMeta{}, fmt.Errorf("simulated network error")
}

// joinTemp 拼接临时目录下的文件路径（测试辅助）。
func joinTemp(name string) string {
	return strings.TrimRight(os.TempDir(), "/\\") + string(os.PathSeparator) + name
}
