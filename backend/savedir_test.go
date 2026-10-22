package main

// savedir_test.go — 下载落盘目录白名单校验测试。
//
// 这是安全边界：downloadDir 由前端直传，若校验不严，插件就等价于
// 「任意路径写文件」能力。测试重点覆盖 ../ 逃逸与同前缀兄弟目录
// 这两类最容易漏的绕过手法。

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestIsDirWithinAllowedRoots(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		t.Skip("取不到用户主目录，跳过")
	}
	tmp := os.TempDir()

	allowed := []string{
		home,                               // 主目录本身
		filepath.Join(home, "Downloads"),   // 默认下载目录
		filepath.Join(home, "a", "b", "c"), // 深层子目录
		tmp,
		filepath.Join(tmp, "sub"),
	}
	for _, p := range allowed {
		if !isDirWithinAllowedRoots(p) {
			t.Errorf("应允许: %s", p)
		}
	}
}

func TestIsDirWithinAllowedRoots_RejectsOutside(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		t.Skip("取不到用户主目录，跳过")
	}
	// 构造肯定在主目录与临时目录之外的路径
	base := "C:\\Windows\\System32"
	if _, e := os.Stat(filepath.VolumeName(home) + "\\"); e == nil {
		base = filepath.Join(filepath.VolumeName(home), "Windows", "System32")
	}
	rejected := []string{
		filepath.Join(home, "..", "..", "Windows"), // 经典 .. 逃逸
		filepath.Dir(home),                         // 主目录的父目录
		"/etc",
		base,
	}
	for _, p := range rejected {
		if isDirWithinAllowedRoots(p) {
			t.Errorf("应拒绝: %s", p)
		}
	}
}

// 同前缀兄弟目录是最隐蔽的绕过：若用字符串 HasPrefix 判断路径是否在
// 允许目录内，"/home/user-backup" 会被误判为在 "/home/user" 之内。
func TestIsDirWithinAllowedRoots_RejectsSiblingWithSamePrefix(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		t.Skip("取不到用户主目录，跳过")
	}
	sibling := home + "-backup"
	if isDirWithinAllowedRoots(sibling) {
		t.Errorf("同前缀兄弟目录应被拒绝: %s（说明用了 HasPrefix 而非 filepath.Rel）", sibling)
	}
}

func TestResolveDownloadDir_Defaults(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		t.Skip("取不到用户主目录，跳过")
	}
	// 未指定时应落到 ~/Downloads（或取不到主目录时的临时目录）
	got, e := resolveDownloadDir("")
	if e != nil {
		t.Fatalf("未指定目录不应报错: %v", e)
	}
	want := filepath.Join(home, "Downloads")
	if got != want {
		// 取不到主目录的实现会退回临时目录，两种都算通过
		if got != filepath.Clean(os.TempDir()) {
			t.Errorf("默认目录 = %q, want %q 或 %q", got, want, os.TempDir())
		}
	}
	if !filepath.IsAbs(got) {
		t.Errorf("应返回绝对路径, got %q", got)
	}
}

func TestResolveDownloadDir_RejectsEscapes(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		t.Skip("取不到用户主目录，跳过")
	}
	// 带 ../ 的逃逸尝试
	escape := filepath.Join(home, "..", "..", "..", "Windows", "System32")
	if _, e := resolveDownloadDir(escape); e == nil {
		t.Errorf("应拒绝逃逸路径: %s", escape)
	}
	// 直接给系统目录
	if _, e := resolveDownloadDir("/etc"); e == nil {
		t.Error("应拒绝 /etc")
	}
	// 同前缀兄弟目录
	if _, e := resolveDownloadDir(home + "-backup"); e == nil {
		t.Error("应拒绝同前缀兄弟目录")
	}
}

func TestResolveDownloadDir_AcceptsValidPaths(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		t.Skip("取不到用户主目录，跳过")
	}
	for _, p := range []string{
		filepath.Join(home, "Downloads"),
		filepath.Join(home, "Downloads", "sub", "deep"),
		os.TempDir(),
		" " + filepath.Join(home, "Downloads") + " ", // 前后空格应被 trim
	} {
		if _, e := resolveDownloadDir(p); e != nil {
			t.Errorf("应接受合法路径 %q: %v", p, e)
		}
	}
}

// 返回目录必须已是 Clean 后的绝对路径，否则后续 uniquePath 拼接可能出问题。
func TestResolveDownloadDir_ReturnsCleanAbsPath(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		t.Skip("取不到用户主目录，跳过")
	}
	messy := filepath.Join(home, "Downloads", "..", "Downloads", ".")
	got, e := resolveDownloadDir(messy)
	if e != nil {
		t.Fatalf("不应报错: %v", e)
	}
	if got != filepath.Clean(got) {
		t.Errorf("应返回 Clean 路径, got %q", got)
	}
	if !strings.HasPrefix(got, filepath.Clean(home)) {
		t.Errorf("应仍在主目录内, got %q", got)
	}
}
