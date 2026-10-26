package main

// oss.go — RPC 层核心：plugin/initialize、驱动获取、通知分发。
// 各域 handler 按工程化拆分：
//   rpc_conn.go     连接与桶
//   rpc_objects.go  对象列举/读写/删除
//   rpc_transfer.go 移动/复制（含跨桶）
//   rpc_meta.go     元数据/标签/ACL/presign
//   rpc_upload.go   大文件分片上传
//   rpc_download.go 下载落盘（objects/save）
// 只面向 StorageDriver 接口，不含任何厂商 SDK 类型；连接参数解析与驱动工厂见 driver.go。

import (
	"encoding/json"
	"log"
)

// pluginVersion 必须与 manifest.json 的 version 及 ui/main.js 的 BUILD 一致。
// dev 宿主会在 plugin/initialize 回包中校验 info.plugin.id/version。
// v0.2.0 起由 com.aliyun.oss.browser 改为通用 ID（阿里云 OSS / MinIO / S3 兼容）。
const pluginVersion = "1.2.0"

// pluginID 必须与 manifest.json 的 id 完全一致，
// dev 宿主会在 plugin/initialize 回包中校验 info.plugin.id/version。
// v0.2.0 起由 com.aliyun.oss.browser 改为通用 ID（阿里云 OSS / MinIO / S3 兼容）。
const pluginID = "com.object.browser"

// handleInitialize 对应 DBX 宿主在 sidecar 启动后下发的 plugin/initialize。
// 回包形状必须严格匹配 sidecar 协议 v1（参考官方 dbx-plugin-sdk 的 initialize）：
//   - protocolVersion: 数字
//   - capabilities:    字符串数组（sequence），不是对象（map）
//   - plugin:          { id, version }
//
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


func handleNotification(req Request) {
	// 例如 plugin/initialized、objects/changed 等通知，无需回复
	log.Printf("notification: %s", req.Method)
}
