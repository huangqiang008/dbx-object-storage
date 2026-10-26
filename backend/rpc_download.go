package main

// rpc_download.go — objects/save 下载落盘 RPC handler 与路径安全校验。

import (
	"encoding/json"
	"fmt"
	"hash/fnv"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// ---------- objects/save（下载到本机） ----------
// 沙箱 webview 的 <a download> 与 window.open 会被静默拦截，前端无法直接落盘。
// 因此下载交由宿主机上的 Sidecar 进程：从对象存储流式读取对象并写入本机 Downloads 目录，
// 返回绝对路径，由前端弹窗展示 + 复制路径。支持任意大小（流式写入，不占内存）。
type SaveParams struct {
	Bucket      string `json:"bucket"`
	Path        string `json:"path"`
	DownloadDir string `json:"downloadDir"` // 可选：自定义落盘目录
	// Picked 目录是否来自系统原生选择对话框（app/pick_dir）。OS 对话框确认的
	// 目录不存在 free-text 误输/「../」逃逸风险，resolveDownloadDir 据此放宽
	// 落盘白名单；手输路径（picked=false）仍限制在主目录/系统临时目录内。
	Picked bool `json:"picked"`
	// RelPath 相对落盘路径（可选，1.1）。
	//
	// 为空 = 旧行为：只取 key 的最后一段作文件名，拍平落盘。
	// 非空 = 按给定相对路径落盘，自动建子目录，保留对象存储的目录层级。
	//
	// 为什么需要：上传方向保留层级（webkitRelativePath），下载方向却拍平，
	// 往返一趟结构就散了；且不同前缀下的同名对象拍平后会互相改名
	// （c.txt / c_1.txt），原始结构信息彻底丢失。
	RelPath string `json:"relPath"`
}

// resolveDownloadDir 解析并校验下载落盘目录。
//
// 安全背景：downloadDir 由前端直传，若完全不校验，本插件就等价于一个
// 「任意路径写文件」的能力——且 MkdirAll 会连带创建整条路径，
// 可写到系统目录或用户敏感位置。因此手输路径（picked=false）限制在
// 用户主目录（含子目录）与系统临时目录内，其余一律拒绝。
//
// picked=true 表示目录来自系统原生目录对话框（app/pick_dir）：用户在
// OS 级 UI 里显式确认的选择，不存在误输与「../」逃逸，不再套白名单，
// 否则用户选了主目录之外的盘/目录会被无理拒绝。路径仍统一做
// Abs + Clean + EvalSymlinks 规范化。
//
// 注意：这只是纵深防御。即便做了校验，插件仍应按最小权限运行
// （能用 host.storage 的原生保存对话框时优先用它，见前端 downloadViaHost）。
func resolveDownloadDir(requested string, picked bool) (string, *RPCError) {
	dir := strings.TrimSpace(requested)

	if dir == "" {
		// 未指定：默认 ~/Downloads，取不到主目录则退回系统临时目录
		if home, e := os.UserHomeDir(); e == nil && home != "" {
			dir = filepath.Join(home, "Downloads")
		} else {
			dir = os.TempDir()
		}
	}

	// 统一成绝对路径并解析符号链接后再比对，防止用 .. 或链接跳出白名单。
	// 注意 filepath.Clean 只做词法消解，对已存在的路径应配合 EvalSymlinks。
	abs, e := filepath.Abs(dir)
	if e != nil {
		return "", &RPCError{Code: -32602, Message: "下载目录无效: " + e.Error()}
	}
	abs = filepath.Clean(abs)
	if resolved, e := filepath.EvalSymlinks(abs); e == nil {
		abs = resolved
	}

	if !picked && !isDirWithinAllowedRoots(abs) {
		return "", &RPCError{
			Code:    -32602,
			Message: "下载目录不在允许范围内：" + abs + "。请选择用户主目录或系统临时目录下的位置。",
		}
	}
	return abs, nil
}

// allowedRoots 计算下载落盘的允许根目录：用户主目录 + 系统临时目录。
// 取不到主目录时只用临时目录，不放宽。
func allowedRoots() []string {
	roots := make([]string, 0, 2)
	if home, e := os.UserHomeDir(); e == nil && home != "" {
		if abs, e := filepath.Abs(home); e == nil {
			roots = append(roots, filepath.Clean(abs))
		}
	}
	// 临时目录的子目录是合法的（下载通常落在某个子文件夹里）
	if tmp := os.TempDir(); tmp != "" {
		if abs, e := filepath.Abs(tmp); e == nil {
			roots = append(roots, filepath.Clean(abs))
		}
	}
	return roots
}

// isDirWithinAllowedRoots 判断 abs 是否位于任一允许根目录之内。
// 用 filepath.Rel 而非 HasPrefix：后者会把 "C:\Users\abcDownloads"
// 这类同前缀兄弟目录误判为在 "C:\Users\abc" 之内。
func isDirWithinAllowedRoots(abs string) bool {
	for _, root := range allowedRoots() {
		if root == "" {
			continue
		}
		rel, e := filepath.Rel(root, abs)
		if e != nil {
			continue // 不同盘符等无法比较的情况，按不允许处理
		}
		if rel == "." || (!strings.HasPrefix(rel, ".."+string(filepath.Separator)) && rel != "..") {
			return true
		}
	}
	return false
}

// resolveRelPath 解析相对落盘路径（1.1），返回「子目录 + 文件名」两部分。
//
// relPath 由前端直传，必须严防路径逃逸：
//   - 绝对路径（/foo、C:\foo）直接拒绝
//   - 含 ".." 的层级直接拒绝
//   - 每段单独净化（非法字符替换、Windows 保留名加前缀）
//   - 空段（//）与 "." 段跳过
//
// 返回的子目录已保证不逃出 root（因为每段都净化过且不含 ..），
// 文件名已净化为合法本机文件名。
func resolveRelPath(root, relPath string) (subDir, fileName string, err error) {
	relPath = strings.TrimSpace(relPath)
	if relPath == "" {
		return "", "", nil
	}
	// 统一分隔符：前端可能传 "/"（对象 key 风格），Windows 上也需识别
	relPath = strings.ReplaceAll(relPath, "\\", "/")
	if strings.HasPrefix(relPath, "/") {
		return "", "", fmt.Errorf("相对路径不能是绝对路径")
	}
	// Windows 盘符形式（如 C:/foo）。
	// 必须是「单字母 + 冒号 + 斜杠或结尾」才算盘符——否则 "a:b.txt"
	// 这类含冒号的合法文件名会被误判为绝对路径。
	if len(relPath) >= 2 && relPath[1] == ':' &&
		(relPath[2] == '/' || len(relPath) == 2) {
		return "", "", fmt.Errorf("相对路径不能是绝对路径")
	}
	parts := strings.Split(relPath, "/")
	clean := make([]string, 0, len(parts))
	for _, p := range parts {
		if p == "" || p == "." {
			continue // 空段与 "." 段跳过
		}
		if p == ".." {
			return "", "", fmt.Errorf("相对路径不能包含 ..")
		}
		clean = append(clean, sanitizeFilename(p))
	}
	if len(clean) == 0 {
		return "", "", nil
	}
	fileName = clean[len(clean)-1]
	if len(clean) > 1 {
		subDir = filepath.Join(clean[:len(clean)-1]...)
	}
	return subDir, fileName, nil
}

// dlMeta 断点续传元数据：与 .part 分片文件同名的 .json。
type dlMeta struct {
	Bucket string `json:"bucket"`
	Key    string `json:"key"`
	ETag   string `json:"etag"`
	Size   int64  `json:"size"`
	Dst    string `json:"dst"`
}

// dlStem 断点分片文件的稳定主干：<base>-<fnv32a(bucket|key) 前 8 位>。
// 用 bucket+key 派生（而不是 etag/size——那得先发一次请求），重试同一路径时
// 天然命中同一个 .part；对象内容是否变化由元数据里的 etag/size 校验兜底。
func dlStem(bucket, key, base string) string {
	h := fnv.New32a()
	h.Write([]byte(bucket))
	h.Write([]byte{0})
	h.Write([]byte(key))
	return fmt.Sprintf("%s-%08x", base, h.Sum32())
}

// writeDlMeta 落盘断点元数据；失败仅忽略（无元数据时续传退化为整段重下）。
func writeDlMeta(path string, m dlMeta) {
	bb, e := json.Marshal(m)
	if e != nil {
		return
	}
	_ = os.WriteFile(path, bb, 0o644)
}

func handleObjectSave(params json.RawMessage) (interface{}, *RPCError) {
	var p SaveParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, &RPCError{Code: -32602, Message: "invalid params"}
	}
	d, rerr := getDriver()
	if rerr != nil {
		return nil, rerr
	}

	dir, rerr := resolveDownloadDir(p.DownloadDir, p.Picked)
	if rerr != nil {
		return nil, rerr
	}
	if e := os.MkdirAll(dir, 0o755); e != nil {
		return nil, &RPCError{Code: -32000, Message: "创建下载目录失败: " + e.Error()}
	}

	// 落盘路径解析（1.1）：
	//   - 传了 relPath：按相对路径落盘到子目录，保留对象存储的目录层级
	//   - 未传 relPath：旧行为，取 key 最后一段拍平落盘
	subDir, base, err := resolveRelPath(dir, p.RelPath)
	if err != nil {
		return nil, &RPCError{Code: -32602, Message: "无效的相对路径: " + err.Error()}
	}
	if subDir != "" {
		full := filepath.Join(dir, subDir)
		if e := os.MkdirAll(full, 0o755); e != nil {
			return nil, &RPCError{Code: -32000, Message: "创建子目录失败: " + e.Error()}
		}
		dir = full
	}
	if base == "" {
		// relPath 为空或全被过滤 → 退回按 key 最后一段
		base = filepath.Base(p.Path)
		if base == "" || base == "." || base == "/" || base == "\\" {
			base = "download"
		}
		base = sanitizeFilename(base)
	}

	// 避免覆盖同名文件：存在则追加 _1 / _2 …（最终名只在完整下载成功后才落盘）
	dst := uniquePath(dir, base)

	// ---------- 断点续传 ----------
	// 下载中断会留下 <.stem>.part 与 <.stem>.part.json 元数据。重试同一路径时：
	// bucket/key 匹配且 etag/size 未变 → 从 .part 已有字节数起 Range 续传（追加写）；
	// 对象已变化或元数据缺失 → 截断重来。完整成功后 rename 为最终文件名并清理元数据。
	// 并发安全：前端不会并发下载同一对象（同一 .part 名），此处不加锁。
	meta, se := d.Stat(p.Bucket, p.Path)
	var total int64
	var etag string
	if se == nil {
		total, etag = meta.Size, meta.ETag
	}

	stem := dlStem(p.Bucket, p.Path, base)
	partPath := filepath.Join(dir, "."+stem+".part")
	metaPath := partPath + ".json"

	var rd io.ReadCloser
	var out *os.File
	var offset int64
	resumed := false

	if total > 0 {
		if fi, e := os.Stat(partPath); e == nil && fi.Size() > 0 && fi.Size() <= total {
			var m dlMeta
			if bb, e := os.ReadFile(metaPath); e == nil && json.Unmarshal(bb, &m) == nil &&
				m.Bucket == p.Bucket && m.Key == p.Path &&
				(m.ETag == "" || etag == "" || m.ETag == etag) {
				if fi.Size() == total {
					// 断点已齐：无需再传，直接转正
					if e := os.Rename(partPath, dst); e == nil {
						os.Remove(metaPath)
						return map[string]interface{}{
							"path": filepath.ToSlash(dst), "size": total, "resumed": true,
						}, nil
					}
					// rename 失败（极罕见）：当作全新下载重来
				} else if _, r, oe := d.OpenRange(p.Bucket, p.Path, fi.Size(), total-fi.Size()); oe == nil {
					if o2, oe2 := os.OpenFile(partPath, os.O_APPEND|os.O_WRONLY, 0o644); oe2 == nil {
						rd, out, offset, resumed = r, o2, fi.Size(), true
					} else {
						r.Close()
					}
				}
			}
		}
	}

	if rd == nil {
		var e error
		rd, e = d.OpenStream(p.Bucket, p.Path)
		if e != nil {
			return nil, &RPCError{Code: -32000, Message: "读取对象失败: " + e.Error()}
		}
		out, e = os.Create(partPath) // 新建或截断重来
		if e != nil {
			rd.Close()
			return nil, &RPCError{Code: -32000, Message: "创建文件失败: " + e.Error()}
		}
	}
	// 元数据在拷贝前落盘：即使本次中断，下次也能命中续传
	writeDlMeta(metaPath, dlMeta{Bucket: p.Bucket, Key: p.Path, ETag: etag, Size: total, Dst: dst})

	n, e := io.Copy(out, rd)
	rd.Close()
	out.Close()
	if e != nil {
		// 保留 .part 与元数据，重试同一对象即续传
		var msg string
		if total > 0 {
			msg = fmt.Sprintf("下载中断（断点已保留 %d/%d 字节，重试可续传）: %s", offset+n, total, e.Error())
		} else {
			msg = fmt.Sprintf("下载中断（断点已保留，重试可续传）: %s", e.Error())
		}
		return nil, &RPCError{Code: -32000, Message: msg}
	}

	// 转正：下载期间同目录可能新增了同名文件（Windows 的 rename 不允许覆盖），
	// 必要时重取唯一名
	if _, e := os.Stat(dst); e == nil {
		dst = uniquePath(dir, base)
	}
	if e := os.Rename(partPath, dst); e != nil {
		return nil, &RPCError{Code: -32000, Message: "保存文件失败: " + e.Error()}
	}
	os.Remove(metaPath)
	return map[string]interface{}{
		"path":    filepath.ToSlash(dst),
		"size":    offset + n,
		"resumed": resumed,
	}, nil
}

// uniquePath 若 dir/base 已存在则递增后缀返回新路径
func uniquePath(dir, base string) string {
	dst := filepath.Join(dir, base)
	if _, e := os.Stat(dst); os.IsNotExist(e) {
		return dst
	}
	ext := filepath.Ext(base)
	nameOnly := strings.TrimSuffix(base, ext)
	for i := 1; ; i++ {
		cand := filepath.Join(dir, fmt.Sprintf("%s_%d%s", nameOnly, i, ext))
		if _, e := os.Stat(cand); os.IsNotExist(e) {
			return cand
		}
	}
}

// sanitizeFilename 替换各平台文件名非法字符
// sanitizeFilename 净化对象 key 的最后一段，使其可安全作为本机文件名。
// 除非法字符外，还必须处理 Windows 保留设备名：CON / PRN / AUX / NUL / COM1-9 /
// LPT1-9。这些名字即便带扩展名（如 CON.txt）在 Windows 上也无法创建，
// os.Create 会直接失败，因此命中时统一加 "_" 前缀。
func sanitizeFilename(name string) string {
	r := strings.NewReplacer("/", "_", "\\", "_", ":", "_", "*", "_", "?", "_", "\"", "_", "<", "_", ">", "_", "|", "_")
	out := r.Replace(name)
	// 去掉尾部空格与点：Windows 会静默丢弃，导致后续 uniquePath 的存在性判断失准
	out = strings.TrimRight(out, " .")
	if out == "" {
		return "download"
	}
	// 保留名判定只看去扩展名的部分（大小写不敏感），"CON" 与 "CON.txt" 同样命中。
	base := out
	if i := strings.LastIndex(out, "."); i > 0 {
		base = out[:i]
	}
	if isWindowsReservedName(base) {
		return "_" + out
	}
	return out
}

// windowsReservedNames Windows 保留设备名（含扩展控制台设备的历史遗留名）。
var windowsReservedNames = map[string]bool{
	"CON": true, "PRN": true, "AUX": true, "NUL": true,
	"COM1": true, "COM2": true, "COM3": true, "COM4": true, "COM5": true,
	"COM6": true, "COM7": true, "COM8": true, "COM9": true,
	"LPT1": true, "LPT2": true, "LPT3": true, "LPT4": true, "LPT5": true,
	"LPT6": true, "LPT7": true, "LPT8": true, "LPT9": true,
}

// isWindowsReservedName 判断 name（已去扩展名）是否为 Windows 保留设备名。
func isWindowsReservedName(name string) bool {
	return windowsReservedNames[strings.ToUpper(strings.TrimSpace(name))]
}
