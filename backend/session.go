package main

// session.go — 按连接 ID 隔离的多会话表。
//
// 为什么需要：Sidecar 进程按插件共享、跨标签页复用（一个 DBX 进程只起一个
// backend）。若连接状态是全局单例，后打开的连接会覆盖先打开的：
//
//	标签页 A 连接 OSS-1  →  state = driver(OSS-1)
//	标签页 B 连接 OSS-2  →  state = driver(OSS-2)   ← OSS-1 被覆盖
//	切回标签页 A 操作    →  用 OSS-2 的凭证访问 OSS-1 的桶 → 报错
//
// 更糟的是写操作可能落到错误的存储服务上。Sidecar Protocol v1 因此规定
// connection/connect「用 connection.id 作为 key 建立会话，且幂等」——本文件
// 就是该约定的实现：每个连接一份独立的 cfg + driver，互不干扰。

import (
	"encoding/json"
	"strings"
	"sync"
)

// defaultConnID 是未携带连接标识时的兜底会话 key。
//
// 保留它有两个原因：
//  1. 向后兼容——旧版前端 / 未注入 connectionId 的调用仍走同一会话，
//     行为与单例时代一致，不会因为升级而突然「未连接」；
//  2. 插件自带连接表单在没有宿主连接上下文时，本来就只有一个活动连接。
const defaultConnID = "default"

// maxSessions 限制并存会话数。
//
// 会话里持有 AccessKeySecret 等凭据，标签页关闭时宿主不一定会下发
// connection/disconnect，无上限会让凭据在内存里越积越多。超限按最久未用淘汰，
// 正常使用时（几个到十几个标签页）永远碰不到这个上限。
const maxSessions = 32

// PluginState 单个连接的会话状态。driver 由 newDriver 按 provider 构造，
// handler 层不感知具体厂商实现。
type PluginState struct {
	cfg    ConnConfig
	driver StorageDriver
	// seq 是最近一次使用的全局递增序号，用于超限时做 LRU 淘汰。
	// 用序号而不是 time.Now()：Windows 时钟精度粗，密集建会话时可能同值，
	// 淘汰顺序不确定；单调序号保证严格有序。
	seq uint64
}

var (
	sessions   = map[string]*PluginState{}
	sessionsMu sync.Mutex
	sessionSeq uint64 // 全局递增，只在持有 sessionsMu 时读写

	// currentConn 是「本次请求」的连接标识，由 dispatch 在解析 params 后设置，
	// getDriver / requireWritable / currentBucket 据此定位会话。
	//
	// 用请求级变量而不是逐 handler 传参，是因为 RPC 主循环严格串行
	//（main.go：逐行读 → dispatch → 同步写回），同一时刻只有一个请求在处理，
	// 因此不存在跨请求串味。这样 27 处 getDriver() 与 15 处 requireWritable()
	// 调用点无需改动，diff 集中在会话层。
	//
	// 若将来把 dispatch 改成并发处理，必须把它改为随请求显式传递
	//（如 context.Context 或 handler 入参），否则会读到别的请求的连接。
	currentConn = defaultConnID
)

// extractConnID 从请求参数解析连接标识。
//
// 优先级：
//  1. 顶层 connectionId —— 插件自带 UI 在每个 invoke 上显式注入
//     （宿主托管连接取 context.connectionId，自建表单取本标签页生成的会话 ID）；
//  2. connection.id —— 宿主生命周期请求（connection/connect 等）的标准形状；
//  3. defaultConnID —— 两者都没有时兜底，保持旧版单会话行为。
//
// 解析失败（params 为空 / 非法 JSON / 非对象）一律兜底，不报错：
// 连接标识只影响会话路由，不该让业务请求因为拿不到它而失败。
func extractConnID(params json.RawMessage) string {
	if len(params) == 0 {
		return defaultConnID
	}
	var probe struct {
		ConnectionID string `json:"connectionId"`
		Connection   struct {
			ID string `json:"id"`
		} `json:"connection"`
	}
	if err := json.Unmarshal(params, &probe); err != nil {
		return defaultConnID
	}
	if s := strings.TrimSpace(probe.ConnectionID); s != "" {
		return s
	}
	if s := strings.TrimSpace(probe.Connection.ID); s != "" {
		return s
	}
	return defaultConnID
}

// putSession 建立（或替换）指定连接的会话。
//
// 幂等：同一 connID 重复 connect 会用新 driver 覆盖旧会话——这既是协议要求，
// 也让「同一标签页改参数重连」自然生效。淘汰仅在超限时触发。
func putSession(connID string, cfg ConnConfig, driver StorageDriver) {
	sessionsMu.Lock()
	defer sessionsMu.Unlock()
	if _, exists := sessions[connID]; !exists && len(sessions) >= maxSessions {
		evictOldestLocked()
	}
	sessionSeq++
	sessions[connID] = &PluginState{cfg: cfg, driver: driver, seq: sessionSeq}
}

// evictOldestLocked 淘汰最久未使用的会话。调用方须持有 sessionsMu。
func evictOldestLocked() {
	oldestKey, oldestSeq := "", uint64(0)
	for k, s := range sessions {
		if oldestKey == "" || s.seq < oldestSeq {
			oldestKey, oldestSeq = k, s.seq
		}
	}
	if oldestKey != "" {
		delete(sessions, oldestKey)
	}
}

// dropSession 拆除指定连接的会话。幂等：不存在的 key 直接返回。
func dropSession(connID string) {
	sessionsMu.Lock()
	defer sessionsMu.Unlock()
	delete(sessions, connID)
}

// getSession 取指定连接的会话快照，并刷新其 seq（供 LRU 淘汰）。
// 未连接时返回 nil。
func getSession(connID string) *PluginState {
	sessionsMu.Lock()
	defer sessionsMu.Unlock()
	s := sessions[connID]
	if s != nil {
		sessionSeq++
		s.seq = sessionSeq
	}
	return s
}

// sessionCount 返回当前并存会话数（诊断与测试用）。
func sessionCount() int {
	sessionsMu.Lock()
	defer sessionsMu.Unlock()
	return len(sessions)
}

// resetSessions 清空全部会话（仅测试用）。
func resetSessions() {
	sessionsMu.Lock()
	defer sessionsMu.Unlock()
	sessions = map[string]*PluginState{}
	currentConn = defaultConnID
}
