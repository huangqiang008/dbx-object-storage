package main

// oss.go — RPC handler 层。
// 只面向 StorageDriver 接口，不含任何厂商 SDK 类型；连接参数解析与驱动工厂见 driver.go。

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
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
	"time"
)

// pluginVersion 必须与 manifest.json 的 version 及 ui/main.js 的 BUILD 一致。
// dev 宿主会在 plugin/initialize 回包中校验 info.plugin.id/version。
// v0.2.0 起由 com.aliyun.oss.browser 改为通用 ID（阿里云 OSS / MinIO / S3 兼容）。
const pluginVersion = "1.0.0"

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

// requireWritable 只读连接守卫：宿主在 connection-provider 上把连接标记为
// read_only 时，所有写类操作（写/删/改名/上传）必须被拒绝。
//
// 放在 handler 层而非驱动层的原因：驱动实例是长生命周期的、可能被多路复用，
// 而「只读」是连接级别的一次性属性；集中守卫比给每个驱动方法加开关更不易漏。
// 前端同时会隐藏写入口，但前端只是体验优化，真正的边界在这里。
func requireWritable() *RPCError {
	stateMu.Lock()
	readOnly := state.cfg.ReadOnly
	stateMu.Unlock()
	if readOnly {
		return &RPCError{Code: -32000, Message: "当前连接为只读模式，不能执行写操作"}
	}
	return nil
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
		"readOnly":  cfg.ReadOnly,
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
	if rerr := requireWritable(); rerr != nil {
		return nil, rerr
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

// handleObjectsDelete 删除单个文件。
// 目录删除走独立的 objects/delete_dir（会真正递归删除），避免这里对逻辑前缀
// 发一次无效 DELETE 后误报成功。
func handleObjectsDelete(params json.RawMessage) (interface{}, *RPCError) {
	var p DeleteParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, &RPCError{Code: -32602, Message: "invalid params"}
	}
	if rerr := requireWritable(); rerr != nil {
		return nil, rerr
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

// ---------- objects/dir_info（删除目录前统计对象数，用于二次确认） ----------

type DirInfoParams struct {
	Bucket string `json:"bucket"`
	Path   string `json:"path"`
}

// dirScanLimit 统计/删除单个目录时允许扫描的对象数上限。
// 目录动辄上万对象，一次性列举既慢又有风险；超出即让前端提示用户改用分批或
// 服务端工具，而不是默默截断。
const dirScanLimit = 1000

// handleObjectsDirInfo 统计目录下的对象数，供前端在确认弹窗里明确告知
// 「将连带删除 N 个对象」，避免用户误以为只删目录标记。
func handleObjectsDirInfo(params json.RawMessage) (interface{}, *RPCError) {
	var p DirInfoParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, &RPCError{Code: -32602, Message: "invalid params"}
	}
	d, rerr := getDriver()
	if rerr != nil {
		return nil, rerr
	}
	bucket, rerr := currentBucket(p.Bucket)
	if rerr != nil {
		return nil, rerr
	}
	prefix := normalizeDirPrefix(p.Path)
	// 逐页平铺列举，累计到上限即停止并置 truncated。
	count := 0
	token := ""
	truncated := false
	for {
		page, e := d.ListObjects(ListReq{
			Bucket:    bucket,
			Prefix:    prefix,
			Recursive: true,
			Token:     token,
			MaxKeys:   dirScanLimit,
		})
		if e != nil {
			return nil, &RPCError{Code: -32000, Message: "统计目录失败: " + e.Error()}
		}
		count += len(page.Items)
		if count >= dirScanLimit {
			truncated = true
			break
		}
		if !page.Truncated || page.NextToken == "" {
			break
		}
		token = page.NextToken
	}
	return map[string]interface{}{
		"count":     count,
		"truncated": truncated,
	}, nil
}

// normalizeDirPrefix 保证目录前缀以 "/" 结尾。ListObjects 的 Prefix 与
// DeletePrefix 的前缀语义都依赖这个尾部斜杠，缺失会导致误匹配同名前缀的兄弟目录
// （如删除 a/b 却命中 a/bak/...）。
func normalizeDirPrefix(path string) string {
	if path == "" {
		return ""
	}
	if strings.HasSuffix(path, "/") {
		return path
	}
	return path + "/"
}

// ---------- objects/delete_dir（删除目录：递归删除全部内容） ----------

type DeleteDirParams struct {
	Bucket string `json:"bucket"`
	Path   string `json:"path"`
}

// handleObjectsDeleteDir 真正递归删除目录。
// 关键修复：对象存储没有实体目录，仅对 prefix 发一次 DELETE 会命中不存在的 key，
// 服务端幂等返回 204，界面提示「已删除」但目录纹丝不动。这里改为列举 prefix 下
// 全部对象后批量删除，删除干净且可核对数量。
func handleObjectsDeleteDir(params json.RawMessage) (interface{}, *RPCError) {
	var p DeleteDirParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, &RPCError{Code: -32602, Message: "invalid params"}
	}
	if rerr := requireWritable(); rerr != nil {
		return nil, rerr
	}
	if strings.TrimSpace(p.Path) == "" {
		return nil, &RPCError{Code: -32602, Message: "path 为空"}
	}
	d, rerr := getDriver()
	if rerr != nil {
		return nil, rerr
	}
	bucket, rerr := currentBucket(p.Bucket)
	if rerr != nil {
		return nil, rerr
	}
	prefix := normalizeDirPrefix(p.Path)
	deleted, e := d.DeletePrefix(bucket, prefix, dirScanLimit)
	if e != nil {
		return nil, &RPCError{Code: -32000, Message: "删除目录失败: " + e.Error()}
	}
	return map[string]interface{}{
		"ok":      true,
		"deleted": deleted,
	}, nil
}

// ---------- objects/delete_batch（多选批量删除） ----------
// F3 多选批量：前端把选中的完整 key 列表一次性下发，handler 逐个删除并
// 汇总成功/失败明细（单条失败不影响其余）。文件逐条删除；目录项走
// DeletePrefix 真正递归删除其下全部对象（仅发一次 DELETE 打到逻辑前缀会假成功）。
// 相比厂商批量接口（阿里云 DeleteMultipleObjects / minio RemoveObjects）文件部分
// 请求次数多，但两个驱动行为完全一致、无单条 RPC 超时风险。
// 单次上限 1000 条（目录内对象数另有 dirScanLimit 上限）。

type DeleteBatchParams struct {
	Bucket string   `json:"bucket"`
	Paths  []string `json:"paths"`
	// Dirs 单独列出目录项。放在独立字段而非混在 Paths 里，是为了不依赖
	// 「key 以 / 结尾即目录」这种隐式约定——S3 允许 key 以 / 结尾但并非目录。
	Dirs []string `json:"dirs"`
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
	if rerr := requireWritable(); rerr != nil {
		return nil, rerr
	}
	total := len(p.Paths) + len(p.Dirs)
	if total == 0 {
		return nil, &RPCError{Code: -32602, Message: "paths 为空"}
	}
	if total > 1000 {
		remaining := 1000 - len(p.Dirs)
		if remaining < 0 {
			remaining = 0
		}
		if len(p.Paths) > remaining {
			p.Paths = p.Paths[:remaining]
		}
		p.Dirs = p.Dirs[:min(len(p.Dirs), 1000)]
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
	// 目录项按「目录数」计入 deleted，额外返回递归删掉的对象总数 objectsDeleted，
	// 便于前端如实汇报而不让用户以为只删了表面那几项。
	objectsDeleted := 0
	for _, dir := range p.Dirs {
		if strings.TrimSpace(dir) == "" {
			continue
		}
		n, e := d.DeletePrefix(bucket, normalizeDirPrefix(dir), dirScanLimit)
		if e != nil {
			failed = append(failed, DeleteBatchFail{Path: dir, Error: e.Error()})
			continue
		}
		deleted++
		objectsDeleted += n
	}
	return map[string]interface{}{
		"deleted":        deleted,
		"objectsDeleted": objectsDeleted,
		"failed":         failed,
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
	if rerr := requireWritable(); rerr != nil {
		return nil, rerr
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

// ---------- objects/move_dir（目录重命名：递归移动 prefix 下的全部对象） ----------
//
// 为什么不复用 objects/move：对象存储没有实体目录，目录只是 delimiter 折叠出的
// 逻辑前缀。对前缀发一次 copy+delete 只会命中（通常并不存在的）目录标记对象，
// 表现为「改名报 NoSuchKey」或「改名后目录内容凭空消失」。真正的目录改名必须
// 列举 prefix 下的全部 key 逐个搬迁，见 StorageDriver.MovePrefix。

type MoveDirParams struct {
	Bucket string `json:"bucket"`
	From   string `json:"from"` // 源目录前缀（可带或不带尾斜杠）
	To     string `json:"to"`   // 目标目录前缀
}

func handleObjectsMoveDir(params json.RawMessage) (interface{}, *RPCError) {
	var p MoveDirParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, &RPCError{Code: -32602, Message: "invalid params"}
	}
	if rerr := requireWritable(); rerr != nil {
		return nil, rerr
	}
	if strings.TrimSpace(p.From) == "" || strings.TrimSpace(p.To) == "" {
		return nil, &RPCError{Code: -32602, Message: "源目录与目标目录不能为空"}
	}
	// 目标不得是源目录的子目录，否则会形成自我嵌套的无限搬迁。
	if strings.HasPrefix(normalizeDirPrefix(p.To), normalizeDirPrefix(p.From)) {
		return nil, &RPCError{Code: -32602, Message: "目标目录不能位于源目录之内"}
	}
	d, rerr := getDriver()
	if rerr != nil {
		return nil, rerr
	}
	bucket, rerr := currentBucket(p.Bucket)
	if rerr != nil {
		return nil, rerr
	}
	moved, e := d.MovePrefix(bucket, p.From, p.To, dirScanLimit)
	if e != nil {
		return nil, &RPCError{Code: -32000, Message: "目录重命名失败: " + e.Error()}
	}
	return map[string]interface{}{
		"ok":    true,
		"moved": moved,
	}, nil
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
	id       string
	file     *os.File
	tmpPath  string
	metaPath string
	bucket   string
	key      string
	mime     string
	size     int64
	written  int64
	// resumable 为 true 表示接管自历史分片文件，元数据沿用既有 .meta，不重写
	resumable bool
}

// uploadMeta 落盘的可续传元数据。key 本身可能含 "/"，无法从文件名反推，
// 故单独存一份同名 .meta。
type uploadMeta struct {
	Bucket string `json:"bucket"`
	Key    string `json:"key"`
	Size   int64  `json:"size"`
	Mime   string `json:"mime"`
}

var (
	uploadsMu sync.Mutex
	uploads   = map[string]*uploadSession{}
)

// uploadTempPrefix 上传分片临时文件名前缀。
const uploadTempPrefix = "dbx-up-"

// uploadTempPattern 上传分片临时文件扫描规则。与 cleanupStaleUploads 对应。
const uploadTempPattern = uploadTempPrefix + "*.part"

// uploadMetaPattern 可续传元数据的扫描规则（.part 与 .meta 一并清理）。
const uploadMetaPattern = uploadTempPrefix + "*.meta"

// uploadTempTTL 临时文件最长保留时长。sidecar 崩溃 / 宿主强杀进程时 abort 不会执行，
// .part 文件会永久残留（历史上没有任何回收机制，长期使用持续占磁盘）。
// 取 24h：足够覆盖任何跨夜的大文件上传，又不会让垃圾无限堆积。
const uploadTempTTL = 24 * time.Hour

// maxConcurrentUploads 单 sidecar 同时进行的上传会话数上限。
// 异常调用（如前端反复 begin 不 complete）会无限制堆积会话与临时文件。
const maxConcurrentUploads = 8

// cleanupStaleUploads 启动时清理超龄的上传临时文件。
// 正常退出路径下 abort/complete 已删除文件，能被清到的都是崩溃遗留。
// 扫描 .part 与 .meta 两类文件（修改时间超过 TTL 即删），不碰其他临时文件。
// .meta 必须一起清理，否则会留下没有分片的孤儿元数据。
func cleanupStaleUploads() {
	cutoff := time.Now().Add(-uploadTempTTL)
	removed := 0
	for _, pattern := range []string{uploadTempPattern, uploadMetaPattern} {
		entries, err := filepath.Glob(filepath.Join(os.TempDir(), pattern))
		if err != nil {
			log.Printf("扫描残留上传临时文件失败(%s): %v", pattern, err)
			continue
		}
		for _, p := range entries {
			info, e := os.Stat(p)
			if e != nil {
				continue // 已被其它进程清理
			}
			if info.ModTime().After(cutoff) {
				continue // 仍在保留期内，可能是有活跃会话或可续传
			}
			if os.Remove(p) == nil {
				removed++
			}
		}
	}
	if removed > 0 {
		log.Printf("已清理 %d 个残留上传临时文件（超过 %v）", removed, uploadTempTTL)
	}
}

// registerUpload 登记上传会话；超出并发上限或会话数失控时返回错误。
func registerUpload(sess *uploadSession, id string) *RPCError {
	uploadsMu.Lock()
	defer uploadsMu.Unlock()
	if len(uploads) >= maxConcurrentUploads {
		return &RPCError{Code: -32000, Message: fmt.Sprintf("同时进行的上传过多（上限 %d），请稍后重试", maxConcurrentUploads)}
	}
	uploads[id] = sess
	return nil
}

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
	if rerr := requireWritable(); rerr != nil {
		return nil, rerr
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
	// 断点续传：先找这个对象是否已有历史分片（sidecar 上次崩溃/被杀会留下）。
	// 命中则接管该文件继续追加，避免整个文件重传。
	if sess := claimResumableUpload(bucket, p.Path, p.Size); sess != nil {
		return map[string]interface{}{
			"uploadId": sess.id,
			"offset":   sess.written,
			"resumed":  true,
		}, nil
	}

	tmp, err := os.CreateTemp("", uploadTempPattern)
	if err != nil {
		return nil, &RPCError{Code: -32000, Message: "创建临时文件失败: " + err.Error()}
	}
	id, rerr := newUploadID()
	if rerr != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return nil, rerr
	}
	sess := &uploadSession{
		id: id, file: tmp, tmpPath: tmp.Name(),
		bucket: bucket, key: p.Path, mime: p.Mime, size: p.Size,
	}
	if e := registerUpload(sess, id); e != nil {
		// 超限时必须回收已创建的临时文件，否则这次失败的 begin 又留下一份垃圾
		tmp.Close()
		os.Remove(tmp.Name())
		return nil, e
	}
	// 元数据落盘，供下次 sidecar 启动后按 (bucket,key,size) 找回此分片
	persistUploadMeta(sess)
	return map[string]interface{}{"uploadId": id, "offset": int64(0), "resumed": false}, nil
}

// claimResumableUpload 尝试接管上次未完成的分片文件，实现跨进程断点续传。
//
// 前提是分片文件名可由 (bucket, key, size) 稳定推导：否则 sidecar 一重启，
// 内存里的 uploads map 与随机文件名都无从对应，续传无从谈起。
// 故用 sha256(bucket+"\x00"+key+"\x00"+size) 前 12 字节作为文件名，
// 元数据另存同名 .meta（key 含 "/"，无法从文件名反推）。
//
// 安全性：.meta 与 .part 必须同时存在且三者（bucket/key/size）完全一致才接管，
// 分片为空或超过声明大小一律丢弃重来——避免把 A 文件的内容接到 B 文件上。
func claimResumableUpload(bucket, key string, size int64) *uploadSession {
	if size <= 0 {
		return nil // 不知道总大小，无法安全续传
	}
	stem := uploadStem(bucket, key, size)
	partPath := filepath.Join(os.TempDir(), stem+".part")
	metaPath := filepath.Join(os.TempDir(), stem+".meta")

	raw, err := os.ReadFile(metaPath)
	if err != nil {
		return nil // 无元数据，视为无历史分片
	}
	var meta uploadMeta
	if json.Unmarshal(raw, &meta) != nil {
		return nil
	}
	if meta.Bucket != bucket || meta.Key != key || meta.Size != size {
		return nil // 元数据与本次请求不符（同名碰撞或陈旧状态）
	}
	info, err := os.Stat(partPath)
	if err != nil {
		return nil
	}
	if info.Size() == 0 || info.Size() > size {
		// 空分片无续传价值；超长说明状态错乱，两种都清掉重来
		os.Remove(partPath)
		os.Remove(metaPath)
		return nil
	}

	f, err := os.OpenFile(partPath, os.O_RDWR|os.O_APPEND, 0o600)
	if err != nil {
		return nil
	}
	id, rerr := newUploadID()
	if rerr != nil {
		f.Close()
		return nil
	}
	sess := &uploadSession{
		id: id, file: f, tmpPath: partPath, metaPath: metaPath,
		bucket: bucket, key: key, mime: meta.Mime, size: size,
		written: info.Size(), resumable: true,
	}
	if e := registerUpload(sess, id); e != nil {
		f.Close()
		return nil // 并发已满，退回全新上传
	}
	log.Printf("断点续传：%s/%s 从 %d/%d 字节继续", bucket, key, sess.written, size)
	return sess
}

// uploadStem 由 bucket+key+size 派生稳定的临时文件名（不含扩展名）。
//
// 用「长度前缀」而非分隔符拼接：分隔符方案在 key 自身含分隔符时会歧义
// （("a","b\x00c") 与 ("a\x00b","c") 会得到同样的字节流，进而撞上同一个 stem），
// 而对象 key 是用户可控的，这种歧义可能导致误接管别的文件的上传分片。
func uploadStem(bucket, key string, size int64) string {
	h := sha256.New()
	var lenBuf [8]byte
	put := func(s string) {
		binary.BigEndian.PutUint64(lenBuf[:], uint64(len(s)))
		h.Write(lenBuf[:])
		h.Write([]byte(s))
	}
	put(bucket)
	put(key)
	binary.BigEndian.PutUint64(lenBuf[:], uint64(size))
	h.Write(lenBuf[:])
	return uploadTempPrefix + hex.EncodeToString(h.Sum(nil)[:12])
}

// persistUploadMeta 为「新建」会话写入可续传元数据。
// 续传会话沿用既有 .meta，不重写（内容本就一致）。
func persistUploadMeta(sess *uploadSession) {
	if sess.resumable || sess.tmpPath == "" {
		return
	}
	sess.metaPath = strings.TrimSuffix(sess.tmpPath, ".part") + ".meta"
	raw, err := json.Marshal(uploadMeta{
		Bucket: sess.bucket, Key: sess.key, Size: sess.size, Mime: sess.mime,
	})
	if err != nil {
		return
	}
	// 先写 .tmp 再 rename：避免进程在写一半时被杀，留下半截 JSON 误导后续续传
	tmp := sess.metaPath + ".tmp"
	if os.WriteFile(tmp, raw, 0o600) == nil {
		os.Rename(tmp, sess.metaPath)
	}
}

// removeUploadFiles 清理会话的临时文件与元数据（正常完成/取消时调用）
func removeUploadFiles(sess *uploadSession) {
	sess.file.Close()
	os.Remove(sess.tmpPath)
	os.Remove(sess.metaPath)
	os.Remove(strings.TrimSuffix(sess.tmpPath, ".part") + ".meta")
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
	// 必须在 PutFromFile 之后再删分片：驱动要从该文件读取内容。
	// 同时清掉 .meta，否则会留下没有分片的孤儿元数据。
	defer removeUploadFiles(sess)
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
		// 用户主动取消：连同元数据一起清掉，不给后续续传留垃圾
		removeUploadFiles(sess)
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

// resolveDownloadDir 解析并校验下载落盘目录。
//
// 安全背景：downloadDir 由前端直传，若完全不校验，本插件就等价于一个
// 「任意路径写文件」的能力——且 MkdirAll 会连带创建整条路径，
// 可写到系统目录或用户敏感位置。因此限制在用户主目录（含子目录）
// 与系统临时目录内，其余一律拒绝。
//
// 注意：这只是纵深防御。即便做了校验，插件仍应按最小权限运行
// （能用 host.storage 的原生保存对话框时优先用它，见前端 downloadViaHost）。
func resolveDownloadDir(requested string) (string, *RPCError) {
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

	if !isDirWithinAllowedRoots(abs) {
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

func handleObjectSave(params json.RawMessage) (interface{}, *RPCError) {
	var p SaveParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, &RPCError{Code: -32602, Message: "invalid params"}
	}
	d, rerr := getDriver()
	if rerr != nil {
		return nil, rerr
	}

	dir, rerr := resolveDownloadDir(p.DownloadDir)
	if rerr != nil {
		return nil, rerr
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
