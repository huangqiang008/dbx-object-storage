package main

// rpc_transfer.go — 对象与目录的移动 / 复制（含跨桶）RPC handler。

import (
	"encoding/json"
	"strings"
)

func ensureNotExists(d StorageDriver, bucket, to string) *RPCError {
	if _, e := d.Stat(bucket, to); e == nil {
		return &RPCError{Code: -32000, Message: "目标已存在: " + to}
	}
	return nil
}

// ensureNotExistsAcross 跨桶场景的冲突检查（源桶与目标桶可不同）。
func ensureNotExistsAcross(d StorageDriver, dstBucket, to string) *RPCError {
	if _, e := d.Stat(dstBucket, to); e == nil {
		return &RPCError{Code: -32000, Message: "目标已存在: " + dstBucket + "/" + to}
	}
	return nil
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
	if rerr := ensureNotExists(d, p.Bucket, p.To); rerr != nil {
		return nil, rerr
	}
	if e := d.Move(p.Bucket, p.From, p.To); e != nil {
		return nil, &RPCError{Code: -32000, Message: "移动失败: " + e.Error()}
	}
	return map[string]interface{}{"ok": true}, nil
}

// ---------- objects/copy（复制单个对象，不删源；批量复制的基础） ----------

type CopyParams struct {
	Bucket string `json:"bucket"`
	From   string `json:"from"`
	To     string `json:"to"`
}

func handleObjectsCopy(params json.RawMessage) (interface{}, *RPCError) {
	var p CopyParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, &RPCError{Code: -32602, Message: "invalid params"}
	}
	if rerr := requireWritable(); rerr != nil {
		return nil, rerr
	}
	if strings.TrimSpace(p.From) == "" || strings.TrimSpace(p.To) == "" {
		return nil, &RPCError{Code: -32602, Message: "from/to 不能为空"}
	}
	if p.From == p.To {
		return nil, &RPCError{Code: -32000, Message: "源与目标相同"}
	}
	d, rerr := getDriver()
	if rerr != nil {
		return nil, rerr
	}
	if rerr := ensureNotExists(d, p.Bucket, p.To); rerr != nil {
		return nil, rerr
	}
	if e := d.Copy(p.Bucket, p.From, p.To); e != nil {
		return nil, &RPCError{Code: -32000, Message: "复制失败: " + e.Error()}
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
	moved, e := d.MovePrefix(bucket, p.From, p.To)
	if e != nil {
		return nil, &RPCError{Code: -32000, Message: "目录重命名失败: " + e.Error()}
	}
	return map[string]interface{}{
		"ok":    true,
		"moved": moved,
	}, nil
}

// ---------- objects/copy_dir（目录复制：递归复制 prefix 下的全部对象，不删源） ----------
//
// 为什么需要：README v1 明确「目录复制暂不支持」，批量复制遇到目录只能
// 如实计入跳过数。目录复制等于双倍存储成本，是用户明确发起的操作——
// 不做隐式去重，但也不该拒绝。实现与 move_dir 同构，只是不删源。

type CopyDirParams struct {
	Bucket string `json:"bucket"`
	From   string `json:"from"` // 源目录前缀
	To     string `json:"to"`   // 目标目录前缀
}

func handleObjectsCopyDir(params json.RawMessage) (interface{}, *RPCError) {
	var p CopyDirParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, &RPCError{Code: -32602, Message: "invalid params"}
	}
	if rerr := requireWritable(); rerr != nil {
		return nil, rerr
	}
	if strings.TrimSpace(p.From) == "" || strings.TrimSpace(p.To) == "" {
		return nil, &RPCError{Code: -32602, Message: "源目录与目标目录不能为空"}
	}
	fromP := normalizeDirPrefix(p.From)
	toP := normalizeDirPrefix(p.To)
	if strings.HasPrefix(toP, fromP) {
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
	copied, e := d.CopyPrefixAcross(bucket, bucket, fromP, toP)
	if e != nil {
		return nil, &RPCError{Code: -32000, Message: "目录复制失败: " + e.Error()}
	}
	return map[string]interface{}{
		"ok":     true,
		"copied": copied,
	}, nil
}

// ---------- 2.2 跨桶复制 / 移动 ----------
// CopyAcrossParams 跨桶复制参数。DstBucket 为空 = 同桶（与旧接口等价）。
type CopyAcrossParams struct {
	Bucket    string `json:"bucket"`    // 源桶
	DstBucket string `json:"dstBucket"` // 目标桶（空 = 同桶）
	From      string `json:"from"`
	To        string `json:"to"`
}

// handleObjectsCopyAcross 跨桶复制单个对象（不删源）。
func handleObjectsCopyAcross(params json.RawMessage) (interface{}, *RPCError) {
	var p CopyAcrossParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, &RPCError{Code: -32602, Message: "invalid params"}
	}
	if rerr := requireWritable(); rerr != nil {
		return nil, rerr
	}
	if strings.TrimSpace(p.From) == "" || strings.TrimSpace(p.To) == "" {
		return nil, &RPCError{Code: -32602, Message: "from/to 不能为空"}
	}
	if p.From == p.To && p.DstBucket == p.Bucket {
		return nil, &RPCError{Code: -32000, Message: "源与目标相同"}
	}
	d, rerr := getDriver()
	if rerr != nil {
		return nil, rerr
	}
	src, rerr := currentBucket(p.Bucket)
	if rerr != nil {
		return nil, rerr
	}
	dst, rerr := currentBucket(p.DstBucket)
	if rerr != nil {
		return nil, rerr
	}
	if rerr := ensureNotExistsAcross(d, dst, p.To); rerr != nil {
		return nil, rerr
	}
	if e := d.CopyAcross(src, dst, p.From, p.To); e != nil {
		return nil, &RPCError{Code: -32000, Message: "复制失败: " + e.Error()}
	}
	return map[string]interface{}{"ok": true}, nil
}

// MoveAcrossParams 跨桶移动参数。
type MoveAcrossParams struct {
	Bucket    string `json:"bucket"`
	DstBucket string `json:"dstBucket"`
	From      string `json:"from"`
	To        string `json:"to"`
}

// handleObjectsMoveAcross 跨桶移动单个对象（copy + delete）。
func handleObjectsMoveAcross(params json.RawMessage) (interface{}, *RPCError) {
	var p MoveAcrossParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, &RPCError{Code: -32602, Message: "invalid params"}
	}
	if rerr := requireWritable(); rerr != nil {
		return nil, rerr
	}
	if strings.TrimSpace(p.From) == "" || strings.TrimSpace(p.To) == "" {
		return nil, &RPCError{Code: -32602, Message: "from/to 不能为空"}
	}
	if p.From == p.To && p.DstBucket == p.Bucket {
		return nil, &RPCError{Code: -32000, Message: "源与目标相同"}
	}
	d, rerr := getDriver()
	if rerr != nil {
		return nil, rerr
	}
	src, rerr := currentBucket(p.Bucket)
	if rerr != nil {
		return nil, rerr
	}
	dst, rerr := currentBucket(p.DstBucket)
	if rerr != nil {
		return nil, rerr
	}
	if rerr := ensureNotExistsAcross(d, dst, p.To); rerr != nil {
		return nil, rerr
	}
	if e := d.MoveAcross(src, dst, p.From, p.To); e != nil {
		return nil, &RPCError{Code: -32000, Message: "移动失败: " + e.Error()}
	}
	return map[string]interface{}{"ok": true}, nil
}

// CopyDirAcrossParams 跨桶复制目录参数。
type CopyDirAcrossParams struct {
	Bucket    string `json:"bucket"`
	DstBucket string `json:"dstBucket"`
	From      string `json:"from"` // 源目录前缀
	To        string `json:"to"`   // 目标目录前缀
}

// handleObjectsCopyDirAcross 跨桶递归复制目录（不删源）。
//
// 与 objects/move_dir 的区别：move_dir 搬完删源，copy_dir_across 保留源对象。
// 目录复制等于双倍存储成本，是用户明确发起的操作——不做隐式去重。
func handleObjectsCopyDirAcross(params json.RawMessage) (interface{}, *RPCError) {
	var p CopyDirAcrossParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, &RPCError{Code: -32602, Message: "invalid params"}
	}
	if rerr := requireWritable(); rerr != nil {
		return nil, rerr
	}
	if strings.TrimSpace(p.From) == "" || strings.TrimSpace(p.To) == "" {
		return nil, &RPCError{Code: -32602, Message: "源目录与目标目录不能为空"}
	}
	src, rerr := currentBucket(p.Bucket)
	if rerr != nil {
		return nil, rerr
	}
	dst, rerr := currentBucket(p.DstBucket)
	if rerr != nil {
		return nil, rerr
	}
	fromP := normalizeDirPrefix(p.From)
	toP := normalizeDirPrefix(p.To)
	// 目标不得是源目录的子目录（同桶时），否则会形成自我嵌套的无限复制。
	if src == dst && strings.HasPrefix(toP, fromP) {
		return nil, &RPCError{Code: -32602, Message: "目标目录不能位于源目录之内"}
	}
	d, rerr := getDriver()
	if rerr != nil {
		return nil, rerr
	}
	copied, e := d.CopyPrefixAcross(src, dst, fromP, toP)
	if e != nil {
		return nil, &RPCError{Code: -32000, Message: "目录复制失败: " + e.Error()}
	}
	return map[string]interface{}{
		"ok":     true,
		"copied": copied,
	}, nil
}

// ---------- 2.1 对象元数据编辑 ----------

// MetaParams 元数据编辑参数。空字符串 = 该项不修改。
type MetaParams struct {
	Bucket             string            `json:"bucket"`
	Path               string            `json:"path"`
	ContentType        string            `json:"contentType"`
	ContentDisposition string            `json:"contentDisposition"`
	CacheControl       string            `json:"cacheControl"`
	ContentEncoding    string            `json:"contentEncoding"`
	UserMetadata       map[string]string `json:"userMetadata"` // nil = 不动；非 nil = 整体替换
	StorageClass       string            `json:"storageClass"`
}

// handleObjectsSetMeta 改写对象元数据。
//
// 底层靠「自复制 + REPLACE 元数据」实现（对象存储无原地改元数据 API），
// 因此会重写对象的 Last-Modified。这是协议固有代价，两侧行为一致。
