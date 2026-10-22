package main

// upload_test.go — 上传临时文件回收与会话上限测试。
// 验证 cleanupStaleUploads 只清理超龄的 dbx-up-*.part，
// 不误伤其它临时文件，也不误删仍在保留期内的活跃上传分片。

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// withTempDir 把 os.TempDir() 临时切到 t.TempDir()，使测试不污染真实临时目录，
// 并让 Glob 只能看到测试自己造的文件。
func withTempDir(t *testing.T, fn func(dir string)) {
	t.Helper()
	orig := os.TempDir()
	dir := t.TempDir()
	os.Setenv("TMP", dir)
	os.Setenv("TEMP", dir)
	os.Setenv("TMPDIR", dir)
	// Windows 下 os.TempDir 读 TMP/TEMP，其余平台读 TMPDIR
	t.Cleanup(func() {
		os.Unsetenv("TMP")
		os.Unsetenv("TEMP")
		os.Unsetenv("TMPDIR")
		_ = orig
	})
	fn(dir)
}

// 写一个 dbx-up-*.part 文件，并把 mtime 设为 age 之前。
func writeAgedPart(t *testing.T, dir, name string, age time.Duration) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if e := os.WriteFile(p, []byte("x"), 0o644); e != nil {
		t.Fatal(e)
	}
	old := time.Now().Add(-age)
	if e := os.Chtimes(p, old, old); e != nil {
		t.Fatal(e)
	}
	return p
}

func TestCleanupStaleUploads_RemovesOnlyExpired(t *testing.T) {
	withTempDir(t, func(dir string) {
		stale := writeAgedPart(t, dir, "dbx-up-stale.part", 48*time.Hour)
		fresh := writeAgedPart(t, dir, "dbx-up-fresh.part", 1*time.Hour)
		other := filepath.Join(dir, "other-app.tmp")
		if e := os.WriteFile(other, []byte("x"), 0o644); e != nil {
			t.Fatal(e)
		}
		old := time.Now().Add(-48 * time.Hour)
		_ = os.Chtimes(other, old, old)

		cleanupStaleUploads()

		if _, e := os.Stat(stale); !os.IsNotExist(e) {
			t.Errorf("超龄临时文件应被删除: %s", stale)
		}
		if _, e := os.Stat(fresh); e != nil {
			t.Errorf("保留期内的分片不应被删除: %s", fresh)
		}
		if _, e := os.Stat(other); e != nil {
			t.Errorf("非本插件的临时文件不应被删除: %s", other)
		}
	})
}

// 保留期边界：刚好等于 TTL 的文件应保留（用 > 而非 >= 判定）。
func TestCleanupStaleUploads_KeepsWithinTTL(t *testing.T) {
	withTempDir(t, func(dir string) {
		p := writeAgedPart(t, dir, "dbx-up-edge.part", uploadTempTTL-time.Hour)
		cleanupStaleUploads()
		if _, e := os.Stat(p); e != nil {
			t.Errorf("TTL 内的文件不应被清理: %v", e)
		}
	})
}

// 多次调用应幂等（第一次删完，第二次无可删，不 panic）。
func TestCleanupStaleUploads_Idempotent(t *testing.T) {
	withTempDir(t, func(dir string) {
		writeAgedPart(t, dir, "dbx-up-a.part", 72*time.Hour)
		cleanupStaleUploads()
		cleanupStaleUploads() // 不应 panic
	})
}

// 空环境（无匹配文件）不应 panic。
func TestCleanupStaleUploads_NoMatches(t *testing.T) {
	withTempDir(t, func(_ string) {
		cleanupStaleUploads()
	})
}

func TestRegisterUpload_EnforcesConcurrencyLimit(t *testing.T) {
	// 直接替换全局会话表，避免依赖真实文件
	uploadsMu.Lock()
	orig := uploads
	uploads = map[string]*uploadSession{}
	uploadsMu.Unlock()
	t.Cleanup(func() {
		uploadsMu.Lock()
		uploads = orig
		uploadsMu.Unlock()
	})

	// 每个会话必须用不同 id：map 以 id 为键，同键会覆盖导致长度恒为 1
	for i := 0; i < maxConcurrentUploads; i++ {
		if e := registerUpload(&uploadSession{}, fmt.Sprintf("id-%d", i)); e != nil {
			t.Fatalf("第 %d 个会话应被接受: %v", i+1, e)
		}
	}
	if e := registerUpload(&uploadSession{}, "overflow"); e == nil {
		t.Errorf("超过上限 %d 后应拒绝", maxConcurrentUploads)
	}
}
