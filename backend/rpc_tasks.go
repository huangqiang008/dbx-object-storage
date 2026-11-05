package main

// rpc_tasks.go — 传输任务记录落盘 RPC（B1 任务中心）。
//
// 为什么放 sidecar 而不是前端 storage：宿主限单 key 256KiB、总量 1MiB，
// 任务清单（含逐 key 失败明细）会超限；且任务历史要跨插件重启留存，
// sidecar 本机文件是唯一可靠的持久层（与上传断点 .part 同一台机器同一进程域）。
//
// 为什么是 jsonl 而不是 json：追加写一行 = 一次 append 系统调用，无读改写竞态；
// 截断策略简单（超限重写保留最新 N 行），崩溃最多丢最后一行。
//
// 后端只做「可靠存取」，不理解也不校验任务语义——记录结构由前端定义：
//
//	{ "id": "...", "type": "download|upload|delete|move|copy", "bucket": "...",
//	  "dstBucket": "...", "dir": "本地下载目录（download 类）", "keys": ["..."],
//	  "ok": 12, "failed": [{"key": "...", "error": "..."}], "cancelled": false, "ts": 1730... }

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

const (
	tasksDirName    = "oss-browser-plugin"
	tasksFileName   = "tasks.jsonl"
	tasksMaxBytes   = 1 << 20 // 1MB：超限滚动截断
	tasksKeepLines  = 300     // 截断时保留的最新行数
	tasksMaxLineLen = 256 << 10 // 单条记录上限 256KiB（正常记录远小于此）
	tasksListLimit  = 500     // list 单次返回上限
)

// tasksMu 串行化文件操作。sidecar 的 RPC loop 虽是串行处理，
// 但不依赖该假设（未来并发化也不出问题），加锁成本可忽略。
var tasksMu sync.Mutex

func tasksFilePath() string {
	return filepath.Join(os.TempDir(), tasksDirName, tasksFileName)
}

// ---------- tasks/append ----------

type TaskAppendParams struct {
	// Record 是完整的一条任务记录（前端组装好的 JSON 对象），后端原样落一行。
	Record json.RawMessage `json:"record"`
}

func handleTasksAppend(params json.RawMessage) (interface{}, *RPCError) {
	var p TaskAppendParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, &RPCError{Code: -32602, Message: "invalid params"}
	}
	// 记录必须是合法 JSON 对象且不超限：jsonl 每行独立解析，坏行会污染整个文件读取
	line := strings.TrimSpace(string(p.Record))
	if len(line) == 0 || line[0] != '{' {
		return nil, &RPCError{Code: -32602, Message: "record 必须是 JSON 对象"}
	}
	if len(line) > tasksMaxLineLen {
		return nil, &RPCError{Code: -32602, Message: "record 超过大小上限"}
	}
	if !json.Valid(p.Record) {
		return nil, &RPCError{Code: -32602, Message: "record 不是合法 JSON"}
	}

	tasksMu.Lock()
	defer tasksMu.Unlock()
	path := tasksFilePath()
	if e := os.MkdirAll(filepath.Dir(path), 0o700); e != nil {
		return nil, &RPCError{Code: -32000, Message: "创建任务目录失败: " + e.Error()}
	}
	f, e := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if e != nil {
		return nil, &RPCError{Code: -32000, Message: "打开任务文件失败: " + e.Error()}
	}
	if _, e := f.WriteString(line + "\n"); e != nil {
		f.Close()
		return nil, &RPCError{Code: -32000, Message: "写入任务失败: " + e.Error()}
	}
	if e := f.Close(); e != nil {
		return nil, &RPCError{Code: -32000, Message: "写入任务失败: " + e.Error()}
	}
	// 追加后检查大小，超限则滚动截断（保留最新 tasksKeepLines 行）。
	// 失败不影响本次追加结果——截断是尽力而为的维护动作。
	if st, e := os.Stat(path); e == nil && st.Size() > tasksMaxBytes {
		_ = truncateTasks(path)
	}
	return map[string]interface{}{"ok": true}, nil
}

// truncateTasks 重写文件只保留最新 tasksKeepLines 行。调用方需持有 tasksMu。
func truncateTasks(path string) error {
	data, e := os.ReadFile(path)
	if e != nil {
		return e
	}
	// 从头数行：保留「最后 N 行」 = 丢弃前面超出的行
	var lines []string
	start := 0
	for i := 0; i <= len(data); i++ {
		if i == len(data) || data[i] == '\n' {
			if i > start {
				lines = append(lines, string(data[start:i]))
			}
			start = i + 1
		}
	}
	if len(lines) <= tasksKeepLines {
		return nil
	}
	keep := lines[len(lines)-tasksKeepLines:]
	tmp := path + ".tmp"
	out := make([]byte, 0, tasksMaxBytes)
	for _, l := range keep {
		out = append(out, l...)
		out = append(out, '\n')
	}
	if e := os.WriteFile(tmp, out, 0o600); e != nil {
		return e
	}
	return os.Rename(tmp, path) // 同目录 rename，原子替换
}

// ---------- tasks/list ----------

type TaskListParams struct {
	Limit int `json:"limit"` // 默认 200，最大 tasksListLimit
}

// 返回最新记录在前（倒序），limit 条。
func handleTasksList(params json.RawMessage) (interface{}, *RPCError) {
	var p TaskListParams
	if len(params) > 0 {
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, &RPCError{Code: -32602, Message: "invalid params"}
		}
	}
	limit := p.Limit
	if limit <= 0 {
		limit = 200
	}
	if limit > tasksListLimit {
		limit = tasksListLimit
	}

	tasksMu.Lock()
	defer tasksMu.Unlock()
	path := tasksFilePath()
	f, e := os.Open(path)
	if e != nil {
		if os.IsNotExist(e) {
			// 无历史是常态，不是错误
			return map[string]interface{}{"tasks": []json.RawMessage{}}, nil
		}
		return nil, &RPCError{Code: -32000, Message: "读取任务失败: " + e.Error()}
	}
	defer f.Close()

	// 全量读入后取尾部：文件被 1MB 上限 + 滚动截断约束，内存可控
	var all []json.RawMessage
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64*1024), tasksMaxLineLen+(1<<20))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || !json.Valid([]byte(line)) {
			continue // 跳过坏行（崩溃可能留下半行），不污染列表
		}
		all = append(all, json.RawMessage(line))
	}
	// 倒序取前 limit 条（最新在前）
	n := len(all)
	if n > limit {
		n = limit
	}
	out := make([]json.RawMessage, 0, n)
	for i := 0; i < n; i++ {
		out = append(out, all[len(all)-1-i])
	}
	return map[string]interface{}{"tasks": out}, nil
}

// ---------- tasks/clear ----------

func handleTasksClear(params json.RawMessage) (interface{}, *RPCError) {
	tasksMu.Lock()
	defer tasksMu.Unlock()
	e := os.Remove(tasksFilePath())
	if e != nil && !os.IsNotExist(e) {
		return nil, &RPCError{Code: -32000, Message: "清空任务失败: " + e.Error()}
	}
	return map[string]interface{}{"ok": true}, nil
}
