package main

// oss.go — RPC handler 层。
// 只面向 StorageDriver 接口，不含任何厂商 SDK 类型；连接参数解析与驱动工厂见 driver.go。

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
)

const pluginVersion = "0.4.1"

// pluginID 必须与 manifest.json 的 id 完全一致，
// dev 宿主会在 plugin/initialize 回包中校验 info.plugin.id/version。
// v0.2.0 起由 com.aliyun.oss.browser 改为通用 ID（阿里云 OSS / MinIO / S3 兼容）。
const pluginID = "com.object.browser"

// handleInitialize 对应 DBX 宿主在 sidecar 启动后下发的 plugin/initialize。
// 回包形状必须严格匹配 sidecar 协议 v1（参考官方 dbx-plugin-sdk 的 initialize）：
//   - protocolVersion: 数字
//   - capabilities:    字符串数组（sequence），不是对象（map）
//   - plugin:          { id, version }
// 注意：官方回包不含 serverInfo 字段；真实 Rust 客户端对回包做严格解码，
// 多写非协议字段或把 capabilities 写成对象都会导致 "invalid type" 解码失败。
func handleInitialize(params json.RawMessage) (interface{}, *RPCError) {
	return map[string]interface{}{
		"protocolVersion": 1,
		"capabilities":    []string{"connections", "events"},
		"plugin": map[string]string{
			"id":      pluginID,
			"version": pluginVersion,
		},
	}, nil
}

// getDriver 取当前已连接的驱动实例（并发安全）。
func getDriver() (StorageDriver, *RPCError) {
	stateMu.Lock()
	d := state.driver
	stateMu.Unlock()
	if d == nil {
		return nil, &RPCError{Code: -32000, Message: "未连接"}
	}
	return d, nil
}

func handleConnectionTest(params json.RawMessage) (interface{}, *RPCError) {
	c, err := parseConn(params)
	if err != nil {
		return nil, err
	}
	d, e := newDriver(c)
	if e != nil {
		return nil, &RPCError{Code: -32000, Message: "连接失败: " + e.Error()}
	}
	if c.Bucket != "" {
		if _, e = d.ListObjects(ListReq{Bucket: c.Bucket, MaxKeys: 1}); e != nil {
			return nil, &RPCError{Code: -32000, Message: "列举失败: " + e.Error()}
		}
	} else {
		if _, e = d.ListBuckets(); e != nil {
			return nil, &RPCError{Code: -32000, Message: "列举存储桶失败: " + e.Error()}
		}
	}
	return map[string]interface{}{"ok": true, "message": "连接测试成功"}, nil
}

func handleConnectionConnect(params json.RawMessage) (interface{}, *RPCError) {
	c, err := parseConn(params)
	if err != nil {
		return nil, err
	}
	d, e := newDriver(c)
	if e != nil {
		return nil, &RPCError{Code: -32000, Message: "连接失败: " + e.Error()}
	}
	stateMu.Lock()
	state.cfg = c
	state.driver = d
	stateMu.Unlock()
	return map[string]interface{}{"ok": true, "message": "连接成功"}, nil
}

func handleConnectionDisconnect(params json.RawMessage) (interface{}, *RPCError) {
	stateMu.Lock()
	state.cfg = ConnConfig{}
	state.driver = nil
	stateMu.Unlock()
	return map[string]interface{}{"ok": true}, nil
}

// handleConnectionStatus：UI 启动时询问 Sidecar 当前是否已连接。
// 宿主打开已保存连接时会先调 connection/connect（凭据已在 Sidecar 内存中），
// UI 据此跳过凭据表单直接进入浏览视图，避免重复填写 Key。
func handleConnectionStatus(params json.RawMessage) (interface{}, *RPCError) {
	stateMu.Lock()
	cfg := state.cfg
	ok := state.driver != nil
	stateMu.Unlock()
	if !ok {
		return map[string]interface{}{"connected": false}, nil
	}
	return map[string]interface{}{
		"connected": true,
		"provider":  cfg.Provider,
		"endpoint":  cfg.Endpoint,
		"bucket":    cfg.Bucket,
		"name":      cfg.Name,
	}, nil
}

// ---------- buckets/list（根目录列出全部存储桶） ----------

func handleBucketsList(params json.RawMessage) (interface{}, *RPCError) {
	d, rerr := getDriver()
	if rerr != nil {
		return nil, rerr
	}
	bs, e := d.ListBuckets()
	if e != nil {
		return nil, &RPCError{Code: -32000, Message: "列举存储桶失败: " + e.Error()}
	}
	items := []ListItem{}
	for _, b := range bs {
		items = append(items, ListItem{Name: b.Name, IsDir: true, Mime: "application/x-bucket"})
	}
	return map[string]interface{}{
		"items":        items,
		"is_truncated": false,
		"next_marker":  "",
	}, nil
}

// ---------- objects/list（核心分页能力） ----------

type ListParams struct {
	Bucket    string `json:"bucket"`
	Prefix    string `json:"prefix"`
	Delimiter string `json:"delimiter"`
	Marker    string `json:"marker"`
	MaxKeys   int    `json:"maxKeys"`
}

// handleObjectsList 通过 Delimiter 折叠子目录为公共前缀，
// 并通过不透明 token 做服务端分页，单页最多 maxKeys（默认 200，上限 1000），
// 从根本上避免大目录一次性加载失败。UI 层协议字段名保持 marker/next_marker 不变。
func handleObjectsList(params json.RawMessage) (interface{}, *RPCError) {
	var p ListParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, &RPCError{Code: -32602, Message: "invalid params"}
	}
	if p.Delimiter == "" {
		p.Delimiter = "/"
	}
	if p.MaxKeys <= 0 {
		p.MaxKeys = 200
	}
	if p.MaxKeys > 1000 {
		p.MaxKeys = 1000
	}

	d, rerr := getDriver()
	if rerr != nil {
		return nil, rerr
	}
	page, e := d.ListObjects(ListReq{
		Bucket:    p.Bucket,
		Prefix:    p.Prefix,
		Delimiter: p.Delimiter,
		Token:     p.Marker,
		MaxKeys:   p.MaxKeys,
	})
	if e != nil {
		return nil, &RPCError{Code: -32000, Message: "列举失败: " + e.Error()}
	}
	if page.Items == nil {
		page.Items = []ListItem{}
	}
	return map[string]interface{}{
		"items":        page.Items,
		"is_truncated": page.Truncated,
		"next_marker":  page.NextToken,
		"prefix":       p.Prefix,
		"delimiter":    p.Delimiter,
	}, nil
}

// ---------- objects/read ----------

type ReadParams struct {
	Bucket string `json:"bucket"`
	Path   string `json:"path"`
	Offset int64  `json:"offset"`
	Limit  int    `json:"limit"`
}

func handleObjectsRead(params json.RawMessage) (interface{}, *RPCError) {
	var p ReadParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, &RPCError{Code: -32602, Message: "invalid params"}
	}
	if p.Limit <= 0 {
		p.Limit = 256 * 1024
	}
	if p.Limit > 8*1024*1024 {
		p.Limit = 8 * 1024 * 1024
	}

	d, rerr := getDriver()
	if rerr != nil {
		return nil, rerr
	}
	meta, body, e := d.OpenRange(p.Bucket, p.Path, p.Offset, int64(p.Limit))
	if e != nil {
		return nil, &RPCError{Code: -32000, Message: "读取失败: " + e.Error()}
	}
	defer body.Close()
	data, e := io.ReadAll(body)
	if e != nil {
		return nil, &RPCError{Code: -32000, Message: "读取失败: " + e.Error()}
	}
	return map[string]interface{}{
		"content": base64.StdEncoding.EncodeToString(data),
		"mime":    meta.MIME,
		"size":    meta.Size,
	}, nil
}

// ---------- objects/write（上传） ----------

type WriteParams struct {
	Bucket  string `json:"bucket"`
	Path    string `json:"path"`
	Content string `json:"content"`
	Mime    string `json:"mime"`
}

func handleObjectsWrite(params json.RawMessage) (interface{}, *RPCError) {
	var p WriteParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, &RPCError{Code: -32602, Message: "invalid params"}
	}
	data, e := base64.StdEncoding.DecodeString(p.Content)
	if e != nil {
		return nil, &RPCError{Code: -32602, Message: "invalid base64 content"}
	}
	d, rerr := getDriver()
	if rerr != nil {
		return nil, rerr
	}
	if e := d.Put(p.Bucket, p.Path, bytes.NewReader(data), int64(len(data)), p.Mime); e != nil {
		return nil, &RPCError{Code: -32000, Message: "上传失败: " + e.Error()}
	}
	return map[string]interface{}{"ok": true}, nil
}

// ---------- objects/delete ----------

type DeleteParams struct {
	Bucket string `json:"bucket"`
	Path   string `json:"path"`
}

func handleObjectsDelete(params json.RawMessage) (interface{}, *RPCError) {
	var p DeleteParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, &RPCError{Code: -32602, Message: "invalid params"}
	}
	d, rerr := getDriver()
	if rerr != nil {
		return nil, rerr
	}
	if e := d.Delete(p.Bucket, p.Path); e != nil {
		return nil, &RPCError{Code: -32000, Message: "删除失败: " + e.Error()}
	}
	return map[string]interface{}{"ok": true}, nil
}

// ---------- objects/delete_batch（多选批量删除） ----------
// F3 多选批量：前端把选中的完整 key 列表一次性下发，handler 逐个调 Delete 并
// 汇总成功/失败明细（单条失败不影响其余）。相比厂商批量接口（阿里云
// DeleteMultipleObjects / minio RemoveObjects）请求次数多，但两个驱动行为完全
// 一致、无单条 RPC 超时风险；单次上限 1000 条。
// 语义与单个删除一致：目录（CommonPrefixes）只删除目录标记，内部对象不受影响。

type DeleteBatchParams struct {
	Bucket string   `json:"bucket"`
	Paths  []string `json:"paths"`
}

type DeleteBatchFail struct {
	Path  string `json:"path"`
	Error string `json:"error"`
}

func handleObjectsDeleteBatch(params json.RawMessage) (interface{}, *RPCError) {
	var p DeleteBatchParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, &RPCError{Code: -32602, Message: "invalid params"}
	}
	if len(p.Paths) == 0 {
		return nil, &RPCError{Code: -32602, Message: "paths 为空"}
	}
	if len(p.Paths) > 1000 {
		p.Paths = p.Paths[:1000]
	}
	bucket, rerr := currentBucket(p.Bucket)
	if rerr != nil {
		return nil, rerr
	}
	d, rerr := getDriver()
	if rerr != nil {
		return nil, rerr
	}
	deleted := 0
	failed := []DeleteBatchFail{}
	for _, path := range p.Paths {
		if strings.TrimSpace(path) == "" {
			continue
		}
		if e := d.Delete(bucket, path); e != nil {
			failed = append(failed, DeleteBatchFail{Path: path, Error: e.Error()})
			continue
		}
		deleted++
	}
	return map[string]interface{}{
		"deleted": deleted,
		"failed":  failed,
	}, nil
}

// ---------- objects/move ----------

type MoveParams struct {
	Bucket string `json:"bucket"`
	From   string `json:"from"`
	To     string `json:"to"`
}

func handleObjectsMove(params json.RawMessage) (interface{}, *RPCError) {
	var p MoveParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, &RPCError{Code: -32602, Message: "invalid params"}
	}
	d, rerr := getDriver()
	if rerr != nil {
		return nil, rerr
	}
	if e := d.Move(p.Bucket, p.From, p.To); e != nil {
		return nil, &RPCError{Code: -32000, Message: "移动失败: " + e.Error()}
	}
	return map[string]interface{}{"ok": true}, nil
}

// ---------- objects/stat ----------

type StatParams struct {
	Bucket string `json:"bucket"`
	Path   string `json:"path"`
}

func handleObjectsStat(params json.RawMessage) (interface{}, *RPCError) {
	var p StatParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, &RPCError{Code: -32602, Message: "invalid params"}
	}
	d, rerr := getDriver()
	if rerr != nil {
		return nil, rerr
	}
	m, e := d.Stat(p.Bucket, p.Path)
	if e != nil {
		return nil, &RPCError{Code: -32000, Message: "stat 失败: " + e.Error()}
	}
	return map[string]interface{}{
		"size":     strconv.FormatInt(m.Size, 10),
		"mime":     m.MIME,
		"modified": m.Modified,
		"etag":     m.ETag,
	}, nil
}

// ---------- objects/presign（预签名分享 URL） ----------

type PresignParams struct {
	Bucket  string `json:"bucket"`
	Path    string `json:"path"`
	Expires int64  `json:"expires"` // 秒；60 ~ 604800（7 天）
}

func handleObjectsPresign(params json.RawMessage) (interface{}, *RPCError) {
	var p PresignParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, &RPCError{Code: -32602, Message: "invalid params"}
	}
	if p.Expires <= 0 {
		p.Expires = 3600
	}
	if p.Expires < 60 {
		p.Expires = 60
	}
	if p.Expires > 604800 {
		p.Expires = 604800
	}
	d, rerr := getDriver()
	if rerr != nil {
		return nil, rerr
	}
	u, e := d.Presign(p.Bucket, p.Path, p.Expires)
	if e != nil {
		return nil, &RPCError{Code: -32000, Message: "预签名失败: " + e.Error()}
	}
	return map[string]interface{}{"url": u, "expires": p.Expires}, nil
}

// ---------- upload/* 大文件分片上传 ----------
// 前端把文件按 256KB 分片 base64 直发 sidecar，顺序追加到宿主机临时文件；
// complete 时由驱动从临时文件流式上转（阿里云分片并发 / MinIO 自动 multipart）。
// 好处：单条 RPC 负载小不超时、内存恒定、可中途取消；对驱动零差异。

type uploadSession struct {
	file    *os.File
	tmpPath string
	bucket  string
	key     string
	mime    string
	written int64
}

var (
	uploadsMu sync.Mutex
	uploads   = map[string]*uploadSession{}
)

func newUploadID() (string, *RPCError) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", &RPCError{Code: -32000, Message: "生成上传 ID 失败: " + err.Error()}
	}
	return hex.EncodeToString(b), nil
}

// currentBucket 解析目标桶：入参优先，否则回落连接默认桶。
func currentBucket(name string) (string, *RPCError) {
	if strings.TrimSpace(name) == "" {
		stateMu.Lock()
		name = state.cfg.Bucket
		stateMu.Unlock()
	}
	if strings.TrimSpace(name) == "" {
		return "", &RPCError{Code: -32000, Message: "未指定存储桶"}
	}
	return name, nil
}

type UploadBeginParams struct {
	Bucket string `json:"bucket"`
	Path   string `json:"path"`
	Mime   string `json:"mime"`
	Size   int64  `json:"size"` // 仅展示用，后端不依赖
}

func handleUploadBegin(params json.RawMessage) (interface{}, *RPCError) {
	var p UploadBeginParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, &RPCError{Code: -32602, Message: "invalid params"}
	}
	bucket, rerr := currentBucket(p.Bucket)
	if rerr != nil {
		return nil, rerr
	}
	if strings.TrimSpace(p.Path) == "" {
		return nil, &RPCError{Code: -32602, Message: "缺少目标对象路径"}
	}
	if _, rerr := getDriver(); rerr != nil {
		return nil, rerr
	}
	tmp, err := os.CreateTemp("", "dbx-up-*.part")
	if err != nil {
		return nil, &RPCError{Code: -32000, Message: "创建临时文件失败: " + err.Error()}
	}
	id, rerr := newUploadID()
	if rerr != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return nil, rerr
	}
	sess := &uploadSession{file: tmp, tmpPath: tmp.Name(), bucket: bucket, key: p.Path, mime: p.Mime}
	uploadsMu.Lock()
	uploads[id] = sess
	uploadsMu.Unlock()
	return map[string]interface{}{"uploadId": id, "offset": int64(0)}, nil
}

type UploadChunkParams struct {
	UploadID string `json:"uploadId"`
	Offset   int64  `json:"offset"`
	Content  string `json:"content"` // base64
}

func handleUploadChunk(params json.RawMessage) (interface{}, *RPCError) {
	var p UploadChunkParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, &RPCError{Code: -32602, Message: "invalid params"}
	}
	data, err := base64.StdEncoding.DecodeString(p.Content)
	if err != nil {
		return nil, &RPCError{Code: -32602, Message: "invalid base64 content"}
	}
	uploadsMu.Lock()
	defer uploadsMu.Unlock()
	sess, ok := uploads[p.UploadID]
	if !ok {
		return nil, &RPCError{Code: -32000, Message: "上传会话不存在或已结束"}
	}
	if p.Offset != sess.written {
		return nil, &RPCError{Code: -32000, Message: fmt.Sprintf("分片偏移不连续: 期望 %d, 收到 %d", sess.written, p.Offset)}
	}
	n, err := sess.file.Write(data)
	if err != nil {
		return nil, &RPCError{Code: -32000, Message: "写入临时文件失败: " + err.Error()}
	}
	sess.written += int64(n)
	return map[string]interface{}{"written": sess.written}, nil
}

func handleUploadComplete(params json.RawMessage) (interface{}, *RPCError) {
	var p struct {
		UploadID string `json:"uploadId"`
	}
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, &RPCError{Code: -32602, Message: "invalid params"}
	}
	uploadsMu.Lock()
	sess, ok := uploads[p.UploadID]
	delete(uploads, p.UploadID)
	uploadsMu.Unlock()
	if !ok {
		return nil, &RPCError{Code: -32000, Message: "上传会话不存在或已结束"}
	}
	defer os.Remove(sess.tmpPath)
	sess.file.Close()
	d, rerr := getDriver()
	if rerr != nil {
		return nil, rerr
	}
	if err := d.PutFromFile(sess.bucket, sess.key, sess.tmpPath, sess.mime); err != nil {
		return nil, &RPCError{Code: -32000, Message: "上传失败: " + err.Error()}
	}
	return map[string]interface{}{"ok": true, "size": sess.written}, nil
}

func handleUploadAbort(params json.RawMessage) (interface{}, *RPCError) {
	var p struct {
		UploadID string `json:"uploadId"`
	}
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, &RPCError{Code: -32602, Message: "invalid params"}
	}
	uploadsMu.Lock()
	sess, ok := uploads[p.UploadID]
	delete(uploads, p.UploadID)
	uploadsMu.Unlock()
	if ok {
		sess.file.Close()
		os.Remove(sess.tmpPath)
	}
	// 幂等：会话不存在也返回 ok
	return map[string]interface{}{"ok": true}, nil
}

func handleNotification(req Request) {
	// 例如 plugin/initialized、objects/changed 等通知，无需回复
	log.Printf("notification: %s", req.Method)
}

// ---------- objects/save（下载到本机） ----------
// 沙箱 webview 的 <a download> 与 window.open 会被静默拦截，前端无法直接落盘。
// 因此下载交由宿主机上的 Sidecar 进程：从对象存储流式读取对象并写入本机 Downloads 目录，
// 返回绝对路径，由前端弹窗展示 + 复制路径。支持任意大小（流式写入，不占内存）。
type SaveParams struct {
	Bucket      string `json:"bucket"`
	Path        string `json:"path"`
	DownloadDir string `json:"downloadDir"` // 可选：自定义落盘目录
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

	// 目标目录：显式传入 > ~/Downloads > 系统临时目录
	dir := strings.TrimSpace(p.DownloadDir)
	if dir == "" {
		if home, e := os.UserHomeDir(); e == nil {
			dir = filepath.Join(home, "Downloads")
		}
	}
	if dir == "" {
		dir = os.TempDir()
	}
	if e := os.MkdirAll(dir, 0o755); e != nil {
		return nil, &RPCError{Code: -32000, Message: "创建下载目录失败: " + e.Error()}
	}

	// 取 object key 最后一段作文件名，并净化非法字符
	base := filepath.Base(p.Path)
	if base == "" || base == "." || base == "/" || base == "\\" {
		base = "download"
	}
	base = sanitizeFilename(base)

	// 避免覆盖同名文件：存在则追加 _1 / _2 …
	dst := uniquePath(dir, base)
	rd, e := d.OpenStream(p.Bucket, p.Path)
	if e != nil {
		return nil, &RPCError{Code: -32000, Message: "读取对象失败: " + e.Error()}
	}
	defer rd.Close()
	out, e := os.Create(dst)
	if e != nil {
		return nil, &RPCError{Code: -32000, Message: "创建文件失败: " + e.Error()}
	}
	defer out.Close()
	n, e := io.Copy(out, rd)
	if e != nil {
		return nil, &RPCError{Code: -32000, Message: "写入文件失败: " + e.Error()}
	}
	return map[string]interface{}{
		"path": filepath.ToSlash(dst),
		"size": n,
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
func sanitizeFilename(name string) string {
	r := strings.NewReplacer("/", "_", "\\", "_", ":", "_", "*", "_", "?", "_", "\"", "_", "<", "_", ">", "_", "|", "_")
	return r.Replace(name)
}
