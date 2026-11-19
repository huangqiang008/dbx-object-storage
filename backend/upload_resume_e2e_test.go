package main

// upload_resume_e2e_test.go — 断点续传的端到端回归测试。
//
// 既有 resume_test.go 是「手工写出 stem 命名的 .part/.meta，再调 claimResumableUpload」，
// 只验证了接管逻辑本身，从未跑过真实链路：
//
//	upload/begin（新建分片文件）→ upload/chunk → sidecar 重启 → upload/begin（应接管）
//
// 而真实链路里 begin 用 os.CreateTemp 生成的是**随机**文件名，claim 找的却是
// uploadStem 派生的**稳定**文件名，两者对不上 → 续传静默失效。本测试覆盖该链路。

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// uploadE2E 在隔离的临时目录与干净的会话表下执行 fn。
func uploadE2E(t *testing.T, fn func()) {
	t.Helper()
	withTempDir(t, func(_ string) {
		uploadsMu.Lock()
		orig := uploads
		uploads = map[string]*uploadSession{}
		uploadsMu.Unlock()
		t.Cleanup(func() {
			// 关闭遗留句柄，避免 Windows 下临时目录删不掉
			uploadsMu.Lock()
			for _, s := range uploads {
				if s.file != nil {
					s.file.Close()
				}
			}
			uploads = orig
			uploadsMu.Unlock()
		})
		fn()
	})
}

func uploadBegin(t *testing.T, bucket, key string, size int64) map[string]interface{} {
	t.Helper()
	raw, _ := json.Marshal(map[string]interface{}{
		"bucket": bucket, "path": key, "size": size, "mime": "application/octet-stream",
	})
	res, rerr := handleUploadBegin(raw)
	if rerr != nil {
		t.Fatalf("upload/begin 失败: %s", rerr.Message)
	}
	m, _ := res.(map[string]interface{})
	return m
}

func uploadChunk(t *testing.T, uploadID string, offset int64, data string) {
	t.Helper()
	raw, _ := json.Marshal(map[string]interface{}{
		"uploadId": uploadID, "offset": offset,
		"content": base64.StdEncoding.EncodeToString([]byte(data)),
	})
	if _, rerr := handleUploadChunk(raw); rerr != nil {
		t.Fatalf("upload/chunk 失败: %s", rerr.Message)
	}
}

// simulateRestart 模拟 sidecar 重启：内存会话表清空，磁盘分片保留。
func simulateRestart() {
	uploadsMu.Lock()
	for _, s := range uploads {
		if s.file != nil {
			s.file.Close()
		}
	}
	uploads = map[string]*uploadSession{}
	uploadsMu.Unlock()
}

// toInt64 取回包里的整数。进程内直接调 handler 时返回 Go 原生 int64
//（未经 JSON 往返），故只需处理 int64；float64 分支留给未来经 JSON 解码的路径。
func toInt64(t *testing.T, v interface{}) int64 {
	t.Helper()
	switch n := v.(type) {
	case int64:
		return n
	case int:
		return int64(n)
	case float64:
		return int64(n)
	default:
		t.Fatalf("offset 类型意外: %T (%v)", v, v)
		return 0
	}
}

// TestUploadResume_EndToEnd 真实链路：上传一半 → 重启 → 再 begin 应接管并续上。
func TestUploadResume_EndToEnd(t *testing.T) {
	uploadE2E(t, func() {
		withTestSession(t, ConnConfig{Bucket: "bkt"}, &mockDriver{objects: map[string]mockObject{}})

		const bucket, key, size = "bkt", "dir/big.bin", int64(20)

		// 第一次：begin 拿到全新会话，写入前一半分片
		r1 := uploadBegin(t, bucket, key, size)
		if resumed, _ := r1["resumed"].(bool); resumed {
			t.Fatalf("首次 begin 不应是续传")
		}
		id1, _ := r1["uploadId"].(string)
		uploadChunk(t, id1, 0, "0123456789") // 写入 10 / 20 字节

		// sidecar 崩溃重启
		simulateRestart()

		// 第二次 begin：应接管历史分片，offset 从 10 继续
		r2 := uploadBegin(t, bucket, key, size)
		resumed, _ := r2["resumed"].(bool)
		if !resumed {
			t.Fatalf("重启后应接管历史分片续传，实际 resumed=false（分片文件名不稳定，续传失效）")
		}
		offVal := toInt64(t, r2["offset"])
		if offVal != 10 {
			t.Errorf("续传 offset 应为 10, got %d", offVal)
		}

		// 续上后半段并完成，落盘内容必须是完整的 20 字节
		id2, _ := r2["uploadId"].(string)
		uploadChunk(t, id2, offVal, "abcdefghij")

		uploadsMu.Lock()
		sess := uploads[id2]
		uploadsMu.Unlock()
		if sess == nil {
			t.Fatal("会话应存在")
		}
		sess.file.Close()
		got, e := os.ReadFile(sess.tmpPath)
		if e != nil {
			t.Fatalf("读分片失败: %v", e)
		}
		if string(got) != "0123456789abcdefghij" {
			t.Errorf("续传后分片内容应完整拼接, got %q", string(got))
		}
	})
}

// TestUploadBegin_PartFileAtStablePath begin 创建的分片必须落在 stem 稳定路径上，
// 否则 claimResumableUpload 永远找不到它。
func TestUploadBegin_PartFileAtStablePath(t *testing.T) {
	uploadE2E(t, func() {
		withTestSession(t, ConnConfig{Bucket: "bkt"}, &mockDriver{objects: map[string]mockObject{}})

		const bucket, key, size = "bkt", "a/b.bin", int64(100)
		uploadBegin(t, bucket, key, size)

		want := filepath.Join(os.TempDir(), uploadStem(defaultConnID, bucket, key, size)+".part")
		if _, e := os.Stat(want); e != nil {
			t.Errorf("begin 应在稳定路径创建分片 %s: %v", filepath.Base(want), e)
		}
		wantMeta := filepath.Join(os.TempDir(), uploadStem(defaultConnID, bucket, key, size)+".meta")
		if _, e := os.Stat(wantMeta); e != nil {
			t.Errorf("begin 应在稳定路径创建元数据 %s: %v", filepath.Base(wantMeta), e)
		}
	})
}
