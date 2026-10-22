# 对象存储 / Object Storage

[![Version](https://img.shields.io/badge/version-1.1.1-blue)](https://github.com/huangqiang008/dbx-object-storage/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

> DBX 插件：通用对象存储浏览器。一个插件同时支持阿里云 OSS 原生与 S3 兼容协议（MinIO、AWS S3、Cloudflare R2、腾讯 COS、华为 OBS、Backblaze B2 等）。
>
> A DBX plugin — a generic object storage browser for Alibaba Cloud OSS and any S3-compatible service.

## 平台支持

原生后端（Go sidecar）须在各目标平台**本机打包**——DBX 的 `dbx-plugin package` 会按当前平台自动重写 `manifest.json` 的 `entrypoints.backend.executable` 并编译后端，因此不能用单个 `universal` 包覆盖所有平台。已验证 / 规划的 target 命名：

| target | 平台 | 备注 |
|---|---|---|
| `windows-x64` | Windows | 已发布 |
| `darwin-arm64` | macOS Apple Silicon | 二进制需签名；Go 的 ad-hoc 签名默认可用，正式分发建议 Developer ID 签名 + 公证 |
| `darwin-x64` | macOS Intel | Intel 接受未签名 x86_64 |
| `linux-x64` / `linux-arm64` | Linux | 可选，静态链接 ELF |

> 从插件中心安装时，宿主按本机 target 自动选择对应的 `.dbxp`；多平台发布由 `scripts/release.sh` 聚合到 `store-submission/release-candidates.json`。

## 功能特性

- **多协议驱动**：`StorageDriver` 抽象层统一厂商差异——阿里云 OSS 走原生 SDK，其余走 S3 兼容协议（minio-go），新增存储只需实现一个驱动接口
- **大目录友好**：服务端分页（marker 游标，单页 10–1000 可配）+ 列表虚拟化渲染，百万级目录不卡顿、不爆内存
- **可排序列表**：点表头按名称 / 大小 / 时间升降序，目录恒在前；支持键盘 Tab + Enter 操作。排序在客户端进行（服务端排序对分页外的对象无效）
- **大文件上传**：256KB 分片直传 sidecar 暂存，落盘后流式上转（阿里云分片并发 / MinIO 自动 multipart），内存恒定、可中途取消
- **多文件 / 文件夹上传**：一次选多个文件或整个目录（目录按 `webkitRelativePath` 保留层级），串行上传并汇总成功/失败
- **断点续传**：上传中途崩溃或被取消后，同一文件再次上传自动从断点继续（分片以 `bucket+key+size` 派生的稳定文件名 + 元数据落盘，跨 sidecar 进程可恢复），超时 24h 的残留自动清理
- **预签名分享**：一键生成带有效期的 GET URL（60 秒–7 天），失败自动回退拼接地址
- **公共读链接（永久分享）**：与预签名是两条路径——预签名必然带过期时间（S3 协议上限 7 天），公共读则把对象 ACL 设为 `public-read`，用不带签名、不过期的普通 URL 访问。行操作「公开链接」会先查当前权限：已公开时可选择恢复私有或复制链接，未公开时需二次确认（明示"任何人可永久访问"）。阿里云 OSS 可在线切换；S3 兼容服务受 minio-go 限制不支持在线改 ACL，需在服务商控制台/桶策略配置，插件只负责读取状态与生成链接
- **文件预览**：图片 / 视频 / 音频 / PDF（iframe）/ 文本 / 代码（highlight.js 高亮）/ Markdown（marked）渲染，超大文件截断保护。代码/Markdown 预览用的 highlight.js 11.9.0（BSD-3-Clause）与 marked 12.0.2（MIT）自 v1.0.0 起**随包本地分发**（`ui/vendor/`，零外联、离线可用），仅当包内资产缺失时才回退 cdnjs；两者都不可用时降级为纯文本。分块读回时写入预分配 `ArrayBuffer`（峰值约为文件大小 1 倍而非 2 倍），Blob URL 在关闭/切换预览时显式 `revokeObjectURL` 释放，避免反复预览大文件撑爆 webview 内存
- **Office / OFD 预览**：doc/docx/rtf/odt、xls/xlsx/ods/dbf、pptx/potx/ppsx、ofd 共 28 个扩展名，经 file-viewer 安全子集（本地 IIFE + 本地 Worker 资产，零外部请求）渲染。授权边界：仅含 Apache-2.0/MIT 组件，已排除 AGPL CAD 与专有水印 ppt 引擎，详见 `ui/THIRD-PARTY-NOTICES.md`
- **3D 模型预览**：obj/stl/ply/off/3ds/glb/gltf/bim/fbx/dae/wrl/3mf/amf 共 13 个扩展名，经 Online3DViewer 安全子集（本地 IIFE，单实例复用）渲染。授权边界：全链 MIT/Apache-2.0、零 WASM、零外部请求；3dm/ifc/step/iges/brep/fcstd（MPL/LGPL 解码器）与 draco 压缩 glTF 刻意不支持。gltf/obj/dae 引用外部资源时单文件预览会缺资源，.glb/.stl/.ply 最稳
- **重命名**：行操作内置改名（后端 copy + delete，对象存储无原生 rename）。目录改名保留目录语义与所在前缀，改名前检测同名冲突避免静默覆盖
- **多选批量**：复选框多选（表头三态全选），批量删除（逐条容错）、批量下载（一次选目录、自动防覆盖、进度浮窗）
- **目录删除是真删**：对象存储没有实体目录，目录只是分隔符折叠出的逻辑前缀。这里删除目录会先统计对象数并在确认框中明示，再递归清空其下全部对象（阿里云 `DeleteObjects` / MinIO `RemoveObjects` 批量删），不会出现「提示已删除、目录却还在」的假成功；对象数超过 1000 时中止并提示分批处理
- **本地下载**：sidecar 流式下载到本机（支持任意大小），不占用 webview 内存
- **体验细节**：中英双语跟随宿主、明暗主题跟随宿主、面包屑导航、名称前缀过滤、图标化文件类型
- **凭据安全**：AccessKeySecret **默认不落盘**，重开需重输；也可勾选「在本机记住 Secret」由用户显式取舍（明文写入本机插件存储，仅本插件可读）。推荐做法是由宿主统一管理连接（`manifest.json` 的 connection-provider 声明 `binding: "secret"`，凭据经 `context.connection.connection_secrets` 下发，由宿主安全托管，无需插件自己存）

## 安装

- **插件商店**：提交 `t8y2/dbx-store` 审核中，通过后可在 DBX 插件商店安装
- **手动安装**：从 [Releases](https://github.com/huangqiang008/dbx-object-storage/releases) 下载对应平台的包：`com.object.browser-x.y.z-windows-x64.dbxp`（Windows）、`com.object.browser-x.y.z-darwin-arm64.dbxp`（macOS Apple Silicon）、`com.object.browser-x.y.z-darwin-x64.dbxp`（macOS Intel）。插件中心会自动按本机架构选择。

## 连接配置

| 字段 | 说明 |
|---|---|
| 存储类型 | `阿里云 OSS` / `腾讯云 COS` / `华为云 OBS` / `AWS S3` / `MinIO` / `Cloudflare R2` / `Wasabi` / `Backblaze B2` / `其他 S3 兼容服务` |
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
# 必须在目标平台本机执行；DBX 会按当前平台重写 executable 并编译后端
dbx-plugin package
```

#### file-viewer 预览资源重建（仅在升级或增删格式时）

`ui/fileviewer/` 与 `ui/o3dv/` 下的 IIFE 由 `vendor/`（gitignore 的构建工具目录）生成，**不随仓库提交的业务代码变动**；若需升级引擎或增删渲染器/导入器：

```bash
cd vendor
npm install                                    # 按 package.json 锁定的安全子集（禁装 preset-*/renderer-cad/renderer-ppt）

# file-viewer（Office/OFD）
npx file-viewer-copy-assets ../ui/fileviewer/assets   # 拷贝运行资产后须按 ui/THIRD-PARTY-NOTICES.md 第三节剪枝
node_modules/.bin/esbuild entry.js --bundle --format=iife --global-name=FileViewerSDK \
  --outfile=../ui/fileviewer/viewer.iife.js --target=es2020 --minify --metafile=bundle-meta.json

# Online3DViewer（3D；源码在 vendor/o3dv-src/，含授权补丁：摘除 rhino3dm/web-ifc/occt
# 导入器并把全部 CDN URL 改为包内死路径，构建后必须 grep 校验零 jsdelivr 字符串）
node_modules/.bin/esbuild o3dv-src/engine/main.js --bundle --format=iife --global-name=OV \
  --outfile=../ui/o3dv/o3dv.iife.js --target=es2020 --minify --metafile=o3dv-meta.json
```

完成后必须按新 bundle 的 metafile 重新生成 `ui/THIRD-PARTY-NOTICES.md`。

### 多平台构建与发布脚本

原生 sidecar 必须逐平台本机打包，以下脚本辅助多平台发布：

- `scripts/release.sh`：在每次 `dbx-plugin package` 后运行，扫描 `dist/` 当前版本的全部 `.dbxp`，计算 sha256/size 并聚合写入 `store-submission/release-candidates.json` 的 `targets`。
- `scripts/sign-macos.sh`：仅 macOS，可选对 `bin/darwin-*/backend` 做 Developer ID 签名 + 公证（消除 Gatekeeper 拦截；`darwin-arm64` 至少需 Go 的 ad-hoc 签名）。签名后再执行 `dbx-plugin package`。
- `scripts/set-target.sh <target>`：后备工具，手动把 `manifest.json` 的 `executable` 指向某平台二进制（仅当所用打包器不自动重写时）。

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
│   ├── main.js            #   状态与业务编排：连接/浏览/排序/多选/下载/上传/预览
│   ├── utils.js           #   纯工具（转义、格式化、base64 互转）——无状态依赖
│   ├── icons.js           #   内嵌 SVG 图标表（lucide 风格）
│   ├── i18n.js            #   zh-CN / en 双语
│   ├── fileviewer/        #   file-viewer 安全子集（构建产物，随包分发）
│   │   ├── viewer.iife.js #     IIFE bundle（全局 FileViewerSDK，懒加载）
│   │   └── assets/        #     运行资产（docx/xlsx/pptx Worker，同源本地加载）
│   ├── o3dv/              #   Online3DViewer 安全子集（构建产物，随包分发）
│   │   └── o3dv.iife.js   #     IIFE bundle（全局 OV，懒加载；源码补丁见 vendor/o3dv-src/）
│   ├── THIRD-PARTY-NOTICES.md # 第三方许可声明（随 .dbxp 分发）
│   ├── vendor/            #   marked / highlight.js（随包本地资产，供 MD 与代码预览）
│   ├── licenses/          #   APACHE-2.0 全文
│   └── index.html / styles.css
├── docs/                  # 文档（docs/RELEASE.md = 发布 runbook）
├── vendor/                # file-viewer 构建工具目录（gitignore；entry.js + 锁定依赖）
└── dist/                  # 构建产物（不入库）
```

### 关键设计

- **分页游标**：S3 V1 `marker` 与阿里云 `marker` 语义对齐（delimiter 场景下可用最后一个 CommonPrefixes 续页），UI 层 token 不透明透传
- **CSP 合规**：沙箱 `img-src 'self' data: blob:`——预览媒体一律分块读取拼 `Blob URL`，不走远程直链
- **Office 预览本地闭环**：file-viewer 的 IIFE（2.3MB）与 Worker 资产全部随包分发，首次预览 Office 文件时才懒加载；资产基址设为包内绝对 URL，渲染全程无外部请求（不回传文件、不依赖 CDN）。宿主 CSP 需放行 `worker-src 'self'`（Worker 为同源普通 JS，无需 `wasm-unsafe-eval`）；关闭/切换/失败预览时调用 `controller.destroy()` 释放 Worker
- **3D 预览同样本地闭环**：Online3DViewer IIFE（1MB，纯 JS 零 WASM）随包分发、懒加载、单实例复用；引擎源码在 `vendor/o3dv-src/` 打了授权补丁（摘除 rhino3dm/web-ifc/occt 导入器、CDN URL 全部改为包内死路径），构建产物经 grep 校验零 jsdelivr / 零运行时 CDN 请求（chevrotain 内嵌的 unpkg diagrams 默认值字符串不参与运行时加载）
- **下载落盘**：webview 沙箱拦截文件下载，改由 sidecar 流式写入本机并返回路径；落盘目录限定在用户主目录或系统临时目录内（`filepath.Rel` 判定，拒绝 `../` 逃逸与同前缀兄弟目录）

## 发布流程

概要四步（**完整可执行 runbook——含 gh 安装与认证、逐平台打包签名、tag、Release 命令、发布后自检、已知坑——见 [`docs/RELEASE.md`](docs/RELEASE.md)**）：

1. 更新版本号 —— **四处必须同步改**，漏改会导致状态栏显示旧版本，反而干扰排查：

   | 位置 | 字段 |
   |---|---|
   | `manifest.json` | `version` |
   | `backend/oss.go` | `const pluginVersion` |
   | `ui/main.js` | `const BUILD` |
   | `README.md` | 顶部版本徽章 |

   然后在目标平台本机执行 `dbx-plugin package .` 重新打包（原生 sidecar 不支持跨平台打包）
2. 在本仓库根目录运行 `bash scripts/release.sh`，自动扫描 `dist/` 下当前版本的全部 `.dbxp`，聚合 sha256/size 写入 `store-submission/release-candidates.json` 的 `targets`（已含 windows-x64，新增 macOS/Linux 等）
3. 提交、打 tag 并推送：`git tag -a vX.Y.Z` → `git push origin main` → `git push origin vX.Y.Z`
4. 用 `gh release create vX.Y.Z` 创建 GitHub Release，上传各平台的 `.dbxp`、`.artifact.json`、`release-candidates.json`；随后 `dbx-store` 同步 Workflow 自动创建候选 PR → 维护者审核签名 → 进入官方目录

## 免责声明 / Disclaimer

- **商标**：本插件为独立第三方开发，与文中提及的各服务厂商（Alibaba Cloud、Tencent Cloud、Huawei Cloud、Amazon Web Services、MinIO、Cloudflare、Wasabi、Backblaze 等）**无隶属、代理、赞助或背书关系**；插件中出现的厂商名与服务名仅用于标识所兼容的存储协议，相关商标归各自权利人所有。
- **数据与凭据**：连接凭据（AccessKeyId / Secret）仅在本机与用户自己的对象存储服务之间使用，插件不向任何第三方上报；Secret 默认不落盘，勾选「在本机记住 Secret」后以明文保存在本机插件存储中，请自行评估。预签名分享链接在有效期内可被任何持有者访问，请勿用于敏感对象；「公开链接」会把对象设为公共读，链接永久有效且任何人可访问，可随时用同一操作恢复私有。
- **运行时外联**：插件默认**零外部请求**——浏览、上传、下载、Office / 3D 预览与 Markdown / 代码高亮全部使用包内资产。仅当包内高亮资产缺失（如被剪枝）时才会回退请求 cdnjs 的 marked / highlight.js。插件无遥测、无数据上报。

## License

[MIT](LICENSE)

### 第三方许可

本插件集成的 file-viewer 安全子集（`ui/fileviewer/`）与 Online3DViewer 安全子集（`ui/o3dv/`）包含 MIT / Apache-2.0 等第三方组件，完整清单、版权声明、授权选择与引擎源码补丁说明见随包分发的 **[`ui/THIRD-PARTY-NOTICES.md`](ui/THIRD-PARTY-NOTICES.md)**（Apache-2.0 全文见 `ui/licenses/APACHE-2.0.txt`）。

授权边界已审查：不含 AGPL；不含专有水印组件（legacy `.ppt` 引擎 `@file-viewer/ppt` 已排除，`renderer-ppt` 因传递依赖该专有引擎一并排除）；3D 侧不含 MPL/LGPL 解码器（web-ifc/occt-import-js 已连同导入器摘除）；`jszip` 选 MIT、`dompurify` 选 Apache-2.0；两个 bundle 均零 jsdelivr / 零运行时 CDN 请求、file-viewer 资产与 O3DV bundle 零 WASM；Go Sidecar 依赖（MIT/BSD-3-Clause/ISC/Apache-2.0）、lucide 图标（ISC）与随包分发的 marked（MIT）/ highlight.js（BSD-3-Clause）已一并列入声明。
