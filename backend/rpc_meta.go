package main

// rpc_meta.go — 元数据 / 标签 / ACL / presign RPC handler。

import (
	"encoding/json"
	"strconv"
	"strings"
)

func handleObjectsSetMeta(params json.RawMessage) (interface{}, *RPCError) {
	var p MetaParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, &RPCError{Code: -32602, Message: "invalid params"}
	}
	if rerr := requireWritable(); rerr != nil {
		return nil, rerr
	}
	if strings.TrimSpace(p.Path) == "" {
		return nil, &RPCError{Code: -32602, Message: "path 不能为空"}
	}
	d, rerr := getDriver()
	if rerr != nil {
		return nil, rerr
	}
	bucket, rerr := currentBucket(p.Bucket)
	if rerr != nil {
		return nil, rerr
	}
	patch := MetaPatch{
		ContentType:        p.ContentType,
		ContentDisposition: p.ContentDisposition,
		CacheControl:       p.CacheControl,
		ContentEncoding:    p.ContentEncoding,
		UserMetadata:       p.UserMetadata,
	}
	if sc := normalizeStorageClass(p.StorageClass); sc != "" {
		patch.StorageClass = sc
	} else if strings.TrimSpace(p.StorageClass) != "" {
		return nil, &RPCError{Code: -32602, Message: "不支持的存储类别: " + p.StorageClass}
	}
	if e := d.SetMeta(bucket, p.Path, patch); e != nil {
		return nil, &RPCError{Code: -32000, Message: "修改元数据失败: " + e.Error()}
	}
	// 回传改后的完整元数据，前端直接刷新详情面板，无需再发一次 stat
	meta, e := d.Stat(bucket, p.Path)
	if e != nil {
		return map[string]interface{}{"ok": true}, nil
	}
	return map[string]interface{}{
		"ok":   true,
		"meta": objMetaToMap(meta),
	}, nil
}

// objMetaToMap 把 ObjMeta 转成前端可用的 map（字段名与前端约定一致）。
func objMetaToMap(m ObjMeta) map[string]interface{} {
	out := map[string]interface{}{
		"size":               m.Size,
		"mime":               m.MIME,
		"modified":           m.Modified,
		"etag":               m.ETag,
		"contentType":        m.ContentType,
		"contentDisposition": m.ContentDisposition,
		"cacheControl":       m.CacheControl,
		"contentEncoding":    m.ContentEncoding,
		"storageClass":       m.StorageClass,
	}
	if len(m.UserMetadata) > 0 {
		out["userMetadata"] = m.UserMetadata
	}
	if len(m.Tags) > 0 {
		out["tags"] = m.Tags
	}
	return out
}

// ---------- 2.3 对象标签 ----------

// TagsParams 标签参数。
type TagsParams struct {
	Bucket string            `json:"bucket"`
	Path   string            `json:"path"`
	Tags   map[string]string `json:"tags"`
}

// handleObjectsSetTags 覆盖式设置对象标签（传空 map = 清空）。
func handleObjectsSetTags(params json.RawMessage) (interface{}, *RPCError) {
	var p TagsParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, &RPCError{Code: -32602, Message: "invalid params"}
	}
	if rerr := requireWritable(); rerr != nil {
		return nil, rerr
	}
	if strings.TrimSpace(p.Path) == "" {
		return nil, &RPCError{Code: -32602, Message: "path 不能为空"}
	}
	d, rerr := getDriver()
	if rerr != nil {
		return nil, rerr
	}
	bucket, rerr := currentBucket(p.Bucket)
	if rerr != nil {
		return nil, rerr
	}
	if e := d.SetTags(bucket, p.Path, p.Tags); e != nil {
		return nil, &RPCError{Code: -32000, Message: "设置标签失败: " + e.Error()}
	}
	return map[string]interface{}{"ok": true, "tags": p.Tags}, nil
}

// handleObjectsGetTags 读取对象标签。
func handleObjectsGetTags(params json.RawMessage) (interface{}, *RPCError) {
	var p TagsParams
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
	t, e := d.GetTags(bucket, p.Path)
	if e != nil {
		return nil, &RPCError{Code: -32000, Message: "读取标签失败: " + e.Error()}
	}
	return map[string]interface{}{"tags": t}, nil
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
	out := map[string]interface{}{
		"size":     strconv.FormatInt(m.Size, 10),
		"mime":     m.MIME,
		"modified": m.Modified,
		"etag":     m.ETag,
	}
	// 扩展元数据（2.1）：详情面板与编辑弹窗要用。
	// 标签走独立接口 objects/get_tags，不在这里混（避免每次 stat 都多一次请求）。
	out["contentType"] = m.ContentType
	out["contentDisposition"] = m.ContentDisposition
	out["cacheControl"] = m.CacheControl
	out["contentEncoding"] = m.ContentEncoding
	out["storageClass"] = m.StorageClass
	if len(m.UserMetadata) > 0 {
		out["userMetadata"] = m.UserMetadata
	}
	return out, nil
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

// ---------- objects/get_acl / objects/set_acl（公共读，无过期分享） ----------
//
// 与预签名是两条不同的分享路径：预签名 URL 必然带过期时间（S3 协议上限 7 天），
// 而「公共读」是把对象 ACL 设为 public-read，用不带签名的普通 URL 访问——
// 没有过期时间，代价是任何持链接者都能永久访问该对象。因此：
//   - set_acl 属写操作，只读连接一律拒绝（requireWritable）；
//   - 前端必须二次确认并明示风险。

type ObjectAclParams struct {
	Bucket string `json:"bucket"`
	Path   string `json:"path"`
	Public bool   `json:"public"` // 仅 set_acl 使用
}

func handleObjectsGetAcl(params json.RawMessage) (interface{}, *RPCError) {
	var p ObjectAclParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, &RPCError{Code: -32602, Message: "invalid params"}
	}
	d, rerr := getDriver()
	if rerr != nil {
		return nil, rerr
	}
	pub, e := d.GetObjectAcl(p.Bucket, p.Path)
	if e != nil {
		return nil, &RPCError{Code: -32000, Message: "读取对象权限失败: " + e.Error()}
	}
	return map[string]interface{}{"public": pub}, nil
}

func handleObjectsSetAcl(params json.RawMessage) (interface{}, *RPCError) {
	var p ObjectAclParams
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
	if e := d.SetObjectAcl(p.Bucket, p.Path, p.Public); e != nil {
		return nil, &RPCError{Code: -32000, Message: "设置对象权限失败: " + e.Error()}
	}
	return map[string]interface{}{"public": p.Public}, nil
}

// ---------- objects/get_acl_batch（批量读取对象 ACL，用于列表徽标） ----------
//
// 列表页需要标出哪些对象已是公共读。逐对象调 get_acl 会产生 N 次 RPC 与 N 次
// 服务端 API 调用；这里合并为一次 RPC，后端内部顺序读取（阿里云 / MinIO 均无批量
// ACL 接口）。读取失败的单条以 public=false 兜底——徽标「漏标」远好过「把私有
// 误标为公开」，且失败不影响其余对象。
type ObjectAclBatchParams struct {
	Bucket string   `json:"bucket"`
	Paths  []string `json:"paths"`
}

type AclItem struct {
	Path   string `json:"path"`
	Public bool   `json:"public"`
}

func handleObjectsGetAclBatch(params json.RawMessage) (interface{}, *RPCError) {
	var p ObjectAclBatchParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, &RPCError{Code: -32602, Message: "invalid params"}
	}
	if len(p.Paths) == 0 {
		return map[string]interface{}{"items": []AclItem{}}, nil
	}
	d, rerr := getDriver()
	if rerr != nil {
		return nil, rerr
	}
	items := make([]AclItem, 0, len(p.Paths))
	for _, path := range p.Paths {
		if strings.TrimSpace(path) == "" {
			continue
		}
		pub, e := d.GetObjectAcl(p.Bucket, path)
		if e != nil {
			// 单条失败：兜底为私有，不中断其余对象
			items = append(items, AclItem{Path: path, Public: false})
			continue
		}
		items = append(items, AclItem{Path: path, Public: pub})
	}
	return map[string]interface{}{"items": items}, nil
}
