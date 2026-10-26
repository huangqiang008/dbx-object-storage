package main

// rpc_upload.go — 大文件分片上传 RPC handler 与会话管理。

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// ---------- upload/* 大文件分片上传 ----------
// 前端把文件按 256KB 分片 base64 直发 sidecar，顺序追加到宿主机临时文件；
// complete 时由驱动从临时文件流式上转（阿里云分片并发 / MinIO 自动 multipart）。
// 好处：单条 RPC 负载小不超时、内存恒定、可中途取消；对驱动零差异。

type uploadSession struct {
	id       string
	file     *os.File
	tmpPath  string
	metaPath string
	bucket   string
	key      string
	mime     string
	size     int64
	written  int64
	// resumable 为 true 表示接管自历史分片文件，元数据沿用既有 .meta，不重写
	resumable bool
	// storageClass 归一化后的存储类别（2.5），空串 = 服务端默认。
	// 随会话一路传到 complete，由驱动在上转时指定。
	storageClass string
}

// uploadMeta 落盘的可续传元数据。key 本身可能含 "/"，无法从文件名反推，
// 故单独存一份同名 .meta。
type uploadMeta struct {
	Bucket string `json:"bucket"`
	Key    string `json:"key"`
	Size   int64  `json:"size"`
	Mime   string `json:"mime"`
	// StorageClass 归一化存储类别（2.5）。跨进程续传时沿用，
	// 避免续传后存储类别与首次上传不一致。
	StorageClass string `json:"storageClass,omitempty"`
}

var (
	uploadsMu sync.Mutex
	uploads   = map[string]*uploadSession{}
)

// uploadTempPrefix 上传分片临时文件名前缀。
const uploadTempPrefix = "dbx-up-"

// uploadTempPattern 上传分片临时文件扫描规则。与 cleanupStaleUploads 对应。
const uploadTempPattern = uploadTempPrefix + "*.part"

// uploadMetaPattern 可续传元数据的扫描规则（.part 与 .meta 一并清理）。
const uploadMetaPattern = uploadTempPrefix + "*.meta"

// uploadTempTTL 临时文件最长保留时长。sidecar 崩溃 / 宿主强杀进程时 abort 不会执行，
// .part 文件会永久残留（历史上没有任何回收机制，长期使用持续占磁盘）。
// 取 24h：足够覆盖任何跨夜的大文件上传，又不会让垃圾无限堆积。
const uploadTempTTL = 24 * time.Hour

// maxConcurrentUploads 单 sidecar 同时进行的上传会话数上限。
// 异常调用（如前端反复 begin 不 complete）会无限制堆积会话与临时文件。
const maxConcurrentUploads = 8

// cleanupStaleUploads 启动时清理超龄的上传临时文件。
// 正常退出路径下 abort/complete 已删除文件，能被清到的都是崩溃遗留。
// 扫描 .part 与 .meta 两类文件（修改时间超过 TTL 即删），不碰其他临时文件。
// .meta 必须一起清理，否则会留下没有分片的孤儿元数据。
func cleanupStaleUploads() {
	cutoff := time.Now().Add(-uploadTempTTL)
	removed := 0
	for _, pattern := range []string{uploadTempPattern, uploadMetaPattern} {
		entries, err := filepath.Glob(filepath.Join(os.TempDir(), pattern))
		if err != nil {
			log.Printf("扫描残留上传临时文件失败(%s): %v", pattern, err)
			continue
		}
		for _, p := range entries {
			info, e := os.Stat(p)
			if e != nil {
				continue // 已被其它进程清理
			}
			if info.ModTime().After(cutoff) {
				continue // 仍在保留期内，可能是有活跃会话或可续传
			}
			if os.Remove(p) == nil {
				removed++
			}
		}
	}
	if removed > 0 {
		log.Printf("已清理 %d 个残留上传临时文件（超过 %v）", removed, uploadTempTTL)
	}
}

// registerUpload 登记上传会话；超出并发上限或会话数失控时返回错误。
func registerUpload(sess *uploadSession, id string) *RPCError {
	uploadsMu.Lock()
	defer uploadsMu.Unlock()
	if len(uploads) >= maxConcurrentUploads {
		return &RPCError{Code: -32000, Message: fmt.Sprintf("同时进行的上传过多（上限 %d），请稍后重试", maxConcurrentUploads)}
	}
	uploads[id] = sess
	return nil
}

func newUploadID() (string, *RPCError) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", &RPCError{Code: -32000, Message: "生成上传 ID 失败: " + err.Error()}
	}
	return hex.EncodeToString(b), nil
}

// currentBucket 解析目标桶：入参优先，否则回落连接默认桶。
func currentBucket(name string) (string, *RPCError) {
	if strings.TrimSpace(name) == "" {
		stateMu.Lock()
		name = state.cfg.Bucket
		stateMu.Unlock()
	}
	if strings.TrimSpace(name) == "" {
		return "", &RPCError{Code: -32000, Message: "未指定存储桶"}
	}
	return name, nil
}

type UploadBeginParams struct {
	Bucket string `json:"bucket"`
	Path   string `json:"path"`
	Mime   string `json:"mime"`
	Size   int64  `json:"size"` // 仅展示用，后端不依赖
	// StorageClass 归一化存储类别（2.5）：standard/ia/archive，空 = 服务端默认。
	StorageClass string `json:"storageClass"`
}

func handleUploadBegin(params json.RawMessage) (interface{}, *RPCError) {
	var p UploadBeginParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, &RPCError{Code: -32602, Message: "invalid params"}
	}
	if rerr := requireWritable(); rerr != nil {
		return nil, rerr
	}
	bucket, rerr := currentBucket(p.Bucket)
	if rerr != nil {
		return nil, rerr
	}
	if strings.TrimSpace(p.Path) == "" {
		return nil, &RPCError{Code: -32602, Message: "缺少目标对象路径"}
	}
	if _, rerr := getDriver(); rerr != nil {
		return nil, rerr
	}
	// 存储类别归一化（2.5）：非法值直接报错，不静默忽略——
	// 静默忽略会让用户以为存到了归档层，实际仍是标准层。
	storageClass := ""
	if sc := strings.TrimSpace(p.StorageClass); sc != "" {
		storageClass = normalizeStorageClass(sc)
		if storageClass == "" {
			return nil, &RPCError{Code: -32602, Message: "不支持的存储类别: " + sc}
		}
	}
	// 断点续传：先找这个对象是否已有历史分片（sidecar 上次崩溃/被杀会留下）。
	// 命中则接管该文件继续追加，避免整个文件重传。
	if sess := claimResumableUpload(bucket, p.Path, p.Size); sess != nil {
		// 续传时以本次请求的存储类别为准：历史分片可能来自另一次上传。
		sess.storageClass = storageClass
		return map[string]interface{}{
			"uploadId": sess.id,
			"offset":   sess.written,
			"resumed":  true,
		}, nil
	}

	tmp, err := os.CreateTemp("", uploadTempPattern)
	if err != nil {
		return nil, &RPCError{Code: -32000, Message: "创建临时文件失败: " + err.Error()}
	}
	id, rerr := newUploadID()
	if rerr != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return nil, rerr
	}
	sess := &uploadSession{
		id: id, file: tmp, tmpPath: tmp.Name(),
		bucket: bucket, key: p.Path, mime: p.Mime, size: p.Size,
		storageClass: storageClass,
	}
	if e := registerUpload(sess, id); e != nil {
		// 超限时必须回收已创建的临时文件，否则这次失败的 begin 又留下一份垃圾
		tmp.Close()
		os.Remove(tmp.Name())
		return nil, e
	}
	// 元数据落盘，供下次 sidecar 启动后按 (bucket,key,size) 找回此分片
	persistUploadMeta(sess)
	return map[string]interface{}{"uploadId": id, "offset": int64(0), "resumed": false}, nil
}

// claimResumableUpload 尝试接管上次未完成的分片文件，实现跨进程断点续传。
//
// 前提是分片文件名可由 (bucket, key, size) 稳定推导：否则 sidecar 一重启，
// 内存里的 uploads map 与随机文件名都无从对应，续传无从谈起。
// 故用 sha256(bucket+"\x00"+key+"\x00"+size) 前 12 字节作为文件名，
// 元数据另存同名 .meta（key 含 "/"，无法从文件名反推）。
//
// 安全性：.meta 与 .part 必须同时存在且三者（bucket/key/size）完全一致才接管，
// 分片为空或超过声明大小一律丢弃重来——避免把 A 文件的内容接到 B 文件上。
func claimResumableUpload(bucket, key string, size int64) *uploadSession {
	if size <= 0 {
		return nil // 不知道总大小，无法安全续传
	}
	stem := uploadStem(bucket, key, size)
	partPath := filepath.Join(os.TempDir(), stem+".part")
	metaPath := filepath.Join(os.TempDir(), stem+".meta")

	raw, err := os.ReadFile(metaPath)
	if err != nil {
		return nil // 无元数据，视为无历史分片
	}
	var meta uploadMeta
	if json.Unmarshal(raw, &meta) != nil {
		return nil
	}
	if meta.Bucket != bucket || meta.Key != key || meta.Size != size {
		return nil // 元数据与本次请求不符（同名碰撞或陈旧状态）
	}
	info, err := os.Stat(partPath)
	if err != nil {
		return nil
	}
	if info.Size() == 0 || info.Size() > size {
		// 空分片无续传价值；超长说明状态错乱，两种都清掉重来
		os.Remove(partPath)
		os.Remove(metaPath)
		return nil
	}

	f, err := os.OpenFile(partPath, os.O_RDWR|os.O_APPEND, 0o600)
	if err != nil {
		return nil
	}
	id, rerr := newUploadID()
	if rerr != nil {
		f.Close()
		return nil
	}
	sess := &uploadSession{
		id: id, file: f, tmpPath: partPath, metaPath: metaPath,
		bucket: bucket, key: key, mime: meta.Mime, size: size,
		written: info.Size(), resumable: true,
		storageClass: meta.StorageClass,
	}
	if e := registerUpload(sess, id); e != nil {
		f.Close()
		return nil // 并发已满，退回全新上传
	}
	log.Printf("断点续传：%s/%s 从 %d/%d 字节继续", bucket, key, sess.written, size)
	return sess
}

// uploadStem 由 bucket+key+size 派生稳定的临时文件名（不含扩展名）。
//
// 用「长度前缀」而非分隔符拼接：分隔符方案在 key 自身含分隔符时会歧义
// （("a","b\x00c") 与 ("a\x00b","c") 会得到同样的字节流，进而撞上同一个 stem），
// 而对象 key 是用户可控的，这种歧义可能导致误接管别的文件的上传分片。
func uploadStem(bucket, key string, size int64) string {
	h := sha256.New()
	var lenBuf [8]byte
	put := func(s string) {
		binary.BigEndian.PutUint64(lenBuf[:], uint64(len(s)))
		h.Write(lenBuf[:])
		h.Write([]byte(s))
	}
	put(bucket)
	put(key)
	binary.BigEndian.PutUint64(lenBuf[:], uint64(size))
	h.Write(lenBuf[:])
	return uploadTempPrefix + hex.EncodeToString(h.Sum(nil)[:12])
}

// persistUploadMeta 为「新建」会话写入可续传元数据。
// 续传会话沿用既有 .meta，不重写（内容本就一致）。
func persistUploadMeta(sess *uploadSession) {
	if sess.resumable || sess.tmpPath == "" {
		return
	}
	sess.metaPath = strings.TrimSuffix(sess.tmpPath, ".part") + ".meta"
	raw, err := json.Marshal(uploadMeta{
		Bucket: sess.bucket, Key: sess.key, Size: sess.size, Mime: sess.mime,
		StorageClass: sess.storageClass,
	})
	if err != nil {
		return
	}
	// 先写 .tmp 再 rename：避免进程在写一半时被杀，留下半截 JSON 误导后续续传
	tmp := sess.metaPath + ".tmp"
	if os.WriteFile(tmp, raw, 0o600) == nil {
		os.Rename(tmp, sess.metaPath)
	}
}

// removeUploadFiles 清理会话的临时文件与元数据（正常完成/取消时调用）
func removeUploadFiles(sess *uploadSession) {
	sess.file.Close()
	os.Remove(sess.tmpPath)
	os.Remove(sess.metaPath)
	os.Remove(strings.TrimSuffix(sess.tmpPath, ".part") + ".meta")
}

type UploadChunkParams struct {
	UploadID string `json:"uploadId"`
	Offset   int64  `json:"offset"`
	Content  string `json:"content"` // base64
}

func handleUploadChunk(params json.RawMessage) (interface{}, *RPCError) {
	var p UploadChunkParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, &RPCError{Code: -32602, Message: "invalid params"}
	}
	data, err := base64.StdEncoding.DecodeString(p.Content)
	if err != nil {
		return nil, &RPCError{Code: -32602, Message: "invalid base64 content"}
	}
	uploadsMu.Lock()
	defer uploadsMu.Unlock()
	sess, ok := uploads[p.UploadID]
	if !ok {
		return nil, &RPCError{Code: -32000, Message: "上传会话不存在或已结束"}
	}
	if p.Offset != sess.written {
		return nil, &RPCError{Code: -32000, Message: fmt.Sprintf("分片偏移不连续: 期望 %d, 收到 %d", sess.written, p.Offset)}
	}
	n, err := sess.file.Write(data)
	if err != nil {
		return nil, &RPCError{Code: -32000, Message: "写入临时文件失败: " + err.Error()}
	}
	sess.written += int64(n)
	return map[string]interface{}{"written": sess.written}, nil
}

func handleUploadComplete(params json.RawMessage) (interface{}, *RPCError) {
	var p struct {
		UploadID string `json:"uploadId"`
	}
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, &RPCError{Code: -32602, Message: "invalid params"}
	}
	uploadsMu.Lock()
	sess, ok := uploads[p.UploadID]
	delete(uploads, p.UploadID)
	uploadsMu.Unlock()
	if !ok {
		return nil, &RPCError{Code: -32000, Message: "上传会话不存在或已结束"}
	}
	// 必须在 PutFromFile 之后再删分片：驱动要从该文件读取内容。
	// 同时清掉 .meta，否则会留下没有分片的孤儿元数据。
	defer removeUploadFiles(sess)
	d, rerr := getDriver()
	if rerr != nil {
		return nil, rerr
	}
	if err := d.PutFromFileWithClass(sess.bucket, sess.key, sess.tmpPath, sess.mime, sess.storageClass); err != nil {
		return nil, &RPCError{Code: -32000, Message: "上传失败: " + err.Error()}
	}
	return map[string]interface{}{"ok": true, "size": sess.written}, nil
}

func handleUploadAbort(params json.RawMessage) (interface{}, *RPCError) {
	var p struct {
		UploadID string `json:"uploadId"`
	}
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, &RPCError{Code: -32602, Message: "invalid params"}
	}
	uploadsMu.Lock()
	sess, ok := uploads[p.UploadID]
	delete(uploads, p.UploadID)
	uploadsMu.Unlock()
	if ok {
		// 用户主动取消：连同元数据一起清掉，不给后续续传留垃圾
		removeUploadFiles(sess)
	}
	// 幂等：会话不存在也返回 ok
	return map[string]interface{}{"ok": true}, nil
}

// handleUploadRelease 释放上传会话但**保留**磁盘上的分片（用户取消场景）。
//
// 与 upload/abort 的区别：
//   - abort：连同 .part 与 .meta 一起删（上传失败，分片不完整，无保留价值）
//   - release：只关文件句柄、从内存 map 摘除会话，.part 与 .meta 留在磁盘上，
//     下次 upload/begin 会通过 claimResumableUpload 接管并从断点继续
//
// 为什么需要 release：用户取消时前端不调 abort（否则分片被删，续传失效），
// 但若不释放会话，内存 map 里的会话会一直累积——上限 8 个会话耗尽后
// 所有后续上传都被拒（「同时进行的上传过多」）。
func handleUploadRelease(params json.RawMessage) (interface{}, *RPCError) {
	var p struct {
		UploadID string `json:"uploadId"`
	}
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, &RPCError{Code: -32602, Message: "invalid params"}
	}
	uploadsMu.Lock()
	sess, ok := uploads[p.UploadID]
	delete(uploads, p.UploadID)
	uploadsMu.Unlock()
	if ok && sess.file != nil {
		// 只关句柄，不删磁盘文件
		sess.file.Close()
	}
	// 幂等：会话不存在也返回 ok
	return map[string]interface{}{"ok": true}, nil
}
