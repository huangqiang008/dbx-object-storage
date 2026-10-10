# 对象存储 / Object Storage

[![Version](https://img.shields.io/badge/version-0.4.0-blue)](https://github.com/huangqiang008/dbx-object-storage/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

> DBX 插件：通用对象存储浏览器。一个插件同时支持阿里云 OSS 原生与 S3 兼容协议（MinIO、AWS S3、Cloudflare R2、腾讯 COS、华为 OBS、Backblaze B2 等）。
>
> A DBX plugin — a generic object storage browser for Alibaba Cloud OSS and any S3-compatible service.

## 功能特性

- **多协议驱动**：`StorageDriver` 抽象层统一厂商差异——阿里云 OSS 走原生 SDK，其余走 S3 兼容协议（minio-go），新增存储只需实现一个驱动接口
- **大目录友好**：服务端分页（marker 游标，单页 10–1000 可配）+ 列表虚拟化渲染，百万级目录不卡顿、不爆内存
- **大文件上传**：256KB 分片直传 sidecar 暂存，落盘后流式上转（阿里云分片并发 / MinIO 自动 multipart），内存恒定、可中途取消
- **预签名分享**：一键生成带有效期的 GET URL（60 秒–7 天），失败自动回退拼接地址
- **文件预览**：图片 / 视频 / 音频 / PDF / 文本 / 代码（highlight.js 高亮）/ Markdown 渲染，超大文件截断保护
- **多选批量**：复选框多选（表头三态全选），批量删除（逐条容错）、批量下载（一次选目录、自动防覆盖、进度浮窗）
- **本地下载**：sidecar 流式下载到本机（支持任意大小），不占用 webview 内存
- **体验细节**：中英双语跟随宿主、明暗主题跟随宿主、面包屑导航、名称前缀过滤、图标化文件类型

## 安装

- **插件商店**：提交 `t8y2/dbx-store` 审核中，通过后可在 DBX 插件商店安装
- **手动安装**：从 [Releases](https://github.com/huangqiang008/dbx-object-storage/releases) 下载 `com.object.browser-x.y.z-windows-x64.dbxp` 安装

## 连接配置

| 字段 | 说明 |
|---|---|
| 存储类型 | `阿里云 OSS` 或 `S3 兼容（MinIO 等）` |
| AccessKeyId / Secret | 访问密钥，建议 RAM 子账号最小权限 |
| 接入点 | 阿里云：`oss-cn-hangzhou.aliyuncs.com`；MinIO：`http://192.168.1.10:9000`（含协议与端口）；R2：`https://<account>.r2.cloudflarestorage.com` |
| Region | 仅 S3 兼容需要时填写，留空自动探测 |
| Path Style | 自建 MinIO 建议勾选（以路径寻址） |
| Bucket | 留空则根目录列出全部存储桶 |
| 分页大小 | 每页列取对象数（10–1000，默认 200） |

## 开发

```bash
# 本地调试宿主（热加载 ui/，Go 后端自动构建）
dbx-plugin dev --path .

# 打包（产出 dist/*.dbxp + artifact 元数据，未签名候选包）
dbx-plugin package
```

### 目录结构

```
├── manifest.json          # 插件清单（id / 权限 / 连接表单 / 贡献点）
├── backend/               # Go Sidecar（stdio-jsonl JSON-RPC 2.0）
│   ├── driver.go          #   StorageDriver 抽象 + 连接解析（flexString 宽容解码）
│   ├── driver_aliyun.go   #   阿里云 OSS 原生实现
│   ├── driver_s3.go       #   S3 兼容实现（V1 marker 分页语义对齐阿里云）
│   ├── main.go            #   JSON-RPC 分发
│   └── oss.go             #   RPC handlers（list/read/write/delete/upload/presign/save...）
├── ui/                    # 沙箱 webview 前端（原生 JS，无框架）
│   ├── main.js            #   虚拟化列表 / 分片上传 / 预览 / 多选批量
│   ├── i18n.js            #   zh-CN / en 双语
│   └── index.html / styles.css
└── dist/                  # 构建产物（不入库）
```

### 关键设计

- **分页游标**：S3 V1 `marker` 与阿里云 `marker` 语义对齐（delimiter 场景下可用最后一个 CommonPrefixes 续页），UI 层 token 不透明透传
- **CSP 合规**：沙箱 `img-src 'self' data: blob:`——预览媒体一律分块读取拼 `Blob URL`，不走远程直链
- **下载落盘**：webview 沙箱拦截文件下载，改由 sidecar 流式写入本机并返回路径

## 发布流程

1. 更新 `manifest.json` 版本 → `dbx-plugin package` 重新打包
2. 打 tag 并创建 GitHub Release，上传 `.dbxp`、`.artifact.json`、`release-candidates.json`
3. `dbx-store` 同步 Workflow 自动创建候选 PR → 维护者审核签名 → 进入官方目录

## License

[MIT](LICENSE)
