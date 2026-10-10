package main

// driver.go — 存储驱动抽象层。
// 所有云存储差异（阿里云 OSS 原生 API / S3 兼容 API）都被收敛到 StorageDriver 接口之后，
// oss.go 的 RPC handler 只面向接口编程，不再出现任何厂商 SDK 类型。

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"
)

// 支持的 provider 标识。空值视为 aliyun（向后兼容旧连接）。
const (
	ProviderAliyun = "aliyun"
	ProviderS3     = "s3"
)

// flexString 兼容宿主/前端把字段值传成非字符串标量的情况：
// 字符串直取；对象取 {value}（fallback key/id/label）；数字、布尔转字面文本。
// 实测宿主表单对 select 字段可能传 {label, value} 对象而非裸字符串。
type flexString string

func (f *flexString) UnmarshalJSON(b []byte) error {
	s := strings.TrimSpace(string(b))
	if s == "" || s == "null" {
		*f = ""
		return nil
	}
	switch s[0] {
	case '"':
		var v string
		if err := json.Unmarshal(b, &v); err != nil {
			return err
		}
		*f = flexString(v)
	case '{':
		var o struct {
			Value string `json:"value"`
			Key   string `json:"key"`
			ID    string `json:"id"`
			Label string `json:"label"`
		}
		if err := json.Unmarshal(b, &o); err != nil {
			return err
		}
		v := o.Value
		if v == "" {
			v = o.Key
		}
		if v == "" {
			v = o.ID
		}
		if v == "" {
			v = o.Label
		}
		*f = flexString(v)
	default:
		*f = flexString(s)
	}
	return nil
}

func (f flexString) String() string { return string(f) }

// ConnConfig 对应连接凭据。兼容两种入参形状：
//  1. 插件自带 UI 直发（扁平驼峰）：{provider, endpoint, accessKeyId, accessKeySecret, bucket, region, pathStyle}
//  2. 宿主连接管理表单（lifecyclePayload，蛇形嵌套）：
//     {connection:{name, external_config:{provider,endpoint,access_key_id,bucket,region,path_style}, connection_secrets:{access_key_secret}}}
type ConnConfig struct {
	Provider        flexString `json:"provider"` // aliyun | s3；空 = aliyun
	Endpoint        string     `json:"endpoint"`
	AccessKeyID     string     `json:"accessKeyId"`
	AccessKeySecret string     `json:"accessKeySecret"`
	Bucket          string     `json:"bucket"` // 可留空：留空时根目录列出全部存储桶
	Region          flexString `json:"region"` // 仅 s3：可选
	PathStyle       bool       `json:"pathStyle"`

	// Name 连接显示名（宿主 lifecycle 形状才有；仅用于展示）
	Name string `json:"name"`
}

// normalizeProvider 补齐 provider 默认值并做白名单校验。
func normalizeProvider(p string) string {
	switch strings.ToLower(strings.TrimSpace(p)) {
	case ProviderS3:
		return ProviderS3
	default:
		return ProviderAliyun
	}
}

// coerceString 从 json.RawMessage 提取字符串（复用 flexString 的宽容规则）。
func coerceString(raw json.RawMessage) string {
	var f flexString
	if err := json.Unmarshal(raw, &f); err != nil {
		return ""
	}
	return f.String()
}

// parseConn 解析并校验连接参数（provider 差异项在此统一归一化）。
func parseConn(params json.RawMessage) (ConnConfig, *RPCError) {
	var c ConnConfig
	if err := json.Unmarshal(params, &c); err != nil {
		return c, &RPCError{Code: -32602, Message: "invalid params: " + err.Error()}
	}
	if c.Endpoint == "" && c.AccessKeyID == "" && c.AccessKeySecret == "" {
		var host struct {
			Connection struct {
				Name              string                     `json:"name"`
				ExternalConfig    map[string]json.RawMessage `json:"external_config"`
				ConnectionSecrets map[string]json.RawMessage `json:"connection_secrets"`
				ReadOnly          bool                       `json:"read_only"`
			} `json:"connection"`
		}
		if err := json.Unmarshal(params, &host); err == nil {
			ec := host.Connection.ExternalConfig
			c.Endpoint = coerceString(ec["endpoint"])
			c.AccessKeyID = coerceString(ec["access_key_id"])
			c.Bucket = coerceString(ec["bucket"])
			c.Provider = flexString(coerceString(ec["provider"]))
			c.Region = flexString(coerceString(ec["region"]))
			c.PathStyle = isTruthy(ec["path_style"])
			c.AccessKeySecret = coerceString(host.Connection.ConnectionSecrets["access_key_secret"])
			c.Name = host.Connection.Name
		}
	}
	// 扁平直发也兼容蛇形 path_style（宿主 connection-provider 字段为 path_style）
	if !c.PathStyle {
		var flat map[string]json.RawMessage
		if json.Unmarshal(params, &flat) == nil {
			c.PathStyle = isTruthy(flat["path_style"])
		}
	}
	if c.Endpoint == "" || c.AccessKeyID == "" || c.AccessKeySecret == "" {
		return c, &RPCError{Code: -32602, Message: "缺少必填项：端点 / Access Key ID / Secret"}
	}
	c.Provider = flexString(normalizeProvider(c.Provider.String()))
	return c, nil
}

func isTruthy(v interface{}) bool {
	switch t := v.(type) {
	case string:
		return strings.EqualFold(strings.TrimSpace(t), "true") || t == "1"
	case bool:
		return t
	case json.RawMessage:
		var f flexString
		if json.Unmarshal(t, &f) == nil {
			return isTruthy(f.String())
		}
		var b bool
		if json.Unmarshal(t, &b) == nil {
			return b
		}
		return false
	default:
		return false
	}
}

// ---------- 驱动层公共数据形状 ----------

type BucketInfo struct {
	Name string
}

// ListReq 列举请求。Token 为不透明分页游标：阿里云驱动下是 OSS marker，
// S3 驱动下是内部计数游标，UI 层只需原样透传。
type ListReq struct {
	Bucket    string
	Prefix    string
	Delimiter string
	Token     string
	MaxKeys   int
}

type ListItem struct {
	Name     string `json:"name"`
	IsDir    bool   `json:"is_dir"`
	Size     int64  `json:"size"`
	Mime     string `json:"mime"`
	Modified string `json:"modified"`
}

type ListPage struct {
	Items     []ListItem
	Truncated bool
	NextToken string
}

type ObjMeta struct {
	Size     int64
	MIME     string
	Modified string // RFC3339
	ETag     string
}

// StorageDriver 统一存储操作接口。
// bucket 参数均可为空：为空时驱动回落到连接配置中的默认 bucket。
type StorageDriver interface {
	ListBuckets() ([]BucketInfo, error)
	ListObjects(req ListReq) (ListPage, error)
	Stat(bucket, path string) (ObjMeta, error)
	// OpenRange 按区间读取对象（objects/read 预览用），返回对象元数据 + 限制区间的读流。
	OpenRange(bucket, path string, offset, limit int64) (ObjMeta, io.ReadCloser, error)
	// OpenStream 打开全量对象流（objects/save 下载用），流式不占内存。
	OpenStream(bucket, path string) (io.ReadCloser, error)
	Put(bucket, path string, r io.Reader, size int64, mime string) error
	// PutFromFile 从本地文件流式上传（大文件分片上传链路：sidecar 先把前端分片
	// 落到临时文件，complete 时由驱动整体上转）。驱动内部应使用分片/并发上传，
	// 避免整文件读入内存。
	PutFromFile(bucket, path, filePath, mime string) error
	// Presign 生成预签名 GET URL（对象分享）。expires 秒数由 handler 层钳制。
	Presign(bucket, path string, expires int64) (string, error)
	Delete(bucket, path string) error
	// Move 重命名/移动。对象存储均无原生 rename，驱动内部用 copy + delete 实现。
	Move(bucket, from, to string) error
}

// baseDriver 沉淀各驱动的公共逻辑：默认 bucket 回落。
type baseDriver struct {
	cfg ConnConfig
}

func (b baseDriver) pickBucket(name string) (string, error) {
	if name == "" {
		name = b.cfg.Bucket
	}
	if name == "" {
		return "", fmt.Errorf("未指定存储桶")
	}
	return name, nil
}

// newDriver 按 provider 构造驱动实例。
func newDriver(cfg ConnConfig) (StorageDriver, error) {
	switch cfg.Provider {
	case ProviderS3:
		return newS3Driver(cfg)
	default:
		return newAliyunDriver(cfg)
	}
}

// guessMime 按扩展名推断 MIME（驱动层公共工具）。
func guessMime(key string) string {
	lower := strings.ToLower(key)
	switch {
	case strings.HasSuffix(lower, ".txt"):
		return "text/plain"
	case strings.HasSuffix(lower, ".json"):
		return "application/json"
	case strings.HasSuffix(lower, ".csv"):
		return "text/csv"
	case strings.HasSuffix(lower, ".md"):
		return "text/markdown"
	case strings.HasSuffix(lower, ".jpg"), strings.HasSuffix(lower, ".jpeg"):
		return "image/jpeg"
	case strings.HasSuffix(lower, ".png"):
		return "image/png"
	case strings.HasSuffix(lower, ".gif"):
		return "image/gif"
	case strings.HasSuffix(lower, ".pdf"):
		return "application/pdf"
	case strings.HasSuffix(lower, ".xml"):
		return "application/xml"
	case strings.HasSuffix(lower, ".html"), strings.HasSuffix(lower, ".htm"):
		return "text/html"
	default:
		return "application/octet-stream"
	}
}
