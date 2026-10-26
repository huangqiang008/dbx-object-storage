# 对象存储 / Object Storage

[![Version](https://img.shields.io/badge/version-1.2.0-blue)](https://github.com/huangqiang008/dbx-object-storage/releases)
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

- **多协议驱动**：`StorageDriver` 抽象层统一厂商差异——阿里云 OSS 走原生 SDK，其余走 S3 兼容协议（minio-go），新增存储只需实现一个驱动接口。**所有能力双端对等**：只在一侧存在的厂商特性（OSS 的静态网站托管 / 访问日志 / Referer 防盗链等）一律不进接口，避免出现「阿里云能用、S3 不能用」的功能
- **大目录友好**：服务端分页（marker 游标，单页 10–1000 可配）+ 列表虚拟化渲染，百万级目录不卡顿、不爆内存
- **可排序列表**：点表头按名称 / 大小 / 时间升降序，目录恒在前；支持键盘 Tab + Enter 操作。排序在客户端进行（服务端排序对分页外的对象无效）
- **大文件上传**：256KB 分片直传 sidecar 暂存，落盘后流式上转（阿里云分片并发 / MinIO 自动 multipart），内存恒定、可中途取消
- **多文件 / 文件夹上传**：一次选多个文件或整个目录（目录按 `webkitRelativePath` 保留层级），**3 路并发上传**（单文件时按字节显示进度，多文件时按项显示），串行上传 N 个文件要 N 轮往返，并发后接近线性缩短
- **上传存储类别**：工具栏下拉选择 标准 / 低频访问 / 归档（归一化枚举，底层按驱动翻译：阿里云 `Standard/IA/Archive`、S3 `STANDARD/STANDARD_IA/GLACIER`），选择结果记入本机存储
- **断点续传**：上传中途崩溃或被取消后，同一文件再次上传自动从断点继续（分片以 `bucket+key+size` 派生的稳定文件名 + 元数据落盘，跨 sidecar 进程可恢复），超时 24h 的残留自动清理
- **预签名分享**：一键生成带有效期的 GET URL（60 秒–7 天），失败自动回退拼接地址
- **公共读链接（永久分享）**：与预签名是两条路径——预签名必然带过期时间（S3 协议上限 7 天），公共读则把对象 ACL 设为 `public-read`，用不带签名、不过期的普通 URL 访问。行操作「公开链接」会先查当前权限：已公开时可选择恢复私有或复制链接，未公开时需二次确认（明示"任何人可永久访问"）。阿里云 OSS 可在线切换；S3 兼容服务受 minio-go 限制不支持在线改 ACL，需在服务商控制台/桶策略配置，插件只负责读取状态与生成链接
- **对象元数据编辑**：详情面板「编辑元数据」可改 Content-Type / Content-Disposition / Cache-Control / 自定义 meta（`x-oss-meta-*` / `x-amz-meta-*` 归一化）与对象标签。对象存储无「原地改元数据」API，两侧统一用「自复制 + MetadataDirective=REPLACE」实现（会刷新 Last-Modified，属协议固有代价）
- **跨桶复制 / 移动**：批量移动复制对话框顶部可选目标存储桶，跨桶时自动切到跨桶接口（阿里云 `CopyObjectTo`、S3 `CopyObject` 的 src/dst 桶分离）；目录复制（保留源）双端均支持
- **文件预览**：图片 / 视频 / 音频 / PDF（iframe）/ HTML（沙箱 iframe 渲染，浏览器式展示，源码可经「编辑」查看）/ 文本 / 代码（highlight.js 高亮）/ Markdown（marked）渲染，超大文件截断保护。代码/Markdown 预览用的 highlight.js 11.9.0（BSD-3-Clause）与 marked 12.0.2（MIT）自 v1.0.0 起**随包本地分发**（`ui/vendor/`，零外联、离线可用），仅当包内资产缺失时才回退 cdnjs；两者都不可用时降级为纯文本。分块读回时写入预分配 `ArrayBuffer`（峰值约为文件大小 1 倍而非 2 倍），Blob URL 在关闭/切换预览时显式 `revokeObjectURL` 释放，避免反复预览大文件撑爆 webview 内存
- **Office / OFD 预览**：doc/docx/rtf/odt、xls/xlsx/ods/dbf、pptx/potx/ppsx、ofd 共 28 个扩展名，经 file-viewer 安全子集（本地 IIFE + 本地 Worker 资产，零外部请求）渲染。授权边界：仅含 Apache-2.0/MIT 组件，已排除 AGPL CAD 与专有水印 ppt 引擎，详见 `ui/THIRD-PARTY-NOTICES.md`
- **3D 模型预览**：obj/stl/ply/off/3ds/glb/gltf/bim/fbx/dae/wrl/3mf/amf 共 13 个扩展名，经 Online3DViewer 安全子集（本地 IIFE，单实例复用）渲染。授权边界：全链 MIT/Apache-2.0、零 WASM、零外部请求；3dm/ifc/step/iges/brep/fcstd（MPL/LGPL 解码器）与 draco 压缩 glTF 刻意不支持。gltf/obj/dae 引用外部资源时单文件预览会缺资源，.glb/.stl/.ply 最稳
- **重命名**：行操作内置改名（后端 copy + delete，对象存储无原生 rename）。目录改名保留目录语义与所在前缀，改名前检测同名冲突避免静默覆盖；目录改名按页流式搬迁（4 路并发复制、每页复制完成后批量删除源对象），不设对象数上限，跨页失败可重跑续传（覆盖写幂等）
- **批量重命名**：多选后可统一施加「前缀 / 后缀 / 正则替换 / 序号」规则（序号插在扩展名前），规则按 正则→前缀→后缀→序号 依次作用。改名前统一预检冲突（新名字之间互撞、撞上已存在对象），避免半改状态
- **批量移动 / 复制**：多选后一键移动/复制到目标目录（桶内目录树选择器，含目标桶下拉可跨桶）。文件 2 路并发 + 进度卡 + 可取消；目录移动走流式搬迁，目录复制保留源对象。目标同名冲突被拒绝而非覆盖（移动/复制前逐个 HEAD 检查）
- **深度搜索**：搜索框 Shift+Enter 触发，以「当前前缀 + 搜索词」递归扫描整个目录树（游标翻页、进度与可取消、结果上限 2 万条防失控），结果为全 key 平铺列表，批量下载/删除/移动照常可用
- **搜索过滤条件**：工具栏漏斗按钮打开过滤面板，可按 大小区间 / 修改时间区间 / 扩展名白名单 / 名称正则 过滤（客户端筛选——服务端列举协议不支持这些条件），目录项不受过滤影响
- **Shift 范围多选**：按住 Shift 勾选可从上次锚点连选到当前行，批量挑选上百项不用点上百次
- **已保存连接**：连接表单以「名称」为键保存/回填/删除多套连接配置；Secret 仅在勾选「记住 Secret」时一并落盘，否则回填后需重输，不绕过默认不存 Secret 的安全语义
- **多选批量**：复选框多选（表头三态全选），批量删除（服务端批量接口，1000 key/请求分块下发 + 进度浮窗 + 可取消）、批量下载（2 路并发、进度浮窗、可取消，单文件失败自动断点续传）
- **目录删除是真删**：对象存储没有实体目录，目录只是分隔符折叠出的逻辑前缀。这里删除目录会先统计对象数并在确认框中明示，再流式递归清空其下全部对象（列举一页删一页，阿里云 `DeleteObjects` / MinIO `RemoveObjects` 批量删），不设数量上限，任意大小目录都能删，不会出现「提示已删除、目录却还在」的假成功
- **本地下载**：sidecar 流式下载到本机（支持任意大小），不占用 webview 内存；下载中断自动保留断点（`.part` + 元数据），重试同一对象从断点续传（etag/size 校验，对象已变化则整段重来）
- **下载保留目录层级**：批量下载按对象 key 的相对路径落盘（自动建子目录），与上传方向（保留 `webkitRelativePath` 层级）对称——往返一趟结构不散，且不同前缀下的同名对象不再互相改名
- **STS 临时凭证**：连接表单可填 STS Token（与临时 AK/SK 成对下发），阿里云走 `oss.SecurityToken`、S3 走 `credentials.SessionToken`；留空即长期密钥，行为不变。Token 与 Secret 同属凭据，只在勾选「记住 Secret」时才落盘
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
| STS Token | 可选。使用 STS 临时凭证时填写（与临时 AK/SK 成对下发）；留空 = 长期密钥 |
| 分页大小 | 每页列取对象数（10–1000，默认 200） |
| 自定义 CA 证书 | 可选。粘贴服务端 CA 的 PEM 文本，用于校验私有 CA 签发的 HTTPS 端点（优先于「跳过校验」） |
| 跳过 TLS 证书校验 | 可选。关闭服务端证书校验，仅用于自签/内网端点；会失去中间人攻击防护，请仅在可信网络使用 |

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
│   ├── core.js            #   共享核心层：state / els / invoke / 通用弹窗 / OB.shared 容器
│   ├── conn.js            #   连接管理：连接表单、已保存连接、只读守卫、配置持久化
│   ├── browse.js          #   浏览：分页虚拟化、排序、多选、文件图标、快捷键、列宽拖拽
│   ├── batch.js           #   批量操作：删除 / 移动 / 复制 / 重命名 + 目标目录树选择器
│   ├── search.js          #   深度搜索与过滤条件
│   ├── meta.js            #   对象详情面板、元数据编辑
│   ├── transfer.js        #   传输：下载（断点续传）、上传（并发/分片/拖拽）、存储类别
│   ├── preview.js         #   预览：图片/音视频/PDF/文本/代码/MD/Office/3D + 在线编辑 + 公共读扫描
│   ├── app.js             #   入口：启动流程（唯一知道全部模块的地方）
│   ├── utils.js           #   纯工具（转义、格式化、base64 互转）——无状态依赖
│   ├── icons.js           #   内嵌 SVG 图标表（lucide 风格）
│   ├── i18n.js            #   zh-CN / en 双语
│   ├── rename_rule.js     #   批量重命名规则计算（纯函数，可单测）
│   ├── fileviewer/        #   file-viewer 安全子集（构建产物，随包分发）
│   │   ├── viewer.iife.js #     IIFE bundle（全局 FileViewerSDK，懒加载）
│   │   └── assets/        #     运行资产（docx/xlsx/pptx Worker，同源本地加载）
│   ├── o3dv/              #   Online3DViewer 安全子集（构建产物，随包分发）
│   │   └── o3dv.iife.js   #     IIFE bundle（全局 OV，懒加载；源码补丁见 vendor/o3dv-src/）
│   ├── THIRD-PARTY-NOTICES.md # 第三方许可声明（随 .dbxp 分发）
│   ├── vendor/            #   marked / highlight.js（随包本地资产，供 MD 与代码预览）
│   ├── licenses/          #   APACHE-2.0 全文
│   └── index.html / styles.css
├── tests/                 # 前端测试与检查（开发期，不随包分发）
│   ├── verify-modules.js  #   模块完整性（导出 / 引用 / 加载顺序）
│   ├── ui-smoke.test.js   #   UI 冒烟测试（最小 DOM stub 加载全部脚本并驱动关键流程）
│   └── rename_rule.test.js #  重命名规则纯函数单测
├── docs/                  # 文档（docs/RELEASE.md = 发布 runbook）
├── vendor/                # file-viewer 构建工具目录（gitignore；entry.js + 锁定依赖）
└── dist/                  # 构建产物（不入库）
```

### 前端模块化约定

UI 曾是单文件 `main.js`（4500+ 行），现已按功能域拆成 9 个模块。改动前先看这三条约定：

1. **必须用经典 `<script src>`，不能用 ES Module。** 宿主把插件 UI 放在
   `sandbox="allow-scripts"`（无 `allow-same-origin`）的 iframe 里，文档 origin 为 `null`；
   `<script type="module">` 的模块图加载走 CORS 语义，null origin 无法通过 → **静默失败**
   （无报错、无事件）。这是实测结论，不要试图"现代化"成 import/export。

2. **跨模块调用一律走 `OB.xxx`。** `core.js` 建立唯一的全局命名空间 `window.OB`，
   各模块是 `(function (OB) { ... })(window.OB)`，把自己对外能力挂到 `OB` 上。
   纯工具（`esc` / `svg` / `$`）由各模块自行从 `window.Utils` / `window.ICONS` 解构，
   不走 `OB`——避免为了一个 helper 引入跨模块依赖。

3. **跨模块共享的可变状态放 `OB.shared`。** 例如 `lastActAt`（操作节流时间戳）、
   `dl`（下载进度浮窗状态）、`pvCurrentItem`（当前预览项）。这些在原单文件里是同一闭包
   内的模块级变量，拆开后必须显式共享，否则各模块各持一份、互不同步。
   初始值由**归属模块**在自身加载时赋值，`core.js` 只声明容器。

改完跑这三个检查：

```bash
node tests/verify-modules.js          # 导出完备性 / 有无裸调用的跨模块函数 / 脚本顺序
node --test tests/ui-smoke.test.js    # 加载全部脚本并驱动启动、渲染、排序、多选
node --test tests/rename_rule.test.js # 纯函数单测
```

### 测试

```bash
# 后端单测（含 S3 驱动的内存态集成测试）
cd backend && go test ./...

# 前端：模块完整性（导出/引用/加载顺序）
node tests/verify-modules.js

# 前端：UI 冒烟测试（最小 DOM stub 加载全部脚本，驱动启动/渲染/排序/多选）
node --test tests/ui-smoke.test.js

# 前端：纯函数单测（Node 内置 test runner，零外部依赖）
node --test tests/rename_rule.test.js
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
