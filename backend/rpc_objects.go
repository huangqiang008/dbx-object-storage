package main

// rpc_objects.go — 对象列举 / 读取 / 写入 / 删除 RPC handler。

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"strings"
)

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
	// DeletePrefix 流式删除，不设数量上限；失败时返回已删除数量
	deleted, e := d.DeletePrefix(bucket, prefix)
	if e != nil {
		return nil, &RPCError{Code: -32000, Message: "删除目录失败: " + e.Error()}
	}
	return map[string]interface{}{
		"ok":      true,
		"deleted": deleted,
	}, nil
}

// ---------- objects/delete_batch（多选批量删除） ----------
// F3 多选批量：前端把选中的完整 key 列表分块（≤1000/次）下发，handler 用
// 服务端批量删除接口（DeleteObjects / RemoveObjects）一次删一块并汇总
// 成功/失败明细（单条失败不影响其余）。文件批量走 DeleteMany；目录项走
// DeletePrefix 流式递归删除（不设数量上限）。

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
	bucket, rerr := currentBucket(p.Bucket)
	if rerr != nil {
		return nil, rerr
	}
	d, rerr := getDriver()
	if rerr != nil {
		return nil, rerr
	}
	// 文件部分：分块走服务端批量删除接口（1000 key/请求）。
	// 前端按 100 条/块下发，这里再按 deleteBatchSize 兜底切块，
	// 无论单次 RPC 带多少条都不会突破服务端单请求上限。
	deleted := 0
	failed := []DeleteBatchFail{}
	for start := 0; start < len(p.Paths); start += deleteBatchSize {
		end := start + deleteBatchSize
		if end > len(p.Paths) {
			end = len(p.Paths)
		}
		n, fails := d.DeleteMany(bucket, p.Paths[start:end])
		deleted += n
		for _, f := range fails {
			failed = append(failed, DeleteBatchFail{Path: f.Key, Error: f.Error})
		}
	}
	// 目录项按「目录数」计入 deleted，额外返回递归删掉的对象总数 objectsDeleted，
	// 便于前端如实汇报而不让用户以为只删了表面那几项。
	objectsDeleted := 0
	for _, dir := range p.Dirs {
		if strings.TrimSpace(dir) == "" {
			continue
		}
		n, e := d.DeletePrefix(bucket, normalizeDirPrefix(dir))
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

// ensureNotExists 目标冲突检查：CopyObject 是覆盖写语义，批量移动/复制若不
// 拦截同名目标会静默覆盖已有对象。单条改名的冲突检查在前端，这里是批量路径
// 的兜底（每个目标一次 HEAD，代价可接受）。
