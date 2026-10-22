package main

import (
	"bufio"
	"encoding/json"
	"io"
	"log"
	"os"
	"strings"
	"sync"
)

// Request / Response 实现 JSON-RPC 2.0 over newline-delimited JSON (stdio-jsonl)
type Request struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type RPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type Response struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Result  interface{}     `json:"result,omitempty"`
	Error   *RPCError       `json:"error,omitempty"`
}

// PluginState 当前连接状态。driver 由 newDriver 按 provider 构造，
// handler 层不感知具体厂商实现。
type PluginState struct {
	cfg    ConnConfig
	driver StorageDriver
}

var (
	state   = &PluginState{}
	stateMu sync.Mutex
)

func main() {
	// 日志一律走 stderr，stdout 仅输出协议消息
	log.SetOutput(os.Stderr)

	// 启动即回收上次崩溃遗留的上传临时文件（正常路径已在 complete/abort 清理）
	cleanupStaleUploads()

	reader := bufio.NewReader(os.Stdin)
	writer := bufio.NewWriter(os.Stdout)

	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			if err != io.EOF {
				log.Printf("read error: %v", err)
			}
			return
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			continue
		}

		var req Request
		if err := json.Unmarshal([]byte(line), &req); err != nil {
			log.Printf("parse error: %v", err)
			continue
		}

		// 通知类消息（无 id）不回复
		if len(req.ID) == 0 {
			handleNotification(req)
			continue
		}

		result, rpcErr := dispatch(req)
		resp := Response{JSONRPC: "2.0", ID: req.ID}
		if rpcErr != nil {
			resp.Error = rpcErr
		} else {
			resp.Result = result
		}
		b, err := json.Marshal(resp)
		if err != nil {
			log.Printf("marshal error: %v", err)
			continue
		}
		writer.Write(b)
		writer.WriteByte('\n')
		writer.Flush()
	}
}

func dispatch(req Request) (interface{}, *RPCError) {
	switch req.Method {
	case "plugin/initialize":
		return handleInitialize(req.Params)
	case "connection/test":
		return handleConnectionTest(req.Params)
	case "connection/connect":
		return handleConnectionConnect(req.Params)
	case "connection/disconnect":
		return handleConnectionDisconnect(req.Params)
	case "connection/status":
		return handleConnectionStatus(req.Params)
	case "buckets/list":
		return handleBucketsList(req.Params)
	case "objects/list":
		return handleObjectsList(req.Params)
	case "objects/read":
		return handleObjectsRead(req.Params)
	case "objects/write":
		return handleObjectsWrite(req.Params)
	case "objects/delete":
		return handleObjectsDelete(req.Params)
	case "objects/dir_info":
		return handleObjectsDirInfo(req.Params)
	case "objects/delete_dir":
		return handleObjectsDeleteDir(req.Params)
	case "objects/delete_batch":
		return handleObjectsDeleteBatch(req.Params)
	case "objects/save":
		return handleObjectSave(req.Params)
	case "objects/move":
		return handleObjectsMove(req.Params)
	case "objects/move_dir":
		return handleObjectsMoveDir(req.Params)
	case "objects/stat":
		return handleObjectsStat(req.Params)
	case "objects/presign":
		return handleObjectsPresign(req.Params)
	case "upload/begin":
		return handleUploadBegin(req.Params)
	case "upload/chunk":
		return handleUploadChunk(req.Params)
	case "upload/complete":
		return handleUploadComplete(req.Params)
	case "upload/abort":
		return handleUploadAbort(req.Params)
	default:
		return nil, &RPCError{Code: -32601, Message: "method not found: " + req.Method}
	}
}
