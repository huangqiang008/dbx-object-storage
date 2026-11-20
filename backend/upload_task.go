package main

// upload_task.go — 异步上传任务：把「真正上云」从 RPC 主循环里挪出去。
//
// 为什么需要（issue #11 第二批）：
// RPC 主循环是串行的（main.go：逐行读 → dispatch → 写回）。原先
// upload/complete 在主循环里同步调用驱动上传整个文件，200MB 在 500KB/s
// 上行下要 6.7 分钟——这期间**主循环被独占**，其他标签页、其他并发文件的
// 任何请求（连 upload/chunk 都算）全部排队。前端 3 路并发因此形同虚设，
// 多文件总耗时 ≈ 各文件上云时间之和。
//
// 改为：complete 立即返回 taskId，真正上传在后台 goroutine 执行，
// 进度经 stdout 事件推送（notify）。主循环不再被长任务阻塞，多文件真并发。
//
// ⚠️ 并发要点：getDriver() 依赖包级变量 currentConn，而它由 dispatch 按请求
// 设置。后台 goroutine 执行时主循环早已处理完别的请求、currentConn 已被改写，
// 因此**必须在同步阶段取好 driver 再交给 goroutine**，绝不能在 goroutine 里
// 调 getDriver()——否则会用到别的连接的凭证（正是 #10 修的那类问题）。

import (
	"context"
	"log"
	"sort"
	"sync"
	"time"
)

// ProgressUploader 是驱动的**可选**能力：带进度回调与可取消上下文的上传。
//
// 用可选接口而非改 StorageDriver 主接口，是为了不惊动现有调用点与测试替身：
// 未实现它的驱动自动退化为「无进度、不可取消」的原有行为，功能不回归。
type ProgressUploader interface {
	// PutFromFileWithProgress 从本地文件上传。
	//   - ctx 取消后应尽快中止并返回错误；
	//   - onProgress 报告已上传字节与总字节，可能从 SDK 的回调线程调用，
	//     实现必须自己保证并发安全（本文件的 task 已做）。
	PutFromFileWithProgress(ctx context.Context, bucket, path, filePath, mime, storageClass string, onProgress func(sent, total int64)) error
}

// 任务状态机。字符串而非枚举：直接进 JSON 回包与事件，前后端不用维护映射表。
const (
	taskRunning   = "running"
	taskDone      = "done"
	taskFailed    = "failed"
	taskCancelled = "cancelled"
)

// uploadIdleTimeout 上传空闲超时。
//
// 刻意用「无进度」而不是固定 deadline：200MB 大文件在慢速上行下可能合法地
// 传输十几分钟，固定 deadline 会误杀健康的传输；而真正卡死（网络断、对端挂）
// 一定表现为进度长时间不动。前端原先的 timeoutMs:600000 就是固定 deadline，
// 属同一类问题，第二批一并去掉。
const uploadIdleTimeout = 10 * time.Minute

// progressEventInterval 进度事件最小间隔。
// 阿里云 SDK 每 8KB 就回调一次，200MB 会产生 2.5 万条事件——逐条推会把
// stdout 打成瓶颈（还要和 RPC 响应抢同一把锁）。节流到 200ms 足够顺滑。
const progressEventInterval = 200 * time.Millisecond

// uploadProgressEvent 推送给前端的进度事件名（协议：<plugin>/progress 形式）。
const uploadProgressEvent = pluginID + "/uploadProgress"

type uploadTask struct {
	id     string
	connID string
	// driver 在同步阶段取好并固定，goroutine 内不再查会话（见文件头警告）。
	driver       StorageDriver
	bucket       string
	key          string
	tmpPath      string
	metaPath     string
	mime         string
	storageClass string
	size         int64

	mu           sync.Mutex
	state        string
	sent         int64
	errMsg       string
	lastProgress time.Time
	lastEmit     time.Time
	cancel       context.CancelFunc
}

// snapshot 返回给前端的任务状态（只读副本，避免把 *uploadTask 直接暴露出去）。
func (t *uploadTask) snapshot() map[string]interface{} {
	t.mu.Lock()
	defer t.mu.Unlock()
	return map[string]interface{}{
		"taskId": t.id,
		"state":  t.state,
		"sent":   t.sent,
		"total":  t.size,
		"error":  t.errMsg,
		"bucket": t.bucket,
		"key":    t.key,
	}
}

// onProgress 是交给驱动的进度回调。SDK 可能从任意线程高频调用，
// 这里做加锁累计 + 节流推送。
func (t *uploadTask) onProgress(sent, total int64) {
	t.mu.Lock()
	if t.state != taskRunning { // 已取消/结束，不再更新也不再推事件
		t.mu.Unlock()
		return
	}
	t.sent = sent
	if total > 0 {
		t.size = total
	}
	t.lastProgress = time.Now()
	// 节流：不足间隔就只更新计数，不发事件（终态由 run 末尾单独发）
	if time.Since(t.lastEmit) < progressEventInterval {
		t.mu.Unlock()
		return
	}
	t.lastEmit = time.Now()
	snapshotSent, snapshotTotal := t.sent, t.size
	t.mu.Unlock()

	notify(uploadProgressEvent, map[string]interface{}{
		"taskId": t.id,
		"sent":   snapshotSent,
		"total":  snapshotTotal,
		"state":  taskRunning,
	})
}

var (
	uploadTasksMu sync.Mutex
	uploadTasks   = map[string]*uploadTask{}
)

// taskKeepFinished 终态任务的保留时长；taskKeepMaxCount 是任务表数量上限。
//
// 两者缺一不可：
//   - 只按数量清理：低频使用时终态任务会一直驻留（每个持有文件路径等字段），
//     长期运行的 sidecar 内存只增不减；
//   - 只按时长清理：短时间大批量上传会瞬间堆积远超预期的条目。
//
// 保留一小段时间是必要的——事件可能丢失，前端会用 upload/status 兜底回查，
// 刚结束就删会让回查拿到"任务不存在"。
const (
	taskKeepFinished = 5 * time.Minute
	taskKeepMaxCount = 256
)

func registerTask(t *uploadTask) {
	uploadTasksMu.Lock()
	defer uploadTasksMu.Unlock()
	uploadTasks[t.id] = t
	pruneFinishedTasksLocked()
}

// pruneFinishedTasksLocked 清理终态任务：先按保留时长淘汰过期的，
// 仍超量再按「最久未推进」淘汰。调用方须持有 uploadTasksMu。
func pruneFinishedTasksLocked() {
	now := time.Now()

	// 1) 时长维度：终态且超过保留期的直接删
	type ent struct {
		id string
		at time.Time
	}
	var terminal []ent
	for id, t := range uploadTasks {
		t.mu.Lock()
		isTerm := t.state != taskRunning
		at := t.lastProgress
		t.mu.Unlock()
		if !isTerm {
			continue
		}
		if now.Sub(at) > taskKeepFinished {
			delete(uploadTasks, id)
			continue
		}
		terminal = append(terminal, ent{id, at})
	}

	// 2) 数量维度：仍超量则按最久未推进优先淘汰
	if len(uploadTasks) <= taskKeepMaxCount {
		return
	}
	sort.Slice(terminal, func(i, j int) bool { return terminal[i].at.Before(terminal[j].at) })
	excess := len(uploadTasks) - taskKeepMaxCount
	for i := 0; i < excess && i < len(terminal); i++ {
		delete(uploadTasks, terminal[i].id)
	}
}

func getTask(id string) *uploadTask {
	uploadTasksMu.Lock()
	defer uploadTasksMu.Unlock()
	return uploadTasks[id]
}

// run 执行真正的上传。必须在 goroutine 里调用（它是长任务）。
func (t *uploadTask) run() {
	ctx, cancel := context.WithCancel(context.Background())
	t.mu.Lock()
	t.cancel = cancel
	t.lastProgress = time.Now()
	t.mu.Unlock()
	defer cancel()

	// idle 看门狗：进度长时间不动就取消。见 uploadIdleTimeout 注释。
	watchDone := make(chan struct{})
	defer close(watchDone)
	go t.watchIdle(ctx, watchDone)

	var err error
	if pu, ok := t.driver.(ProgressUploader); ok {
		err = pu.PutFromFileWithProgress(ctx, t.bucket, t.key, t.tmpPath, t.mime, t.storageClass, t.onProgress)
	} else {
		// 驱动不支持进度：退化为原有行为（无进度、不可取消）
		err = t.driver.PutFromFileWithClass(t.bucket, t.key, t.tmpPath, t.mime, t.storageClass)
	}

	t.mu.Lock()
	cancelled := ctx.Err() != nil
	if err == nil {
		t.state = taskDone
		t.sent = t.size
	} else if cancelled {
		t.state = taskCancelled
		t.errMsg = "上传已取消"
	} else {
		t.state = taskFailed
		t.errMsg = err.Error()
	}
	finalState, finalSent, finalTotal, finalErr := t.state, t.sent, t.size, t.errMsg
	t.lastProgress = time.Now()
	t.mu.Unlock()

	// 终态事件必须发（不受节流影响）：前端靠它结束等待。
	notify(uploadProgressEvent, map[string]interface{}{
		"taskId": t.id,
		"state":  finalState,
		"sent":   finalSent,
		"total":  finalTotal,
		"error":  finalErr,
	})

	// 分片文件清理：只有成功才删。
	//
	// 取消与失败都**保留** .part/.meta：取消发生在上云阶段，此时本地分片是
	// **完整**的（第一跳已全部写完），删掉等于让用户重传一遍已经传好的字节。
	// 保留后下次 upload/begin 由 claimResumableUpload 接管，秒级续传。
	// 这也与第一跳取消的既有语义一致——前端那时刻意调 upload/release 而非
	// abort，就是为了保住分片。残留文件由 cleanupStaleUploads 的 24h TTL 兜底。
	if finalState == taskDone {
		removeUploadFilesByPath(t.tmpPath, t.metaPath)
	}
}

// watchIdle 监控进度停滞：超过 uploadIdleTimeout 无推进就取消上传。
func (t *uploadTask) watchIdle(ctx context.Context, done <-chan struct{}) {
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-done:
			return
		case <-ticker.C:
			t.mu.Lock()
			idle := time.Since(t.lastProgress)
			running := t.state == taskRunning
			t.mu.Unlock()
			if running && idle > uploadIdleTimeout {
				log.Printf("上传任务 %s 空闲 %v 无进度，判定卡死并取消", t.id, idle)
				t.mu.Lock()
				t.errMsg = "上传长时间无进度，已中止"
				t.mu.Unlock()
				t.cancel()
				return
			}
		}
	}
}

// cancelTask 取消正在进行的任务。幂等：终态任务直接返回当前状态。
func cancelTask(id string) bool {
	t := getTask(id)
	if t == nil {
		return false
	}
	t.mu.Lock()
	cancel := t.cancel
	running := t.state == taskRunning
	t.mu.Unlock()
	if running && cancel != nil {
		cancel()
	}
	return true
}
