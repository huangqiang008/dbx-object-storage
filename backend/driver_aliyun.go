package main

// driver_aliyun.go — 阿里云 OSS 原生驱动（aliyun-oss-go-sdk）。
// 逻辑自原 oss.go 平移，行为保持不变。

import (
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/aliyun/aliyun-oss-go-sdk/oss"
)

type aliyunDriver struct {
	baseDriver
	client *oss.Client
}

func newAliyunDriver(cfg ConnConfig) (StorageDriver, error) {
	client, err := oss.New(cfg.Endpoint, cfg.AccessKeyID, cfg.AccessKeySecret)
	if err != nil {
		return nil, err
	}
	return &aliyunDriver{baseDriver: baseDriver{cfg: cfg}, client: client}, nil
}

// bucket 按名取 bucket；name 为空时回落默认 bucket。
func (d *aliyunDriver) bucket(name string) (*oss.Bucket, error) {
	n, err := d.pickBucket(name)
	if err != nil {
		return nil, err
	}
	return d.client.Bucket(n)
}

func (d *aliyunDriver) ListBuckets() ([]BucketInfo, error) {
	res, err := d.client.ListBuckets()
	if err != nil {
		return nil, err
	}
	out := make([]BucketInfo, 0, len(res.Buckets))
	for _, b := range res.Buckets {
		out = append(out, BucketInfo{Name: b.Name})
	}
	return out, nil
}

func (d *aliyunDriver) ListObjects(req ListReq) (ListPage, error) {
	b, err := d.bucket(req.Bucket)
	if err != nil {
		return ListPage{}, err
	}
	delim := req.Delimiter
	if delim == "" {
		delim = "/"
	}
	max := req.MaxKeys
	if max <= 0 {
		max = 200
	}
	if max > 1000 {
		max = 1000
	}
	opts := []oss.Option{oss.Prefix(req.Prefix), oss.Delimiter(delim), oss.MaxKeys(max)}
	if req.Token != "" {
		opts = append(opts, oss.Marker(req.Token))
	}
	resp, err := b.ListObjects(opts...)
	if err != nil {
		return ListPage{}, err
	}
	page := ListPage{Truncated: resp.IsTruncated, NextToken: resp.NextMarker}
	for _, cp := range resp.CommonPrefixes {
		page.Items = append(page.Items, ListItem{Name: cp, IsDir: true, Mime: "application/x-directory"})
	}
	for _, o := range resp.Objects {
		if o.Key == req.Prefix {
			continue
		}
		page.Items = append(page.Items, ListItem{
			Name:     o.Key,
			Size:     o.Size,
			Mime:     guessMime(o.Key),
			Modified: o.LastModified.Format(time.RFC3339),
		})
	}
	return page, nil
}

func (d *aliyunDriver) Stat(bucket, path string) (ObjMeta, error) {
	b, err := d.bucket(bucket)
	if err != nil {
		return ObjMeta{}, err
	}
	h, err := b.GetObjectMeta(path)
	if err != nil {
		return ObjMeta{}, err
	}
	m := ObjMeta{
		MIME: h.Get("Content-Type"),
		ETag: strings.Trim(h.Get("ETag"), `"`),
	}
	if s := h.Get("Content-Length"); s != "" {
		m.Size, _ = strconv.ParseInt(s, 10, 64)
	}
	if lm := h.Get("Last-Modified"); lm != "" {
		if t, e := http.ParseTime(lm); e == nil {
			m.Modified = t.Format(time.RFC3339)
		}
	}
	if m.MIME == "" {
		m.MIME = guessMime(path)
	}
	return m, nil
}

func (d *aliyunDriver) OpenRange(bucket, path string, offset, limit int64) (ObjMeta, io.ReadCloser, error) {
	b, err := d.bucket(bucket)
	if err != nil {
		return ObjMeta{}, nil, err
	}
	meta, err := d.Stat(bucket, path)
	if err != nil {
		return ObjMeta{}, nil, fmt.Errorf("读取元数据失败: %w", err)
	}
	body, err := b.GetObject(path, oss.Range(offset, offset+limit-1))
	if err != nil {
		return ObjMeta{}, nil, err
	}
	return meta, body, nil
}

func (d *aliyunDriver) OpenStream(bucket, path string) (io.ReadCloser, error) {
	b, err := d.bucket(bucket)
	if err != nil {
		return nil, err
	}
	return b.GetObject(path)
}

func (d *aliyunDriver) Put(bucket, path string, r io.Reader, _ int64, mime string) error {
	b, err := d.bucket(bucket)
	if err != nil {
		return err
	}
	var opts []oss.Option
	if mime != "" {
		opts = append(opts, oss.ContentType(mime))
	}
	return b.PutObject(path, r, opts...)
}

// PutFromFile 分片并发上传本地文件（5MB 分片 + 断点），不整文件进内存。
func (d *aliyunDriver) PutFromFile(bucket, path, filePath, mime string) error {
	b, err := d.bucket(bucket)
	if err != nil {
		return err
	}
	var opts []oss.Option
	if mime != "" {
		opts = append(opts, oss.ContentType(mime))
	}
	opts = append(opts, oss.Checkpoint(true, ""), oss.Routines(3))
	return b.UploadFile(path, filePath, 5*1024*1024, opts...)
}

// Presign 离线计算签名 URL（V1 签名，不发网络请求）。
func (d *aliyunDriver) Presign(bucket, path string, expires int64) (string, error) {
	b, err := d.bucket(bucket)
	if err != nil {
		return "", err
	}
	return b.SignURL(path, oss.HTTPGet, expires)
}

func (d *aliyunDriver) Delete(bucket, path string) error {
	b, err := d.bucket(bucket)
	if err != nil {
		return err
	}
	return b.DeleteObject(path)
}

func (d *aliyunDriver) Move(bucket, from, to string) error {
	b, err := d.bucket(bucket)
	if err != nil {
		return err
	}
	if _, err := b.CopyObject(from, to); err != nil {
		return fmt.Errorf("复制失败: %w", err)
	}
	if err := b.DeleteObject(from); err != nil {
		return fmt.Errorf("删除源失败: %w", err)
	}
	return nil
}
