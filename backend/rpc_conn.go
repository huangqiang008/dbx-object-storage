package main

// rpc_conn.go — 连接与桶 RPC handler。

import "encoding/json"

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
	// 按连接 ID 存会话（幂等：同一 ID 重复连接会替换旧 driver）。
	// 这样多个标签页各自的连接互不覆盖——见 session.go 的问题背景。
	putSession(currentConn, c, d)
	// 预热 Windows 常驻目录选择器：首次点击批量下载时对话框毫秒级弹出，
	// 不用等 PowerShell 冷启动。fire-and-forget，失败静默（点击时还有回退）。
	warmPicker()
	return map[string]interface{}{"ok": true, "message": "连接成功"}, nil
}

func handleConnectionDisconnect(params json.RawMessage) (interface{}, *RPCError) {
	// 只拆除本次请求所属的连接，不影响其他标签页仍在使用的会话。
	dropSession(currentConn)
	return map[string]interface{}{"ok": true}, nil
}

// handleConnectionStatus：UI 启动时询问 Sidecar 当前是否已连接。
// 宿主打开已保存连接时会先调 connection/connect（凭据已在 Sidecar 内存中），
// UI 据此跳过凭据表单直接进入浏览视图，避免重复填写 Key。
//
// 只回答「本标签页所属连接」的状态：宿主托管连接带 connection.id，
// 自建表单带前端注入的 connectionId，两者都查不到才回退 default 会话。
func handleConnectionStatus(params json.RawMessage) (interface{}, *RPCError) {
	s := getSession(currentConn)
	if s == nil || s.driver == nil {
		return map[string]interface{}{"connected": false}, nil
	}
	cfg := s.cfg
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
