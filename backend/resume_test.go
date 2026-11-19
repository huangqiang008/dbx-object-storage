package main

// resume_test.go — 断点续传测试。
// 续传的正确性完全依赖「文件名可由 bucket+key+size 稳定推导」，
// 一旦这点被破坏，sidecar 重启后就找不到旧分片，续传静默失效。
// 因此重点验证 stem 的稳定性、接管条件、以及不该接管的场景。

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// withTempDir 见 upload_test.go（同包复用，此处不再重复定义）

func TestUploadStem_Stable(t *testing.T) {
	a := uploadStem(defaultConnID, "bkt", "p/q/f.bin", 1024)
	b := uploadStem(defaultConnID, "bkt", "p/q/f.bin", 1024)
	if a != b {
		t.Errorf("相同输入应得相同 stem: %q vs %q", a, b)
	}
	if len(a) <= len(uploadTempPrefix) {
		t.Errorf("stem 应含 hash 部分, got %q", a)
	}
}

// 任一维度变化都必须导致 stem 变化，否则会误接管别的文件的上传分片。
func TestUploadStem_DiffersOnAnyFieldChange(t *testing.T) {
	base := uploadStem(defaultConnID, "bkt", "key", 100)
	cases := []struct {
		desc  string
		other string
	}{
		{"连接不同", uploadStem("conn-other", "bkt", "key", 100)},
		{"bucket 不同", uploadStem(defaultConnID, "other", "key", 100)},
		{"key 不同", uploadStem(defaultConnID, "bkt", "key2", 100)},
		{"size 不同", uploadStem(defaultConnID, "bkt", "key", 101)},
	}
	for _, c := range cases {
		if base == c.other {
			t.Errorf("%s 时 stem 不应相同（会误接管分片）", c.desc)
		}
	}
}

// 分隔符防碰撞：若直接用分隔符拼接，("a","b\0c") 与 ("a\0b","c") 会撞车。
func TestUploadStem_NoDelimiterCollision(t *testing.T) {
	x := uploadStem(defaultConnID, "a", "b\x00c", 1)
	y := uploadStem(defaultConnID, "a\x00b", "c", 1)
	if x == y {
		t.Error("含分隔符的 key/bucket 组合不应产生相同 stem")
	}
}

// 模拟一次「上传一半后崩溃」：写出 .part 与 .meta，再调用 claim。
func TestClaimResumableUpload_ResumesExisting(t *testing.T) {
	withTempDir(t, func(dir string) {
		uploadsMu.Lock()
		orig := uploads
		uploads = map[string]*uploadSession{}
		uploadsMu.Unlock()
		t.Cleanup(func() {
			uploadsMu.Lock()
			uploads = orig
			uploadsMu.Unlock()
		})

		const bucket, key = "bkt", "p/f.bin"
		const size = int64(4096)
		stem := uploadStem(defaultConnID, bucket, key, size)

		// 先跑一次 begin 产生元数据，再手工写入一半分片
		payload := make([]byte, 2048)
		for i := range payload {
			payload[i] = byte(i % 251)
		}
		if e := os.WriteFile(filepath.Join(dir, stem+".part"), payload, 0o600); e != nil {
			t.Fatal(e)
		}
		raw, _ := json.Marshal(uploadMeta{Bucket: bucket, Key: key, Size: size, Mime: "application/octet-stream", ConnID: defaultConnID})
		if e := os.WriteFile(filepath.Join(dir, stem+".meta"), raw, 0o600); e != nil {
			t.Fatal(e)
		}

		sess := claimResumableUpload(defaultConnID, bucket, key, size)
		if sess == nil {
			t.Fatal("应接管已有分片")
		}
		if sess.written != 2048 {
			t.Errorf("written = %d, want 2048", sess.written)
		}
		if !sess.resumable {
			t.Error("接管的历史会话应标记 resumable")
		}
		// 追加后内容应是「原分片 + 新数据」
		if _, e := sess.file.Write([]byte("TAIL")); e != nil {
			t.Fatal(e)
		}
		sess.file.Close()
		got, e := os.ReadFile(filepath.Join(dir, stem+".part"))
		if e != nil {
			t.Fatal(e)
		}
		if len(got) != 2048+4 || string(got[2048:]) != "TAIL" {
			t.Errorf("追加结果不正确, len=%d tail=%q", len(got), string(got[2048:]))
		}
		if sess.mime != "application/octet-stream" {
			t.Errorf("mime 应从元数据恢复, got %q", sess.mime)
		}
	})
}

func TestClaimResumableUpload_RejectsMismatch(t *testing.T) {
	withTempDir(t, func(dir string) {
		uploadsMu.Lock()
		orig := uploads
		uploads = map[string]*uploadSession{}
		uploadsMu.Unlock()
		t.Cleanup(func() {
			uploadsMu.Lock()
			uploads = orig
			uploadsMu.Unlock()
		})

		const bucket, key = "bkt", "p/f.bin"
		const size = int64(4096)
		stem := uploadStem(defaultConnID, bucket, key, size)
		if e := os.WriteFile(filepath.Join(dir, stem+".part"), make([]byte, 100), 0o600); e != nil {
			t.Fatal(e)
		}
		raw, _ := json.Marshal(uploadMeta{Bucket: bucket, Key: key, Size: size, ConnID: defaultConnID})
		if e := os.WriteFile(filepath.Join(dir, stem+".meta"), raw, 0o600); e != nil {
			t.Fatal(e)
		}

		cases := []struct {
			desc                 string
			b, k                 string
			s                    int64
			wantFileStillPresent bool
		}{
			{"bucket 不同", "other", key, size, true},
			{"key 不同", bucket, "other", size, true},
			{"size 不同", bucket, key, 999, true},
			{"size 传 0", bucket, key, 0, true},
			{"分片为空", bucket, key, 0, true},
		}
		for _, c := range cases {
			if sess := claimResumableUpload(defaultConnID, c.b, c.k, c.s); sess != nil {
				sess.file.Close()
				t.Errorf("%s 时不应接管", c.desc)
			}
		}

		// 元数据与分片不成对（只有 .meta）时不应接管
		if e := os.Remove(filepath.Join(dir, stem+".part")); e != nil {
			t.Fatal(e)
		}
		if sess := claimResumableUpload(defaultConnID, bucket, key, size); sess != nil {
			sess.file.Close()
			t.Error("缺少分片文件时不应接管")
		}
	})
}

// 分片比声明的总大小还长 → 状态错乱，必须丢弃而不是接着写（否则会传出损坏文件）。
func TestClaimResumableUpload_DiscardsOversizedPart(t *testing.T) {
	withTempDir(t, func(dir string) {
		uploadsMu.Lock()
		orig := uploads
		uploads = map[string]*uploadSession{}
		uploadsMu.Unlock()
		t.Cleanup(func() {
			uploadsMu.Lock()
			uploads = orig
			uploadsMu.Unlock()
		})

		const bucket, key = "bkt", "f.bin"
		const size = int64(100)
		stem := uploadStem(defaultConnID, bucket, key, size)

		// 空分片
		raw, _ := json.Marshal(uploadMeta{Bucket: bucket, Key: key, Size: size, ConnID: defaultConnID})
		os.WriteFile(filepath.Join(dir, stem+".meta"), raw, 0o600)
		os.WriteFile(filepath.Join(dir, stem+".part"), []byte{}, 0o600)
		if sess := claimResumableUpload(defaultConnID, bucket, key, size); sess != nil {
			sess.file.Close()
			t.Error("空分片不应被接管")
		}
		if _, e := os.Stat(filepath.Join(dir, stem+".part")); !os.IsNotExist(e) {
			t.Error("空分片应被清理")
		}

		// 超长分片
		os.WriteFile(filepath.Join(dir, stem+".meta"), raw, 0o600)
		os.WriteFile(filepath.Join(dir, stem+".part"), make([]byte, 200), 0o600)
		if sess := claimResumableUpload(defaultConnID, bucket, key, size); sess != nil {
			sess.file.Close()
			t.Error("超长分片不应被接管")
		}
		if _, e := os.Stat(filepath.Join(dir, stem+".part")); !os.IsNotExist(e) {
			t.Error("超长分片应被清理")
		}
	})
}

// 无任何历史分片时返回 nil（走全新上传路径）。
func TestClaimResumableUpload_NoHistory(t *testing.T) {
	withTempDir(t, func(_ string) {
		if sess := claimResumableUpload(defaultConnID, "bkt", "nobody.bin", 100); sess != nil {
			sess.file.Close()
			t.Error("无历史分片时应返回 nil")
		}
	})
}

// 半截 JSON（进程在写 .meta 时被杀）不应导致接管，应退回全新上传。
func TestClaimResumableUpload_CorruptMeta(t *testing.T) {
	withTempDir(t, func(dir string) {
		uploadsMu.Lock()
		orig := uploads
		uploads = map[string]*uploadSession{}
		uploadsMu.Unlock()
		t.Cleanup(func() {
			uploadsMu.Lock()
			uploads = orig
			uploadsMu.Unlock()
		})

		stem := uploadStem(defaultConnID, "bkt", "f.bin", 100)
		os.WriteFile(filepath.Join(dir, stem+".part"), make([]byte, 10), 0o600)
		os.WriteFile(filepath.Join(dir, stem+".meta"), []byte(`{"bucket":"bkt","key`), 0o600)

		if sess := claimResumableUpload(defaultConnID, "bkt", "f.bin", 100); sess != nil {
			sess.file.Close()
			t.Error("元数据损坏时不应接管")
		}
	})
}

// removeUploadFiles 应同时清掉 .part 与 .meta，不留孤儿元数据。
func TestRemoveUploadFiles_CleansPartAndMeta(t *testing.T) {
	withTempDir(t, func(dir string) {
		part := filepath.Join(dir, "dbx-up-test.part")
		meta := filepath.Join(dir, "dbx-up-test.meta")
		os.WriteFile(part, []byte("x"), 0o600)
		os.WriteFile(meta, []byte("{}"), 0o600)

		sess := &uploadSession{tmpPath: part, metaPath: meta}
		// file 为 nil 时 Close 会 panic，这里构造一个真实句柄
		f, e := os.OpenFile(part, os.O_RDWR, 0o600)
		if e != nil {
			t.Fatal(e)
		}
		sess.file = f

		removeUploadFiles(sess)

		if _, e := os.Stat(part); !os.IsNotExist(e) {
			t.Error(".part 应被删除")
		}
		if _, e := os.Stat(meta); !os.IsNotExist(e) {
			t.Error(".meta 应被删除")
		}
	})
}

// TestClaimResumableUpload_RejectsOtherConnection 跨连接不得接管分片。
//
// 场景：同一台机器上两个连接（可能是两个不同的存储服务、不同凭证）上传
// 同名同大小的对象——「把同一份文件镜像到两个云」是常见操作，size 必然相同。
// 若接管，A 连接的文件内容会被传进 B 连接的存储，属于跨连接数据污染。
func TestClaimResumableUpload_RejectsOtherConnection(t *testing.T) {
	uploadE2E(t, func() {
		const bucket, key = "data", "report.bin"
		const size = int64(4096)

		// 手工造出「连接 A 遗留」的分片与元数据
		stemA := uploadStem("conn-A", bucket, key, size)
		dir := os.TempDir()
		if e := os.WriteFile(filepath.Join(dir, stemA+".part"), make([]byte, 1024), 0o600); e != nil {
			t.Fatal(e)
		}
		raw, _ := json.Marshal(uploadMeta{
			Bucket: bucket, Key: key, Size: size, ConnID: "conn-A",
		})
		if e := os.WriteFile(filepath.Join(dir, stemA+".meta"), raw, 0o600); e != nil {
			t.Fatal(e)
		}

		// 连接 B 尝试接管：stem 不同 → 找不到，返回 nil（不会误接管）
		if sess := claimResumableUpload("conn-B", bucket, key, size); sess != nil {
			sess.file.Close()
			t.Error("连接 B 不应接管连接 A 的分片")
		}
		// 连接 A 自己仍可接管
		sess := claimResumableUpload("conn-A", bucket, key, size)
		if sess == nil {
			t.Fatal("连接 A 应能接管自己的分片")
		}
		sess.file.Close()
	})
}

// TestClaimResumableUpload_RejectsLegacyMetaWithoutConnID 旧版本写的 .meta 没有
// connId 字段，无法确认归属，一律不接管——宁可全量重传，也不能把内容传到
// 可能错误的存储服务上。
func TestClaimResumableUpload_RejectsLegacyMetaWithoutConnID(t *testing.T) {
	uploadE2E(t, func() {
		const bucket, key = "bkt", "f.bin"
		const size = int64(100)
		stem := uploadStem(defaultConnID, bucket, key, size)
		dir := os.TempDir()
		os.WriteFile(filepath.Join(dir, stem+".part"), make([]byte, 50), 0o600)
		// ConnID 留空 = 旧版本产物
		raw, _ := json.Marshal(uploadMeta{Bucket: bucket, Key: key, Size: size})
		os.WriteFile(filepath.Join(dir, stem+".meta"), raw, 0o600)

		if sess := claimResumableUpload(defaultConnID, bucket, key, size); sess != nil {
			sess.file.Close()
			t.Error("无 connId 的旧分片不应被接管")
		}
	})
}
