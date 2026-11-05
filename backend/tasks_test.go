package main

// tasks_test.go — 任务记录落盘（rpc_tasks.go）单测。
//
// tasks.jsonl 路径固定在 os.TempDir() 下，测试直接打真路径：
// 用例内部串行执行（append → list → append 超限截断 → clear），
// 并对每个环节断言，结束时清理目录。

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func mustParams(t *testing.T, v interface{}) json.RawMessage {
	t.Helper()
	b, e := json.Marshal(v)
	if e != nil {
		t.Fatalf("marshal params: %v", e)
	}
	return b
}

func TestTasksLifecycle(t *testing.T) {
	path := tasksFilePath()
	_ = os.Remove(path)
	defer func() {
		_ = os.Remove(path)
		_ = os.Remove(filepath.Dir(path))
	}()

	// 1) 空文件 list：不报错、空数组
	r, rerr := handleTasksList(mustParams(t, TaskListParams{}))
	if rerr != nil {
		t.Fatalf("list on missing file: %v", rerr)
	}
	if got := len(r.(map[string]interface{})["tasks"].([]json.RawMessage)); got != 0 {
		t.Fatalf("want empty list, got %d", got)
	}

	// 2) append 3 条 → list 倒序（最新在前）
	for i := 1; i <= 3; i++ {
		rec := mustParams(t, map[string]interface{}{"id": i, "type": "download", "ok": i})
		if _, rerr := handleTasksAppend(mustParams(t, TaskAppendParams{Record: rec})); rerr != nil {
			t.Fatalf("append %d: %v", i, rerr)
		}
	}
	r, rerr = handleTasksList(mustParams(t, TaskListParams{}))
	if rerr != nil {
		t.Fatalf("list: %v", rerr)
	}
	tasks := r.(map[string]interface{})["tasks"].([]json.RawMessage)
	if len(tasks) != 3 {
		t.Fatalf("want 3 tasks, got %d", len(tasks))
	}
	var first struct {
		ID int `json:"id"`
	}
	if e := json.Unmarshal(tasks[0], &first); e != nil {
		t.Fatalf("unmarshal: %v", e)
	}
	if first.ID != 3 {
		t.Fatalf("want newest (id=3) first, got id=%d", first.ID)
	}

	// 3) 坏行被跳过：手工写一行垃圾 + 一行好记录，list 只出好记录
	if e := os.WriteFile(path, append([]byte("{broken json\n"), bytes.Join([][]byte{tasks[2], tasks[1], tasks[0]}, []byte("\n"))...), 0o600); e != nil {
		t.Fatalf("write broken file: %v", e)
	}
	r, rerr = handleTasksList(mustParams(t, TaskListParams{}))
	if rerr != nil {
		t.Fatalf("list with broken line: %v", rerr)
	}
	tasks = r.(map[string]interface{})["tasks"].([]json.RawMessage)
	if len(tasks) != 3 {
		t.Fatalf("broken line should be skipped, got %d tasks", len(tasks))
	}

	// 4) limit：只要 1 条
	r, rerr = handleTasksList(mustParams(t, TaskListParams{Limit: 1}))
	if rerr != nil {
		t.Fatalf("list limit: %v", rerr)
	}
	if got := len(r.(map[string]interface{})["tasks"].([]json.RawMessage)); got != 1 {
		t.Fatalf("want 1 task with limit=1, got %d", got)
	}

	// 5) append 非对象 / 超长：拒绝
	if _, rerr := handleTasksAppend(mustParams(t, TaskAppendParams{Record: json.RawMessage("[1,2]")})); rerr == nil {
		t.Fatal("array record should be rejected")
	}
	big := strings.Repeat("a", tasksMaxLineLen+1)
	if _, rerr := handleTasksAppend(mustParams(t, TaskAppendParams{Record: json.RawMessage(`{"x":"` + big + `"}`)})); rerr == nil {
		t.Fatal("oversized record should be rejected")
	}

	// 6) 截断：写满超限行（每行都小于 1MB 但累计超 1MB）→ truncateTasks 保留最新 300 行
	if e := os.Truncate(path, 0); e != nil {
		t.Fatalf("truncate: %v", e)
	}
	f, e := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if e != nil {
		t.Fatalf("open: %v", e)
	}
	for i := 0; i < tasksKeepLines+50; i++ {
		rec, _ := json.Marshal(map[string]interface{}{"id": i, "pad": strings.Repeat("x", 1024)})
		f.Write(append(rec, '\n'))
	}
	f.Close()
	if e := truncateTasks(path); e != nil {
		t.Fatalf("truncateTasks: %v", e)
	}
	data, e := os.ReadFile(path)
	if e != nil {
		t.Fatalf("read: %v", e)
	}
	n := bytes.Count(data, []byte("\n"))
	if n != tasksKeepLines {
		t.Fatalf("want %d lines after truncation, got %d", tasksKeepLines, n)
	}
	// 保留的是最新 350 行里的最后 300 行 → 首行 id = 50
	var head struct {
		ID int `json:"id"`
	}
	line := data[:bytes.IndexByte(data, '\n')]
	if e := json.Unmarshal(line, &head); e != nil {
		t.Fatalf("unmarshal head: %v", e)
	}
	if head.ID != 50 {
		t.Fatalf("oldest kept line should be id=50, got id=%d", head.ID)
	}

	// 7) clear：文件消失，再 list 回空
	if _, rerr := handleTasksClear(nil); rerr != nil {
		t.Fatalf("clear: %v", rerr)
	}
	if _, e := os.Stat(path); !os.IsNotExist(e) {
		t.Fatalf("tasks file should be removed after clear, stat err = %v", e)
	}
}
