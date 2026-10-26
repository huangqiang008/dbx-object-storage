package main

// driver.go — 存储驱动抽象层。
// 所有云存储差异（阿里云 OSS 原生 API / S3 兼容 API）都被收敛到 StorageDriver 接口之后，
// oss.go 的 RPC handler 只面向接口编程，不再出现任何厂商 SDK 类型。

import (
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
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

	// SessionToken STS 临时凭证的令牌（2.4）。
	//
	// 生产环境普遍使用 STS 而非长期 AK/SK：临时密钥有过期时间，
	// 泄露的影响面也被限制在有效期内。两侧 SDK 都原生支持：
	//   - 阿里云 OSS：oss.SecurityToken(token) 作为 ClientOption
	//   - S3 兼容：credentials.NewStaticV4(id, secret, token)
	// 留空 = 长期密钥，行为与之前完全一致。
	SessionToken string `json:"sessionToken"`

	// Name 连接显示名（宿主 lifecycle 形状才有；仅用于展示）
	Name string `json:"name"`

	// SkipVerifyTLS 跳过 TLS 服务端证书校验（不验证证书链 / 主机名）。
	// 仅用于自签 / 内网点端的逃生通道，会关闭 MITM 防护，UI 必须醒目警告。
	// 留空 = false，保持系统默认 CA 校验。
	SkipVerifyTLS bool `json:"skipVerifyTls"`

	// CACert 自定义 CA 证书（PEM 文本），追加到系统根证书池用于校验服务端证书。
	// 优先级高于 SkipVerifyTLS：两者都设时以 CACert 为准（仍做校验，只是额外信任该 CA）。
	CACert string `json:"caCert"`
}

// normalizeProvider 将具体厂商标识归一化为规范的 s3 / aliyun。
// 所有 s3ProviderAliases 中的值（含通用 s3）都归为 ProviderS3，其余（含空）归为 ProviderAliyun。
func normalizeProvider(p string) string {
	if _, ok := s3ProviderAliases[strings.ToLower(strings.TrimSpace(p))]; ok {
		return ProviderS3
	}
	return ProviderAliyun
}

// isProviderEnvelope 判断顶层 provider 是否为宿主路由信封（JSON 对象而非裸字符串）。
// 宿主连接可能在顶层下发 {id, databaseType} 信封对象用于路由，这与驱动 provider 字段同名，
// 必须识别并丢弃，避免被 flexString 解析成 envelope id 而污染驱动选择。
func isProviderEnvelope(raw json.RawMessage) bool {
	s := strings.TrimSpace(string(raw))
	return len(s) > 0 && s[0] == '{'
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
		// 顶层 provider 可能是宿主路由信封对象（{id, databaseType}），仅用于宿主路由，
		// 不可作为驱动 provider；这里单独捕获原始值以便识别信封。
		Provider   json.RawMessage `json:"provider"`
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
		// provider：宿主 lifecycle 形状下 external_config.provider 才是真实驱动标识。
		// 顶层 provider 信封对象（{id, databaseType}）只用于宿主路由，不可作为 ConnConfig.Provider：
		// flexString 会把对象解析成 envelope id，导致 external_config.provider 被忽略、
		// normalizeProvider 不识别而回退 aliyun（aliyun 驱动不用 path_style，引发 issue #3）。
		if prov := coerceString(ec["provider"]); prov != "" {
			c.Provider = flexString(prov)
		} else if isProviderEnvelope(host.Provider) {
			c.Provider = "" // 信封不是驱动 provider，清空以走兜底（空 → aliyun）
		}
		// 其余情况（扁平直发的裸字符串 provider 已在首轮 Unmarshal 填好）原样保留。
		if c.Region.String() == "" {
			c.Region = flexString(coerceString(ec["region"]))
		}
		if !c.PathStyle {
			c.PathStyle = isTruthy(ec["path_style"])
		}
		if !c.SkipVerifyTLS {
			c.SkipVerifyTLS = isTruthy(ec["skip_verify_tls"])
		}
		if c.CACert == "" {
			c.CACert = coerceString(ec["ca_cert"])
		}
		if c.AccessKeySecret == "" {
			c.AccessKeySecret = coerceString(host.Connection.ConnectionSecrets["access_key_secret"])
		}
		if c.SessionToken == "" {
			c.SessionToken = coerceString(host.Connection.ConnectionSecrets["session_token"])
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
		if !c.SkipVerifyTLS {
			c.SkipVerifyTLS = isTruthy(flat["skip_verify_tls"])
		}
		if c.SessionToken == "" {
			c.SessionToken = coerceString(flat["session_token"])
		}
		if c.CACert == "" {
			c.CACert = coerceString(flat["ca_cert"])
		}
	}
	if c.Endpoint == "" || c.AccessKeyID == "" || c.AccessKeySecret == "" {
		return c, &RPCError{Code: -32602, Message: "缺少必填项：端点 / Access Key ID / Secret"}
	}
	c.Provider = flexString(normalizeProvider(c.Provider.String()))
	return c, nil
}

// buildTransport 按连接的 TLS 设置构造 HTTP 传输层：
//   - CACert 非空：把自定义 CA（PEM）追加到系统根证书池，仍做完整校验（优先，安全）。
//   - 否则 SkipVerifyTLS 为真：关闭证书校验（逃生通道，关闭 MITM 防护）。
//   - 都未设：返回 nil，沿用 SDK 默认传输（系统 CA 校验）。
//
// 返回 nil 时调用方应直接不设置 Transport 字段，避免覆盖 SDK 的代理 / 超时等默认行为。
func buildTransport(cfg ConnConfig) *http.Transport {
	if cfg.CACert == "" && !cfg.SkipVerifyTLS {
		return nil
	}
	pool, err := x509.SystemCertPool()
	if err != nil || pool == nil {
		// 某些环境（如精简容器）取不到系统池，退化为空池再追加自定义 CA。
		pool = x509.NewCertPool()
	}
	if cfg.CACert != "" {
		if !pool.AppendCertsFromPEM([]byte(cfg.CACert)) {
			// 不是致命错误：可能是 PEM 格式问题，交给后续连接时报错暴露。
			log.Printf("buildTransport: ca_cert 解析为空，未追加任何证书")
		}
	}
	tlsCfg := &tls.Config{
		RootCAs:            pool,
		InsecureSkipVerify: cfg.SkipVerifyTLS && cfg.CACert == "",
	}
	return &http.Transport{TLSClientConfig: tlsCfg}
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

// ObjMeta 对象元数据。
//
// 只承载「通用子集」——阿里云 OSS 与 S3 兼容协议都有的语义。
// 厂商特有字段（OSS 的 x-oss-* 扩展头、归档层 Restored 标记等）不进这里，
// 否则另一侧驱动无法等价实现，接口就会退化成单端能力。
type ObjMeta struct {
	Size     int64
	MIME     string
	Modified string // RFC3339
	ETag     string

	// ---- 2.1 元数据编辑相关 ----
	// ContentType 对象的 MIME 类型。与 MIME 同义，保留两个字段是为了
	// ListItem.MIME（列表展示用）与 Stat 语义分离：Stat 是权威值。
	ContentType string
	// ContentDisposition 下载时的内容处置头，如 attachment; filename="a.zip"
	ContentDisposition string
	// CacheControl 缓存策略头，如 max-age=3600
	CacheControl string
	// ContentEncoding 内容编码头，如 gzip
	ContentEncoding string
	// UserMetadata 用户自定义元数据（阿里云 x-oss-meta-* / S3 x-amz-meta-*）。
	// 键已剥掉厂商前缀，两侧统一用裸键名。
	UserMetadata map[string]string
	// StorageClass 存储类别（归一化后的规范值，见 StorageClass* 常量）
	StorageClass string
	// Tags 对象标签
	Tags map[string]string
}

// 归一化存储类别（跨厂商的公共子集）。
//
// 各家枚举名不同：阿里云是 Standard/IA/Archive/ColdArchive/DeepColdArchive，
// S3 是 STANDARD/REDUCED_REDUNDANCY/STANDARD_IA/ONEZONE_IA/GLACIER/DEEP_ARCHIVE。
// 插件只暴露下面这几个两侧都有对应物的档位，其余按驱动能力隐藏。
const (
	StorageClassStandard = "standard" // 标准存储
	StorageClassIA       = "ia"       // 低频访问
	StorageClassArchive  = "archive"  // 归档
)

// normalizeStorageClass 把外部传入的存储类别归一化为规范值。
// 空串 = 不指定（用服务端默认）；无法识别的值也返回空串（由调用方决定是否报错）。
func normalizeStorageClass(v string) string {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case StorageClassStandard, "std", "normal":
		return StorageClassStandard
	case StorageClassIA, "infrequent", "infrequent_access", "standard_ia", "onezone_ia":
		return StorageClassIA
	case StorageClassArchive, "glacier", "deep_archive", "deeparchive":
		return StorageClassArchive
	default:
		return ""
	}
}

// MergeUserMetadata 合并用户元数据：已有值优先保留，空键补入。
// 用于「只改 Content-Type、不动已有 meta」的增量编辑。
func MergeUserMetadata(old, patch map[string]string) map[string]string {
	if len(patch) == 0 {
		return old
	}
	out := make(map[string]string, len(old)+len(patch))
	for k, v := range old {
		out[k] = v
	}
	for k, v := range patch {
		if v == "" {
			delete(out, k) // 空值 = 删除该键
			continue
		}
		out[k] = v
	}
	return out
}

// DeleteFailure 记录批量删除中单个 key 的失败原因。
type DeleteFailure struct {
	Key   string
	Error string
}

// allFailed 构造「全部 key 失败」清单：整批失败（网络/权限等）无法细分
// 逐 key 结果时的兜底表达。
func allFailed(paths []string, err error) []DeleteFailure {
	fails := make([]DeleteFailure, 0, len(paths))
	for _, k := range paths {
		fails = append(fails, DeleteFailure{Key: k, Error: err.Error()})
	}
	return fails
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
	// GetObjectAcl 查询对象是否公共读：public 为 true 表示任何持 URL 者可匿名访问
	// （预签名 URL 之外的另一条分享路径——公共读链接没有过期时间）。
	GetObjectAcl(bucket, path string) (public bool, err error)
	// SetObjectAcl 切换对象公共读 / 私有。这是「永久公开」的开关，与预签名无关，
	// 因此 handler 层对只读连接直接拒绝；不是所有驱动都支持写 ACL（见各实现）。
	SetObjectAcl(bucket, path string, public bool) error
	Delete(bucket, path string) error
	// DeleteMany 批量删除一组明确的 key。驱动应使用服务端批量接口
	//（阿里云 DeleteObjects / minio-go RemoveObjects，单次 ≤1000 key）。
	// 返回成功删除的数量与逐 key 失败清单；不可细分的整批失败（如网络/权限）
	// 记为全部 key 失败，不返回 error。
	DeleteMany(bucket string, paths []string) (int, []DeleteFailure)
	// DeletePrefix 递归删除 prefix 下的全部对象（含 prefix 自身的目录标记对象），
	// 返回实际删除的对象数。
	// 对象存储没有真正的目录，目录只是 delimiter 折叠出的逻辑前缀——若仅对 prefix
	// 发一次 DELETE，命中的是不存在的 key，服务端按幂等语义返回成功，目录却纹丝不动
	// （假成功）。因此删除目录必须由驱动真正列举 prefix 下的所有 key 并逐批删除。
	// 实现必须流式：列举一页（≤1000 key）删一页，不设总量上限，任意大小目录均可删。
	DeletePrefix(bucket, prefix string) (int, error)
	// Move 重命名/移动。对象存储均无原生 rename，驱动内部用 copy + delete 实现。
	Move(bucket, from, to string) error
	// Copy 复制单个对象（不删源）。批量复制/移动的底层能力；目标已存在时
	// 由 handler 层先做冲突检查，驱动内不做判断（CopyObject 覆盖写）。
	Copy(bucket, from, to string) error
	// MovePrefix 递归重命名/移动一个「目录」（对象存储里的逻辑前缀）。
	//
	// 为什么必须有它：Move 是单 key 的 copy+delete，对象存储没有实体目录，
	// 目录只是 delimiter 折叠出的前缀。对前缀直接 Move 会命中不存在的
	// 「目录标记对象」——要么 CopyObject 报 NoSuchKey，要么侥幸搬动了一个
	// 空壳而 prefix 下的子对象原地不动，表现为「改名后目录内容凭空消失」。
	//
	// 语义：把 fromPrefix 下的全部对象（含子层级）复制到 toPrefix 之下，
	// 复制成功后删除源对象。返回被移动的对象数。
	// 实现必须流式：按页（≤1000 key）「复制该页 → 删除该页」推进，不设总量上限；
	// 页内失败回滚该页已复制的目标对象。跨页失败时已完成页无法回滚，
	// 错误信息须如实报告已完成数量（重跑 move 可续：CopyObject 覆盖写幂等）。
	MovePrefix(bucket, fromPrefix, toPrefix string) (int, error)

	// ---------- 2.2 跨桶复制 ----------
	//
	// 跨桶与同桶是两条不同的服务端调用，不能靠参数拼凑：
	//   - 阿里云 OSS：CopyObjectTo（目标桶）/ CopyObjectFrom（源桶）
	//   - S3 兼容：CopyObject 的 src/dst 各自带 bucket
	// 因此单列方法，避免 Copy 的 bucket 参数被误当成两个桶。
	//
	// CopyAcross 复制单个对象，源桶与目标桶可不同（同名 srcBucket/dstBucket 即同桶）。
	// 目标已存在时同样由 handler 层先做冲突检查。
	CopyAcross(srcBucket, dstBucket, from, to string) error
	// MoveAcross 跨桶移动单个对象（copy + delete）。
	MoveAcross(srcBucket, dstBucket, from, to string) error
	// CopyPrefixAcross 跨桶递归复制一个前缀（目录）。返回复制的对象数。
	// 不删源对象——这正是与 MovePrefix 的区别。
	// 实现必须流式：按页复制，不设对象数上限。
	CopyPrefixAcross(srcBucket, dstBucket, fromPrefix, toPrefix string) (int, error)

	// ---------- 2.1 元数据编辑 ----------
	//
	// SetMeta 改写对象元数据（Content-Type / Content-Disposition / CacheControl /
	// 自定义 meta）。
	//
	// 对象存储没有「原地改元数据」的 API：阿里云与 S3 都只能靠
	// CopyObject + MetadataDirective=REPLACE 把对象复制到自身并替换元数据。
	// 因此实现必须是「自复制」（from == to），且要保证服务端允许这种自复制。
	//
	// patch 中空字符串表示「不改这一项」（避免前端误传空值清掉已有内容）；
	// UserMetadata 为 nil 表示不动已有自定义元数据，非 nil 则整体替换。
	SetMeta(bucket, path string, patch MetaPatch) error

	// ---------- 2.3 对象标签 ----------
	//
	// SetTags 覆盖式设置对象标签（传空 map 表示清空所有标签）。
	// GetTags 读取对象标签；对象无标签时返回空 map 而非错误。
	SetTags(bucket, path string, tags map[string]string) error
	GetTags(bucket, path string) (map[string]string, error)

	// ---------- 2.5 存储类别 ----------
	//
	// PutWithClass / PutFromFileWithClass 是带存储类别的上传入口。
	// 单独开方法而不改原 Put/PutFromFile 签名，是为了不惊动现有调用点；
	// 但两者最终都走同一套上传逻辑。
	PutWithClass(bucket, path string, r io.Reader, size int64, mime, storageClass string) error
	PutFromFileWithClass(bucket, path, filePath, mime, storageClass string) error
}

// MetaPatch 元数据增量修改。
//
// 空字符串 = 该项不修改（区别于「置空」）；UserMetadata 为 nil = 不动自定义元数据。
type MetaPatch struct {
	ContentType        string
	ContentDisposition string
	CacheControl       string
	ContentEncoding    string
	UserMetadata       map[string]string
	// StorageClass 非空时同时改写存储类别（归一化值）。
	// 注意：阿里云改存储类别需配合「归档类型对象的恢复」语义，
	// 各驱动按自身能力实现，不支持的直接报错。
	StorageClass string
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
