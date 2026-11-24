package main

// driver_s3_test.go — S3 驱动寻址风格单测（issue #15）。
//
// 腾讯云 COS 自 2024-01-01 起新建桶仅支持 virtual-hosted-style 域名，
// path-style 直接报 "must be addressed using cos virtual-styled domain"。
// minio-go 的 Auto 模式对非 Amazon 端点一律 path-style，覆盖不到这类云；
// 修复后按端点后缀强制虚拟主机式，显式 pathStyle 以用户选择为准。
//
// minio.Client 的 lookup 字段未导出，用反射断言实际生效的寻址风格。

import (
	"reflect"
	"testing"

	"github.com/minio/minio-go/v7"
)

func s3LookupOf(t *testing.T, cfg ConnConfig) minio.BucketLookupType {
	t.Helper()
	d, err := newS3Driver(cfg)
	if err != nil {
		t.Fatalf("构造 s3Driver 失败: %v", err)
	}
	cl := d.(*s3Driver).cl
	v := reflect.ValueOf(cl).Elem().FieldByName("lookup")
	if !v.IsValid() {
		t.Fatal("minio.Client 缺少 lookup 字段，minio-go 版本可能不兼容")
	}
	return minio.BucketLookupType(v.Int())
}

func TestS3BucketLookupStyle(t *testing.T) {
	cases := []struct {
		name      string
		endpoint  string
		pathStyle bool
		want      minio.BucketLookupType
	}{
		{"COS 端点默认虚拟主机式（issue #15 主场景）", "cos.ap-guangzhou.myqcloud.com", false, minio.BucketLookupDNS},
		{"COS 端点显式 pathStyle 以用户为准", "cos.ap-guangzhou.myqcloud.com", true, minio.BucketLookupPath},
		{"COS 端点带端口仍走虚拟主机式", "cos.ap-guangzhou.myqcloud.com:443", false, minio.BucketLookupDNS},
		{"COS 端点带 scheme 与端口仍走虚拟主机式", "https://cos.ap-guangzhou.myqcloud.com:443", false, minio.BucketLookupDNS},
		{"COS tencentcos.cn 主域名走虚拟主机式", "cos.ap-guangzhou.tencentcos.cn", false, minio.BucketLookupDNS},
		{"COS tencentcos.cn 内网域名走虚拟主机式", "cos-internal.ap-guangzhou.tencentcos.cn", false, minio.BucketLookupDNS},
		{"COS 域名大小写不敏感", "COS.AP-GUANGZHOU.MYQCLOUD.COM", false, minio.BucketLookupDNS},
		{"COS 域名末尾点（绝对 FQDN）也命中", "cos.ap-guangzhou.myqcloud.com.", false, minio.BucketLookupDNS},
		{"OBS 端点默认虚拟主机式", "obs.cn-north-1.myhuaweicloud.com", false, minio.BucketLookupDNS},
		{"通用 s3 形状的内网 COS 域名也命中", "cos-internal.ap-guangzhou.myqcloud.com", false, minio.BucketLookupDNS},
		{"MinIO 自建 IP 维持 Auto（实际走 path-style）", "192.168.1.10:9000", false, minio.BucketLookupAuto},
		{"MinIO 自建域名维持 Auto", "minio.example.com", false, minio.BucketLookupAuto},
		{"AWS 端点维持 Auto（minio-go 自行判定虚拟主机式）", "s3.ap-southeast-1.amazonaws.com", false, minio.BucketLookupAuto},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := s3LookupOf(t, ConnConfig{
				Endpoint:        c.endpoint,
				AccessKeyID:     "test-key",
				AccessKeySecret: "test-secret",
				PathStyle:       c.pathStyle,
			})
			if got != c.want {
				t.Fatalf("寻址风格 = %v, 期望 %v", got, c.want)
			}
		})
	}
}
