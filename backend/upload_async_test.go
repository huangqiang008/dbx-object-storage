package main

// upload_async_test.go — 异步上传任务（issue #11 第二批）的行为测试。
//
// 重点验证这次改动引入的新语义：
//  1. complete **立即返回** taskId，不等上传结束（主循环不再被独占）；
//  2. 上传在后台真正完成，status 可查到终态；
//  3. 上传进行中主循环仍能处理其他请求（多文件真并发的前提）；
//  4. cancel 能中止进行中的任务；
//  5. 进度事件按协议推送，且不含凭据；
//  6. 驱动未实现 ProgressUploader 时退化到原路径，功能不回归。
//
// ⚠️ complete 由同步改异步是**行为破坏性变更**：前端若仍按"返回即完成"处理，
// 会在文件传完前就报成功、刷新列表看不到新文件。前端必须配套改造。

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// ---------- 可控阻塞的驱动 ----------

// blockingDriver 嵌入 mockDriver 复用其全部接口实现，只覆写上传路径。
// release 通道控制"上云"何时结束，用于确定性地验证异步语义（不靠 sleep 猜时间）。
type blockingDriver struct {
	*mockDriver

	release  chan struct{} // 关闭后上传返回
	started  chan struct{} // 上传开始时关闭，供测试确认已进入后台任务
	failWith error         // 非 nil 时上传失败

	mu            sync.Mutex
	progressCalls []progressCall
	cancelled     bool
	putCalls      int
}

type progressCall struct {
	sent  int64
	total int64
}

func newBlockingDriver() *blockingDriver {
	return &blockingDriver{
		mockDriver: &mockDriver{objects: map[string]mockObject{}},
		release:    make(chan struct{}),
		started:    make(chan struct{}),
	}
}

// releaseUpload 放行阻塞的上传。
func (d *blockingDriver) releaseUpload() { close(d.release) }

// waitStarted 等待后台任务真正开始上传，超时则失败。
func (d *blockingDriver) waitStarted(t *testing.T) {
	t.Helper()
	select {
	case <-d.started:
	case <-time.After(5 * time.Second):
		t.Fatal("后台上传任务未在 5s 内启动（complete 可能仍在同步执行）")
	}
}

func (d *blockingDriver) markStartedOnce() {
	select {
	case <-d.started:
	default:
		close(d.started)
	}
}

func (d *blockingDriver) PutFromFileWithClass(bucket, path, filePath, mime, storageClass string) error {
	d.mu.Lock()
	d.putCalls++
	d.mu.Unlock()
	d.markStartedOnce()
	<-d.release
	if d.failWith != nil {
		return d.failWith
	}
	return d.mockDriver.PutFromFile(bucket, path, filePath, mime)
}

// PutFromFileWithProgress 实现 ProgressUploader：上报进度，并响应 ctx 取消。
func (d *blockingDriver) PutFromFileWithProgress(ctx context.Context, bucket, path, filePath, mime, storageClass string, onProgress func(sent, total int64)) error {
	d.mu.Lock()
	d.putCalls++
	d.mu.Unlock()
	d.markStartedOnce()

	total, _ := fileSize(filePath)
	// 先推两次进度，验证回调链路
	if onProgress != nil {
		onProgress(total/2, total)
		onProgress(total, total)
	}
	d.mu.Lock()
	d.progressCalls = append(d.progressCalls, progressCall{total / 2, total}, progressCall{total, total})
	d.mu.Unlock()

	if ctx == nil {
		ctx = context.Background()
	}
	select {
	case <-d.release:
	case <-ctx.Done():
		d.mu.Lock()
		d.cancelled = true
		d.mu.Unlock()
		return ctx.Err()
	}
	if d.failWith != nil {
		return d.failWith
	}
	return d.mockDriver.PutFromFile(bucket, path, filePath, mime)
}

func fileSize(p string) (int64, error) {
	st, err := os.Stat(p)
	if err != nil {
		return 0, err
	}
	return st.Size(), nil
}

// ---------- stdout 事件捕获 ----------

type lockedWriter struct {
	buf *bytes.Buffer
	mu  *sync.Mutex
}

func (w *lockedWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.buf.Write(p)
}

// captureStdout 把协议输出重定向到内存，返回「读取已捕获消息」的函数。
// sendLocked 在测试中也会走这里（stdoutW 非 nil），因此能捕获 notify 的事件。
func captureStdout(t *testing.T) func() []map[string]interface{} {
	t.Helper()
	var buf bytes.Buffer
	var mu sync.Mutex
	w := bufio.NewWriter(&lockedWriter{buf: &buf, mu: &mu})

	stdoutMu.Lock()
	old := stdoutW
	stdoutW = w
	stdoutMu.Unlock()

	t.Cleanup(func() {
		stdoutMu.Lock()
		_ = stdoutW.Flush()
		stdoutW = old
		stdoutMu.Unlock()
	})

	return func() []map[string]interface{} {
		stdoutMu.Lock()
		_ = stdoutW.Flush()
		stdoutMu.Unlock()
		mu.Lock()
		data := buf.String()
		mu.Unlock()

		var out []map[string]interface{}
		for _, line := range strings.Split(data, "\n") {
			line = strings.TrimSpace(line)
			if line == "" {
				continue
			}
			var m map[string]interface{}
			if json.Unmarshal([]byte(line), &m) == nil {
				out = append(out, m)
			}
		}
		return out
	}
}

// ---------- 测试工具 ----------

// prepareUploadSession 造一个"第一跳已完成、等待上云"的上传会话。
// 返回 uploadId 与分片文件路径。
func prepareUploadSession(t *testing.T, drv StorageDriver, bucket, key, content string) (string, string) {
	t.Helper()
	stem := uploadStem(currentConn, bucket, key, int64(len(content)))
	partPath := filepath.Join(os.TempDir(), stem+".part")
	metaPath := strings.TrimSuffix(partPath, ".part") + ".meta"
	if e := os.WriteFile(partPath, []byte(content), 0o600); e != nil {
		t.Fatal(e)
	}
	f, e := os.OpenFile(partPath, os.O_RDWR, 0o600)
	if e != nil {
		t.Fatal(e)
	}
	id := "sess-" + key
	uploadsMu.Lock()
	uploads[id] = &uploadSession{
		id: id, connID: currentConn, file: f, tmpPath: partPath, metaPath: metaPath,
		bucket: bucket, key: key, mime: "text/plain",
		size: int64(len(content)), written: int64(len(content)),
	}
	uploadsMu.Unlock()

	t.Cleanup(func() {
		f.Close()
		os.Remove(partPath)
		os.Remove(metaPath)
	})
	return id, partPath
}

// waitTaskState 轮询等待任务进入指定状态，超时失败。
func waitTaskState(t *testing.T, taskID, want string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		tk := getTask(taskID)
		if tk != nil {
			tk.mu.Lock()
			st := tk.state
			tk.mu.Unlock()
			if st == want {
				return
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	tk := getTask(taskID)
	got := "<任务不存在>"
	if tk != nil {
		got = tk.snapshot()["state"].(string)
	}
	t.Fatalf("任务 %s 未在 5s 内进入 %s，当前 %s", taskID, want, got)
}

// ---------- 测试 ----------

// TestUploadComplete_ReturnsImmediatelyWhileUploading 核心断言：
// complete 在上传仍被阻塞时就返回 taskId，证明主循环没有被独占。
func TestUploadComplete_ReturnsImmediatelyWhileUploading(t *testing.T) {
	uploadE2E(t, func() {
		drv := newBlockingDriver()
		withTestSession(t, ConnConfig{Bucket: "b"}, drv)

		id, _ := prepareUploadSession(t, drv, "b", "big.bin", "hello-world")

		start := time.Now()
		res, rerr := call(t, "upload/complete", `{"uploadId":"`+id+`"}`)
		elapsed := time.Since(start)
		if rerr != nil {
			t.Fatalf("complete 不应报错: %s", rerr.Message)
		}

		// 上传仍被 release 通道阻塞着，complete 却必须已经返回
		if elapsed > 2*time.Second {
			t.Errorf("complete 应立即返回（异步），实际耗时 %v", elapsed)
		}
		m := res.(map[string]interface{})
		taskID, _ := m["taskId"].(string)
		if taskID == "" {
			t.Fatalf("complete 应返回 taskId, got %v", m)
		}
		if async, _ := m["async"].(bool); !async {
			t.Errorf("complete 应标记 async=true")
		}

		drv.waitStarted(t) // 后台任务确实在跑
		drv.releaseUpload()
		waitTaskState(t, taskID, taskDone)
	})
}

// TestUploadStatus_MainLoopNotBlocked 上传进行中，主循环仍能处理其他请求。
// 这是"3 路并发真正生效"的前提——原先 complete 同步执行时其他请求全被堵住。
func TestUploadStatus_MainLoopNotBlocked(t *testing.T) {
	uploadE2E(t, func() {
		drv := newBlockingDriver()
		withTestSession(t, ConnConfig{Bucket: "b"}, drv)

		id, _ := prepareUploadSession(t, drv, "b", "big.bin", "hello-world")
		res, rerr := call(t, "upload/complete", `{"uploadId":"`+id+`"}`)
		if rerr != nil {
			t.Fatalf("complete 失败: %s", rerr.Message)
		}
		taskID := res.(map[string]interface{})["taskId"].(string)
		drv.waitStarted(t)

		// 上传被阻塞期间，这些请求必须都能立刻得到响应
		if _, e := call(t, "upload/status", `{"taskId":"`+taskID+`"}`); e != nil {
			t.Errorf("上传进行中应能查 status: %s", e.Message)
		}
		if _, e := call(t, "connection/status", `{}`); e != nil {
			t.Errorf("上传进行中应能查连接状态: %s", e.Message)
		}

		st, _ := call(t, "upload/status", `{"taskId":"`+taskID+`"}`)
		if got := st.(map[string]interface{})["state"]; got != taskRunning {
			t.Errorf("任务应为 running, got %v", got)
		}

		drv.releaseUpload()
		waitTaskState(t, taskID, taskDone)
	})
}

// TestUploadCancel_StopsRunningTask cancel 应中止进行中的任务。
func TestUploadCancel_StopsRunningTask(t *testing.T) {
	uploadE2E(t, func() {
		drv := newBlockingDriver()
		withTestSession(t, ConnConfig{Bucket: "b"}, drv)

		id, _ := prepareUploadSession(t, drv, "b", "big.bin", "hello-world")
		res, _ := call(t, "upload/complete", `{"uploadId":"`+id+`"}`)
		taskID := res.(map[string]interface{})["taskId"].(string)
		drv.waitStarted(t)

		if _, rerr := call(t, "upload/cancel", `{"taskId":"`+taskID+`"}`); rerr != nil {
			t.Fatalf("cancel 不应报错: %s", rerr.Message)
		}
		waitTaskState(t, taskID, taskCancelled)

		drv.mu.Lock()
		sawCancel := drv.cancelled
		drv.mu.Unlock()
		if !sawCancel {
			t.Errorf("驱动应观察到 context 取消（否则取消只是标记状态，上传仍在跑）")
		}
		// cancel 幂等
		if _, rerr := call(t, "upload/cancel", `{"taskId":"`+taskID+`"}`); rerr != nil {
			t.Errorf("重复 cancel 应幂等, got %s", rerr.Message)
		}
	})
}

// TestUploadProgress_EventsPushed 进度事件按协议推送，且不含凭据。
func TestUploadProgress_EventsPushed(t *testing.T) {
	uploadE2E(t, func() {
		read := captureStdout(t)
		drv := newBlockingDriver()
		withTestSession(t, ConnConfig{Bucket: "b", AccessKeySecret: "SUPER-SECRET"}, drv)

		id, _ := prepareUploadSession(t, drv, "b", "big.bin", "hello-world")
		res, _ := call(t, "upload/complete", `{"uploadId":"`+id+`"}`)
		taskID := res.(map[string]interface{})["taskId"].(string)
		drv.waitStarted(t)
		drv.releaseUpload()
		waitTaskState(t, taskID, taskDone)

		msgs := read()
		var progressEvents []map[string]interface{}
		for _, m := range msgs {
			if m["method"] == uploadProgressEvent {
				progressEvents = append(progressEvents, m)
			}
		}
		if len(progressEvents) == 0 {
			t.Fatalf("应至少推送一条进度事件，实际收到 %d 条消息: %v", len(msgs), msgs)
		}
		// 必须有终态事件（前端靠它结束等待）
		hasTerminal := false
		for _, ev := range progressEvents {
			p, _ := ev["params"].(map[string]interface{})
			if p != nil && p["state"] == taskDone {
				hasTerminal = true
			}
			if p != nil && p["taskId"] != taskID {
				t.Errorf("事件 taskId 应匹配, got %v want %s", p["taskId"], taskID)
			}
		}
		if !hasTerminal {
			t.Errorf("应推送终态(%s)事件, got %+v", taskDone, progressEvents)
		}
		// 事件是 JSON-RPC 通知：无 id
		for _, ev := range progressEvents {
			if _, has := ev["id"]; has {
				t.Errorf("进度事件应是无 id 的通知, got %v", ev)
			}
		}
		// 绝不泄露凭据
		raw, _ := json.Marshal(msgs)
		if strings.Contains(string(raw), "SUPER-SECRET") {
			t.Errorf("进度事件不得包含凭据")
		}
	})
}

// TestUploadFailure_TaskMarkedFailed 上传失败时任务进入 failed 且保留分片供续传。
func TestUploadFailure_TaskMarkedFailed(t *testing.T) {
	uploadE2E(t, func() {
		drv := newBlockingDriver()
		drv.failWith = os.ErrPermission
		withTestSession(t, ConnConfig{Bucket: "b"}, drv)

		id, partPath := prepareUploadSession(t, drv, "b", "big.bin", "hello-world")
		res, _ := call(t, "upload/complete", `{"uploadId":"`+id+`"}`)
		taskID := res.(map[string]interface{})["taskId"].(string)
		drv.waitStarted(t)
		drv.releaseUpload()
		waitTaskState(t, taskID, taskFailed)

		st, _ := call(t, "upload/status", `{"taskId":"`+taskID+`"}`)
		m := st.(map[string]interface{})
		if errMsg, _ := m["error"].(string); errMsg == "" {
			t.Errorf("失败任务应带错误信息")
		}
		// 失败保留 .part：下次 begin 可断点续传，用户已传的字节不白费
		if _, e := os.Stat(partPath); e != nil {
			t.Errorf("上传失败应保留分片以便续传: %v", e)
		}
	})
}

// TestUploadComplete_FallsBackWithoutProgress 驱动未实现 ProgressUploader 时，
// 退化到 PutFromFileWithClass，功能不回归（进度为空但上传照常完成）。
func TestUploadComplete_FallsBackWithoutProgress(t *testing.T) {
	uploadE2E(t, func() {
		plain := &mockDriver{objects: map[string]mockObject{}}
		withTestSession(t, ConnConfig{Bucket: "b"}, plain)
		if _, ok := interface{}(plain).(ProgressUploader); ok {
			t.Fatal("mockDriver 不应实现 ProgressUploader，否则测不到退化路径")
		}

		id, _ := prepareUploadSession(t, plain, "b", "plain.bin", "data")
		res, rerr := call(t, "upload/complete", `{"uploadId":"`+id+`"}`)
		if rerr != nil {
			t.Fatalf("complete 失败: %s", rerr.Message)
		}
		taskID := res.(map[string]interface{})["taskId"].(string)
		waitTaskState(t, taskID, taskDone)
	})
}

// TestUploadStatus_RejectsOtherConnection 一个连接不能查/取消另一个连接的任务
// （任务快照含 bucket 与 key，属连接私有信息）。
func TestUploadStatus_RejectsOtherConnection(t *testing.T) {
	uploadE2E(t, func() {
		drv := newBlockingDriver()
		withTestSession(t, ConnConfig{Bucket: "b"}, drv)

		id, _ := prepareUploadSession(t, drv, "b", "secret.bin", "hello-world")
		res, _ := call(t, "upload/complete", `{"uploadId":"`+id+`"}`)
		taskID := res.(map[string]interface{})["taskId"].(string)
		drv.waitStarted(t)

		// 换个连接去查：应报"不存在"，不泄露任务详情。
		// 注意必须通过 params 传 connectionId——dispatch 每次都会用它重设
		// currentConn，直接改包级变量会被覆盖。
		if _, rerr := call(t, "upload/status",
			`{"taskId":"`+taskID+`","connectionId":"other-conn"}`); rerr == nil {
			t.Errorf("其他连接不应能查到该任务")
		}
		if _, rerr := call(t, "upload/cancel",
			`{"taskId":"`+taskID+`","connectionId":"other-conn"}`); rerr != nil {
			t.Errorf("cancel 对不属于自己的任务应幂等返回 ok, got %s", rerr.Message)
		}
		// 别人的 cancel 不应影响任务：仍应在放行后正常完成
		drv.releaseUpload()
		waitTaskState(t, taskID, taskDone)
	})
}

// TestUploadComplete_DoneCleansPartFiles 成功后分片文件必须清掉，不留垃圾。
func TestUploadComplete_DoneCleansPartFiles(t *testing.T) {
	uploadE2E(t, func() {
		drv := newBlockingDriver()
		withTestSession(t, ConnConfig{Bucket: "b"}, drv)

		id, partPath := prepareUploadSession(t, drv, "b", "big.bin", "hello-world")
		res, _ := call(t, "upload/complete", `{"uploadId":"`+id+`"}`)
		taskID := res.(map[string]interface{})["taskId"].(string)
		drv.waitStarted(t)
		drv.releaseUpload()
		waitTaskState(t, taskID, taskDone)

		// 给清理一点时间（清理在状态置位之后）
		deadline := time.Now().Add(2 * time.Second)
		for time.Now().Before(deadline) {
			if _, e := os.Stat(partPath); os.IsNotExist(e) {
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
		t.Errorf("上传成功后应删除分片文件 %s", filepath.Base(partPath))
	})
}
