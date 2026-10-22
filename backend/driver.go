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

// 规范 provider 标识：驱动分发只认这两个值。
// 空值视为 aliyun（向后兼容旧连接）；其余具体厂商名（腾讯 COS、华为 OBS、AWS S3 等）
// 在 UI 上呈现，但底层统一归一化为 ProviderS3 走 s3Driver。
const (
	ProviderAliyun = "aliyun"
	ProviderS3     = "s3"
)

// s3ProviderAliases 是所有「走 S3 协议」的具体厂商标识集合（含通用 s3）。
// manifest.json 的 provider 下拉以此为准；新增厂商只需在此登记 + 同步 manifest。
var s3ProviderAliases = map[string]struct{}{
	ProviderS3:      {}, // 通用 S3 兼容兜底
	"aws-s3":        {}, // AWS S3
	"tencent-cos":   {}, // 腾讯云 COS
	"huawei-obs":    {}, // 华为云 OBS
	"minio":         {}, // MinIO（自建）
	"cloudflare-r2": {}, // Cloudflare R2
	"wasabi":        {}, // Wasabi
	"backblaze-b2":  {}, // Backblaze B2
}

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
	Provider        flexString `json:"provider"` // 规范值 aliyun | s3；空 = aliyun。UI 上具体厂商名（腾讯COS/华为OBS等）归一化后落到 s3
	Endpoint        string     `json:"endpoint"`
	AccessKeyID     string     `json:"accessKeyId"`
	AccessKeySecret string     `json:"accessKeySecret"`
	Bucket          string     `json:"bucket"` // 可留空：留空时根目录列出全部存储桶
	Region          flexString `json:"region"` // 仅 s3：可选
	PathStyle       bool       `json:"pathStyle"`

	// ReadOnly 只读标记。为 true 时 handler 层拒绝一切写类操作。
	// 来源有二：宿主 connection-provider 声明的 read_only 字段，
	// 以及插件自带连接表单里的「只读模式」勾选（扁平直发形状）。
	ReadOnly bool `json:"readOnly"`

	// Name 连接显示名（宿主 lifecycle 形状才有；仅用于展示）
	Name string `json:"name"`
}

// normalizeProvider 将具体厂商标识归一化为规范的 s3 / aliyun。
// 所有 s3ProviderAliases 中的值（含通用 s3）都归为 ProviderS3，其余（含空）归为 ProviderAliyun。
func normalizeProvider(p string) string {
	if _, ok := s3ProviderAliases[strings.ToLower(strings.TrimSpace(p))]; ok {
		return ProviderS3
	}
	return ProviderAliyun
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
	// 宿主 connection-provider 声明的 read_only 字段走 lifecycle 形状
	//（connection.read_only），需独立解析——不能挂在「凭据全空」的分支里，
	// 因为宿主可能在同一请求里同时下发凭据与 read_only。
	var host struct {
		Connection struct {
			Name              string                     `json:"name"`
			ExternalConfig    map[string]json.RawMessage `json:"external_config"`
			ConnectionSecrets map[string]json.RawMessage `json:"connection_secrets"`
			ReadOnly          bool                       `json:"read_only"`
		} `json:"connection"`
	}
	hostShapeOK := json.Unmarshal(params, &host) == nil
	if hostShapeOK {
		ec := host.Connection.ExternalConfig
		// 扁平直发时这些字段可能已填好；宿主形状下才从 external_config 取。
		// 逐字段判空而非整块覆盖，避免把插件自带表单传来的值冲掉。
		if c.Endpoint == "" {
			c.Endpoint = coerceString(ec["endpoint"])
		}
		if c.AccessKeyID == "" {
			c.AccessKeyID = coerceString(ec["access_key_id"])
		}
		if c.Bucket == "" {
			c.Bucket = coerceString(ec["bucket"])
		}
		if c.Provider.String() == "" {
			c.Provider = flexString(coerceString(ec["provider"]))
		}
		if c.Region.String() == "" {
			c.Region = flexString(coerceString(ec["region"]))
		}
		if !c.PathStyle {
			c.PathStyle = isTruthy(ec["path_style"])
		}
		if c.AccessKeySecret == "" {
			c.AccessKeySecret = coerceString(host.Connection.ConnectionSecrets["access_key_secret"])
		}
		if c.Name == "" {
			c.Name = host.Connection.Name
		}
		if host.Connection.ReadOnly {
			c.ReadOnly = true
		}
	}
	// 扁平直发也兼容蛇形 path_style / read_only
	//（宿主 connection-provider 字段名为 path_style、read_only）
	var flat map[string]json.RawMessage
	if json.Unmarshal(params, &flat) == nil {
		if !c.PathStyle {
			c.PathStyle = isTruthy(flat["path_style"])
		}
		if !c.ReadOnly {
			c.ReadOnly = isTruthy(flat["read_only"])
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
	// Recursive 为 true 时驱动不传 delimiter，返回 prefix 下的全部对象
	// （不做目录折叠）。用于「统计目录内容」这类需要平铺全部 key 的场景。
	Recursive bool
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
	// DeletePrefix 递归删除 prefix 下的全部对象（含 prefix 自身的目录标记对象），
	// 返回实际删除的对象数。
	// 对象存储没有真正的目录，目录只是 delimiter 折叠出的逻辑前缀——若仅对 prefix
	// 发一次 DELETE，命中的是不存在的 key，服务端按幂等语义返回成功，目录却纹丝不动
	// （假成功）。因此删除目录必须由驱动真正列举 prefix 下的所有 key 并逐批删除。
	// limit 为单次调用允许删除的对象数上限，超出即返回错误中止，防止误删超大目录。
	DeletePrefix(bucket, prefix string, limit int) (int, error)
	// Move 重命名/移动。对象存储均无原生 rename，驱动内部用 copy + delete 实现。
	Move(bucket, from, to string) error
	// MovePrefix 递归重命名/移动一个「目录」（对象存储里的逻辑前缀）。
	//
	// 为什么必须有它：Move 是单 key 的 copy+delete，对象存储没有实体目录，
	// 目录只是 delimiter 折叠出的前缀。对前缀直接 Move 会命中不存在的
	// 「目录标记对象」——要么 CopyObject 报 NoSuchKey，要么侥幸搬动了一个
	// 空壳而 prefix 下的子对象原地不动，表现为「改名后目录内容凭空消失」。
	//
	// 语义：把 fromPrefix 下的全部对象（含子层级）逐个复制到 toPrefix 之下，
	// 复制全部成功后再删除源对象。返回被移动的对象数。
	// limit 为单次调用允许移动的对象数上限，超出即返回错误中止。
	MovePrefix(bucket, fromPrefix, toPrefix string, limit int) (int, error)
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
