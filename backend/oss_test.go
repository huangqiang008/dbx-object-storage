package main

// oss_test.go — 纯函数单测。
// 重点覆盖 normalizeDirPrefix（尾部斜杠缺失会误删兄弟目录）与
// sanitizeFilename（Windows 保留名会让 os.Create 直接失败）这类
// 出错后果严重、手测又难覆盖的边界。

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNormalizeDirPrefix(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"a/b", "a/b/"},
		{"a/b/", "a/b/"}, // 已带斜杠不应重复追加
		{"", ""},         // 空路径保持为空，由调用方拒绝
		{"a/", "a/"},
		{"根目录/中文/", "根目录/中文/"},
	}
	for _, c := range cases {
		if got := normalizeDirPrefix(c.in); got != c.want {
			t.Errorf("normalizeDirPrefix(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// 尾部斜杠缺失的后果：删除 a/b 时不能命中兄弟目录 a/bak/ 下的对象。
// 这条用前缀匹配直接断言语义，比断言字符串更贴近真实风险。
func TestNormalizeDirPrefix_IsolatesSiblingPrefixes(t *testing.T) {
	target := normalizeDirPrefix("a/b")
	sibling := normalizeDirPrefix("a/bak")

	if strings.HasPrefix("a/bak/x.txt", target) {
		t.Errorf("删除 a/b 的前缀 %q 不应匹配兄弟目录下的 key a/bak/x.txt", target)
	}
	if !strings.HasPrefix("a/bak/x.txt", sibling) {
		t.Errorf("兄弟目录前缀 %q 应匹配 a/bak/x.txt", sibling)
	}
}

func TestSanitizeFilename_IllegalChars(t *testing.T) {
	cases := []struct{ in, want string }{
		{`a/b\c.txt`, "a_b_c.txt"},
		{`a:b*c?d"e<f>g|h.txt`, "a_b_c_d_e_f_g_h.txt"},
		{"正常文件名.txt", "正常文件名.txt"},
	}
	for _, c := range cases {
		if got := sanitizeFilename(c.in); got != c.want {
			t.Errorf("sanitizeFilename(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// Windows 保留设备名：命中时必须加前缀，否则 os.Create 直接失败。
func TestSanitizeFilename_WindowsReservedNames(t *testing.T) {
	cases := []struct{ in, want string }{
		{"CON", "_CON"},
		{"con", "_con"},         // 大小写不敏感
		{"CON.txt", "_CON.txt"}, // 带扩展名同样命中
		{"nul", "_nul"},
		{"PRN", "_PRN"},
		{"AUX", "_AUX"},
		{"COM1", "_COM1"},
		{"com9.log", "_com9.log"},
		{"LPT1", "_LPT1"},
		{"lpt9", "_lpt9"},
	}
	for _, c := range cases {
		if got := sanitizeFilename(c.in); got != c.want {
			t.Errorf("sanitizeFilename(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// 边界：COM0 / COM10 不是保留名；带空格的 "CON " 应先被 trim 再判定。
func TestSanitizeFilename_ReservedNameBoundaries(t *testing.T) {
	cases := []struct{ in, want string }{
		{"COM0.txt", "COM0.txt"},   // 只有 COM1-9
		{"COM10.txt", "COM10.txt"}, // COM10 不是保留名
		{"CON ", "_CON"},           // 尾部空格：先 trim 再判定
		{"CON.", "_CON"},           // 尾部点：先 trim 再判定
		{"CONSOLID.txt", "CONSOLID.txt"},
	}
	for _, c := range cases {
		if got := sanitizeFilename(c.in); got != c.want {
			t.Errorf("sanitizeFilename(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// 净化后的名字必须真的能在 Windows 上创建（至少不触碰保留名）。
// 这里不实际建文件，只断言所有产出均非保留名。
func TestSanitizeFilename_NeverReturnsReservedOrEmpty(t *testing.T) {
	inputs := []string{"", "   ", ".", "..", "CON", "NUL.txt", "/", "\\", "...", "COM1"}
	for _, in := range inputs {
		got := sanitizeFilename(in)
		if got == "" {
			t.Errorf("sanitizeFilename(%q) 返回空名", in)
			continue
		}
		base := got
		if i := strings.LastIndex(got, "."); i > 0 {
			base = got[:i]
		}
		if isWindowsReservedName(base) {
			t.Errorf("sanitizeFilename(%q) = %q 仍是保留名", in, got)
		}
	}
}

func TestUniquePath_AvoidsOverwrite(t *testing.T) {
	dir := t.TempDir()

	// 目标不存在时直接返回原名
	if got := uniquePath(dir, "a.txt"); got != filepath.Join(dir, "a.txt") {
		t.Fatalf("首次应返回原名, got %q", got)
	}

	// 已存在则应递增后缀，且新旧文件都在（不覆盖原文件）
	first := filepath.Join(dir, "b.txt")
	if e := os.WriteFile(first, []byte("old"), 0o644); e != nil {
		t.Fatal(e)
	}
	second := uniquePath(dir, "b.txt")
	if second == first {
		t.Fatalf("已存在时应返回新路径, 但返回了 %q", second)
	}
	if got, want := filepath.Base(second), "b_1.txt"; got != want {
		t.Errorf("后缀名 = %q, want %q", got, want)
	}
	data, e := os.ReadFile(first)
	if e != nil || string(data) != "old" {
		t.Errorf("原文件应保持不变, got %q err %v", data, e)
	}

	// 无扩展名的文件也应正确递增
	noExt := filepath.Join(dir, "c")
	_ = os.WriteFile(noExt, []byte("old"), 0o644)
	if got, want := filepath.Base(uniquePath(dir, "c")), "c_1"; got != want {
		t.Errorf("无扩展名后缀 = %q, want %q", got, want)
	}
}

func TestGuessMime(t *testing.T) {
	cases := []struct{ in, want string }{
		{"a.txt", "text/plain"},
		{"a.json", "application/json"},
		{"a.png", "image/png"},
		{"a.PDF", "application/pdf"},
		{"a.unknown", "application/octet-stream"},
	}
	for _, c := range cases {
		if got := guessMime(c.in); got != c.want {
			t.Errorf("guessMime(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
