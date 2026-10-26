package main

// picker.go — app/pick_dir：从 sidecar 弹出系统原生「选择目录」对话框。
//
// 为什么在 sidecar 做：沙箱 webview 里没有可用的目录选择 API
// （showDirectoryPicker 在 opaque origin 下不可用），宿主桥接的
// fileTransfer 只提供单文件保存对话框（beginSave）。sidecar 是宿主 GUI
// 的用户态子进程，具备弹出交互对话框的桌面会话条件。
//
// 两个关键坑（都已处理）：
//  1. 置顶：PowerShell 子进程的对话框没有窗口归属（owner），会被宿主
//     窗口盖住，看起来像「点了没反应」。用不可见 TopMost owner Form +
//     ShowDialog($owner) 强制置顶。
//  2. 误判选中：FolderBrowserDialog 点取消时 SelectedPath 会保留之前
//     设置的初始值。必须只在 DialogResult==OK 时才输出路径，否则
//     「取消」会被当成「选了旧目录」直接开跑。
//
// Windows 冷启动：PowerShell 加载 WinForms 约 2–3 秒，因此用「常驻
// 进程」：首次连接后预热一个隐藏 PowerShell（循环读 stdin，每行一个
// 初始目录即弹一次对话框、回写一行结果），后续弹窗毫秒级。sidecar 退出
// 时 stdin 管道关闭，脚本读到 null 自动退出；常驻失败回退一次性调用。
// macOS: osascript choose folder；Linux: zenity（回退 kdialog）。
//
// 安全：返回路径仅作为 objects/save 的 downloadDir 候选。前端把「来自
// 原生对话框」的目录带上 picked 标记，resolveDownloadDir 据此放宽落盘
// 白名单；手输路径仍受白名单约束。路径一律 Abs + Clean + EvalSymlinks。

import (
	"bufio"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"unicode/utf16"
)

type PickDirParams struct {
	InitialDir string `json:"initialDir"`
}

func handleAppPickDir(params json.RawMessage) (interface{}, *RPCError) {
	var p PickDirParams
	if len(params) > 0 {
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, &RPCError{Code: -32602, Message: "invalid params"}
		}
	}
	path, cancelled, e := pickDirNative(strings.TrimSpace(p.InitialDir))
	if e != nil {
		return nil, &RPCError{Code: -32000, Message: "无法打开目录选择对话框: " + e.Error()}
	}
	if cancelled {
		return map[string]interface{}{"cancelled": true, "path": ""}, nil
	}
	return map[string]interface{}{"cancelled": false, "path": path}, nil
}

func pickDirNative(initial string) (path string, cancelled bool, err error) {
	switch runtime.GOOS {
	case "windows":
		return pickDirWindows(initial)
	case "darwin":
		return pickDirDarwin(initial)
	default:
		return pickDirLinux(initial)
	}
}

// warmPicker 连接成功后预热 Windows 常驻选择器进程（fire-and-forget）：
// 让用户点「批量下载」时对话框即点即出，而不是等 2–3 秒冷启动。
func warmPicker() {
	if runtime.GOOS != "windows" {
		return
	}
	go func() {
		defer func() { _ = recover() }() // 预热失败静默：点击时还有一次性回退
		_ = winPick.ensure()
	}()
}

// ---------- Windows：常驻 PowerShell 选择器（失败回退一次性调用） ----------

// winPickerScript 循环：每行一个初始目录 → 弹对话框 → 回写一行结果。
// 置顶要点：owner 窗口必须「真实显示」（1×1 像素、屏幕外坐标）才能参与
// z-order——只设 TopMost 不 Show 的隐藏窗口锚定无效，首次点击（宿主持有
// 前台焦点时）对话框仍会被压在后面。Show + Activate 抢到前台后再挂模态
// 对话框，即可保证置顶。只认 DialogResult==OK 解决「取消被误判为选中
// 旧目录」。
// winWin32Ps 声明 user32/kernel32 P/Invoke（一次性编译，常驻进程在
// DBX_READY 前完成，one-shot 在弹窗前完成）。
const winWin32Ps = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class DBXWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr ProcessId);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
}
'@
`

// winFgPs 每次弹窗前强抢前台：后台启动的 PowerShell 受 Windows 前台锁
// 约束，Activate/SetForegroundWindow 直接调会被拒（任务栏闪一下而已）。
// AttachThreadInput 把自己的 UI 线程临时挂到前台窗口（宿主 GUI）的输入
// 线程上，即可合法拿到前台权。owner 是屏幕外 1×1 窗口，用户不可见。
const winFgPs = `
$owner.Show()
try {
  $owner.Activate()
  $fg = [DBXWin]::GetForegroundWindow()
  if ($fg -ne [IntPtr]::Zero) {
    $fgThread = [DBXWin]::GetWindowThreadProcessId($fg, [IntPtr]::Zero)
    $myThread = [DBXWin]::GetCurrentThreadId()
    if ($fgThread -ne 0 -and $fgThread -ne $myThread) {
      $null = [DBXWin]::AttachThreadInput($myThread, $fgThread, $true)
      $null = [DBXWin]::SetForegroundWindow($owner.Handle)
      $null = [DBXWin]::AttachThreadInput($myThread, $fgThread, $false)
    }
  }
} catch { }
[System.Windows.Forms.Application]::DoEvents()
`

// winPickerScript 循环：每行一个初始目录 → 弹对话框 → 回写一行结果。
// 置顶链路：屏幕外 1×1 可见 owner → AttachThreadInput 抢前台 → 模态
// 对话框挂其上。只认 DialogResult==OK 解决「取消被误判为选中旧目录」。
const winPickerScript = `Add-Type -AssemblyName System.Windows.Forms | Out-Null
` + winWin32Ps + `
[Console]::Out.WriteLine('DBX_READY')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $fbd = New-Object System.Windows.Forms.FolderBrowserDialog
  $fbd.ShowNewFolderButton = $true
  if ($line -and (Test-Path $line)) { $fbd.SelectedPath = $line }
  $owner = New-Object System.Windows.Forms.Form
  $owner.TopMost = $true
  $owner.ShowInTaskbar = $false
  $owner.StartPosition = 'Manual'
  $null = $owner.SetBounds(-2000, -2000, 1, 1)
` + winFgPs + `
  $ok = $fbd.ShowDialog($owner)
  $owner.Close()
  $owner.Dispose()
  if ($ok -eq [System.Windows.Forms.DialogResult]::OK -and $fbd.SelectedPath -and (Test-Path $fbd.SelectedPath)) {
    [Console]::Out.WriteLine($fbd.SelectedPath)
  } else {
    [Console]::Out.WriteLine('DBX_CANCEL')
  }
}
`

type residentPicker struct {
	mu     sync.Mutex
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout *bufio.Reader
}

var winPick = &residentPicker{}

// winEncodedCommand 把脚本编码成 PowerShell -EncodedCommand 要求的
// UTF-16LE base64（避免引号/换行拼进命令行）。
func winEncodedCommand(script string) string {
	u16 := utf16.Encode([]rune(script))
	b := make([]byte, len(u16)*2)
	for i, v := range u16 {
		binary.LittleEndian.PutUint16(b[i*2:], v)
	}
	return base64.StdEncoding.EncodeToString(b)
}

// ensure 拉起常驻 PowerShell 并等到 'DBX_READY'（程序集已加载）。
// 调用方须持有 mu。
func (r *residentPicker) ensure() error {
	if r.cmd != nil && r.cmd.Process != nil {
		return nil
	}
	cmd := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-STA",
		"-EncodedCommand", winEncodedCommand(winPickerScript))
	stdin, e := cmd.StdinPipe()
	if e != nil {
		return e
	}
	stdout, e := cmd.StdoutPipe()
	if e != nil {
		return e
	}
	cmd.Stderr = io.Discard
	if e := cmd.Start(); e != nil {
		return e
	}
	reader := bufio.NewReader(stdout)
	line, e := reader.ReadString('\n')
	if e != nil || !strings.Contains(line, "DBX_READY") {
		_ = cmd.Process.Kill()
		if e == nil {
			e = fmt.Errorf("选择器进程未就绪")
		}
		return e
	}
	r.cmd = cmd
	r.stdin = stdin
	r.stdout = reader
	return nil
}

func (r *residentPicker) killLocked() {
	if r.cmd != nil && r.cmd.Process != nil {
		_ = r.cmd.Process.Kill()
	}
	r.cmd = nil
	r.stdin = nil
	r.stdout = nil
}

// pick 经常驻进程弹一次对话框。串行（mu）：对话框本身是模态的，
// 并发请求排队等待符合直觉。
func (r *residentPicker) pick(initial string) (string, bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if e := r.ensure(); e != nil {
		return "", false, e
	}
	if _, e := r.stdin.Write([]byte(initial + "\n")); e != nil {
		r.killLocked()
		return "", false, e
	}
	line, err := r.stdout.ReadString('\n')
	if err != nil {
		r.killLocked() // 进程死了：下次重新拉起
		return "", false, err
	}
	line = strings.TrimSpace(line)
	if line == "" || line == "DBX_CANCEL" {
		return "", true, nil
	}
	return line, false, nil
}

// pickDirWindows 优先走常驻进程（毫秒级）；任何失败回退一次性调用
//（慢 2–3 秒但可靠），再失败由前端落到手输兜底。
func pickDirWindows(initial string) (string, bool, error) {
	if path, cancelled, err := winPick.pick(initial); err == nil {
		return path, cancelled, nil
	}
	return pickDirWindowsOneShot(initial)
}

// winOneShotScript 一次性调用脚本（仅作常驻进程失败时的回退）。初始目录
// 经环境变量传入（而非拼进脚本字符串），避免路径里的引号/特殊字符构成注入面。
const winOneShotScript = `Add-Type -AssemblyName System.Windows.Forms | Out-Null
` + winWin32Ps + `
$fbd = New-Object System.Windows.Forms.FolderBrowserDialog
$fbd.ShowNewFolderButton = $true
$init = [Environment]::GetEnvironmentVariable('DBX_PICK_INIT')
if ($init -and (Test-Path $init)) { $fbd.SelectedPath = $init }
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.StartPosition = 'Manual'
$null = $owner.SetBounds(-2000, -2000, 1, 1)
` + winFgPs + `
$ok = $fbd.ShowDialog($owner)
$owner.Close()
$owner.Dispose()
if ($ok -eq [System.Windows.Forms.DialogResult]::OK -and $fbd.SelectedPath -and (Test-Path $fbd.SelectedPath)) { Write-Output $fbd.SelectedPath }
`

// pickDirWindowsOneShot 一次性调用：每次新起 PowerShell（冷启动 2–3 秒）。
func pickDirWindowsOneShot(initial string) (string, bool, error) {
	cmd := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-STA", "-Command", winOneShotScript)
	cmd.Env = append(os.Environ(), "DBX_PICK_INIT="+initial)
	out, err := cmd.Output()
	if err != nil {
		return "", false, fmt.Errorf("powershell 执行失败: %w", err)
	}
	path := strings.TrimSpace(string(out))
	if path == "" {
		return "", true, nil // 用户点了取消
	}
	return path, false, nil
}

// ---------- macOS / Linux ----------

// pickDirDarwin 用 osascript choose folder；用户取消（错误 -128）不算失败。
func pickDirDarwin(initial string) (string, bool, error) {
	script := `POSIX path of (choose folder)`
	if initial != "" {
		script = fmt.Sprintf(`POSIX path of (choose folder default location POSIX file %q)`, initial)
	}
	cmd := exec.Command("osascript", "-e", script)
	out, err := cmd.Output()
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok && strings.Contains(string(ee.Stderr), "User canceled") {
			return "", true, nil
		}
		return "", false, err
	}
	return strings.TrimSpace(string(out)), false, nil
}

// pickDirLinux 优先 zenity，回退 kdialog；都没有则报错（前端会退回手输路径）。
func pickDirLinux(initial string) (string, bool, error) {
	if _, e := exec.LookPath("zenity"); e == nil {
		args := []string{"--file-selection", "--directory", "--title=选择下载目录"}
		if initial != "" {
			args = append(args, "--filename="+initial)
		}
		out, err := exec.Command("zenity", args...).Output()
		if err != nil {
			if ee, ok := err.(*exec.ExitError); ok && ee.ExitCode() == 1 {
				return "", true, nil // 用户取消
			}
			return "", false, err
		}
		return strings.TrimSpace(string(out)), false, nil
	}
	if _, e := exec.LookPath("kdialog"); e == nil {
		start := initial
		if start == "" {
			start, _ = os.UserHomeDir()
		}
		out, err := exec.Command("kdialog", "--getexistingdirectory", start).Output()
		if err != nil {
			if ee, ok := err.(*exec.ExitError); ok && ee.ExitCode() == 1 {
				return "", true, nil
			}
			return "", false, err
		}
		return strings.TrimSpace(string(out)), false, nil
	}
	return "", false, fmt.Errorf("未找到 zenity 或 kdialog")
}
