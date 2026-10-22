# 外部开源项目许可风险审查报告

- 审查对象：Object Storage DBX 插件 v0.4.4 → **v1.0.0**（`com.object.browser`，第二次复核见 §六、§七）
- 审查日期：2026-10-22
- 审查范围：随 `.dbxp` 分发的全部内容（`bin/backend.exe`、`ui/` 两个 bundle 及运行资产）+ 构建期依赖的授权边界
- 结论：**无传染性/专有许可风险，可安全分发**。发现 2 项署名义务缺口（应在发布前补齐）、2 项建议补强、2 项文档措辞修正。均不构成停发级问题。
- **修复状态（2026-10-22）：P1–P3 全部已修复**，变更见文末「修复记录」。

---

## 一、总体结论

| 风险类别 | 结论 |
|---|---|
| AGPL 等强 Copyleft 传染 | **无**。`@flyfish-dev/cad-viewer`（AGPL-3.0）未安装、未捆绑（node_modules 与 bundle metafile 均无） |
| 专有/水印组件 | **无**。`@file-viewer/ppt`（专有水印引擎）未捆绑；node_modules 中的 `.renderer-ppt-*` 隐藏目录为 npm 安装残留，`vendor/` 已 gitignore 且不入包 |
| 双授权选择 | **成立**。jszip 选 MIT、dompurify 选 Apache-2.0，选择声明已写入 `ui/THIRD-PARTY-NOTICES.md` |
| MPL/LGPL 解码器 | **未入包**。web-ifc（MPL-2.0）/ occt-import-js（LGPL-2.1）/ rhino3dm 实体代码不在 o3dv bundle 内（metafile 仅 three + fflate + o3dv 源码），残留字符串为包内死路径 |
| WASM / CDN 闭环 | file-viewer 零 CDN 字符串、两个 bundle 零 WASM；o3dv 残留 2 处 chevrotain 自带 unpkg 默认值（见 §四.5） |
| Go 后端依赖 | 全部宽松许可（MIT / BSD-3-Clause / ISC / Apache-2.0），**无 copyleft**；但署名义务未履行（见 §三.1） |

验证手段：`.dbxp` 解包清单核对、esbuild metafile 逐包提取、bundle 字符串扫描、Go 模块缓存 LICENSE/NOTICE 原文核对、`go version -m` 确认实际链入 backend.exe 的模块。

---

## 二、分发内容与许可全景

### 2.1 Go Sidecar（`bin/*/backend.exe`，`go version -m` 实测链入 15 个模块）

| 模块 | 版本 | 许可 | 版权方 |
|---|---|---|---|
| aliyun/aliyun-oss-go-sdk | v3.0.2+incompatible | MIT | aliyun.com |
| minio/minio-go/v7 | v7.0.77 | Apache-2.0（**含 NOTICE 文件**） | MinIO, Inc. |
| go-ini/ini | v1.67.0 | Apache-2.0 | — |
| minio/md5-simd | v1.1.2 | Apache-2.0 | — |
| google/uuid | v1.6.0 | BSD-3-Clause | Google Inc. |
| klauspost/compress | v1.17.9 | BSD-3-Clause | Go Authors / Klaus Post |
| golang.org/x/{crypto,net,sys,text,time} | — | BSD-3-Clause | The Go Authors |
| dustin/go-humanize | v1.0.1 | MIT | Dustin Sallings |
| goccy/go-json | v0.10.3 | MIT | Masaaki Goshima |
| rs/xid | v1.6.0 | MIT | Olivier Poitrey |
| klauspost/cpuid/v2 | v2.2.8 | MIT | Klaus Post |

（测试期模块 go-spew[ISC] / go-difflib / check.v1 / yaml.v3 未链入二进制，不产生分发义务。）

### 2.2 `ui/fileviewer/viewer.iife.js`（2.3MB，metafile 实测 17 个顶层包 + 3 个 vendor 子库）

| 组件 | 许可 | 备注 |
|---|---|---|
| @file-viewer/{core,web,renderer-*×4,pptx,docx} | Apache-2.0 | 无 NOTICE 文件（已核验） |
| @file-viewer/doc | MIT | — |
| jszip 3.10.2 | **(MIT OR GPL-3.0) → 选 MIT** | 选择已声明 |
| dompurify 3.4.16 | **(MPL-2.0 OR Apache-2.0) → 选 Apache-2.0** | 选择已声明 |
| pako 1.0.11 | MIT AND Zlib | 未修改，双条款义务已说明 |
| utif / tinycolor2 / e-virt-table / @xmldom/xmldom | MIT | — |
| styled-exceljs 0.21.6 | Apache-2.0 | — |
| **dltech/jbig2**（renderer-ofd 内嵌） | Apache-2.0 | Mozilla Foundation，源自 pdf.js JBIG2 解码器 |
| **dltech/ofd**（renderer-ofd 内嵌） | Apache-2.0 | DLTech21 ofd.js |
| **lapo-asn1js**（renderer-ofd 内嵌） | **ISC** | Lapo Luchini，@lapo/asn1js@1.2.1 派生 |
| docx-preview 派生代码 | Apache-2.0 | Copyright (c) 2016-2023 Volodymyr Baydalka |
| Adobe Symbol Encoding 表 | Unicode 许可 | Copyright (c) 1991-2011 Unicode, Inc.，legal comment 保留于 bundle |

### 2.3 `ui/o3dv/o3dv.iife.js`（1.0MB）

| 组件 | 版本 | 许可 |
|---|---|---|
| Online3DViewer（o3dv-src，已打授权补丁） | 0.18.0 | MIT，Copyright (c) 2023 Viktor Kovács |
| three（含 examples 加载器） | 0.176.0 | MIT |
| fflate | 0.8.2 | MIT |
| chevrotain（经 VRMLLoader 间接捆绑） | three 内置副本 | Apache-2.0，Copyright © 2015 SAP SE |

### 2.4 运行资产与运行时 CDN

- `ui/fileviewer/assets/`：docx/xlsx/pptx Worker + jszip.min.js + xlsx 的 THIRD_PARTY_LICENSES.txt，均为 Apache-2.0/MIT 体系。
- **运行时 CDN 加载**（不随包分发，无再分发义务）：`ui/main.js` 预览 Markdown/代码时从 cdnjs 拉取 **marked 12.0.2（MIT）** 与 **highlight.js 11.9.0（BSD-3-Clause）**。不构成许可风险，但离线/内网环境该两项预览会降级为纯文本。
- 图标：`ui/icons.js` 24 个图标的 SVG path 与 **lucide**（ISC）逐字一致。

---

## 三、发现的问题

### P1 — 署名义务缺口（建议发布前补齐）

**1. Go 后端第三方声明缺失。** `.dbxp` 内仅有 `ui/THIRD-PARTY-NOTICES.md`（只覆盖 JS 两个 bundle）与 `ui/licenses/APACHE-2.0.txt`。后果：
- Apache-2.0 §4(d)：minio-go 自带 NOTICE 文件，发行物须保留其内容（"MinIO Cloud Storage, (C) 2014-2020 MinIO, Inc. …"）——**当前缺失**；
- MIT/BSD-3-Clause：须随发行物再现版权与许可声明——Go 侧 15 个模块**全部缺失**。

修复：在 `ui/THIRD-PARTY-NOTICES.md` 增加「Go Sidecar 依赖」章节，列出 §2.1 表格的版权行 + 各许可文本指针，并全文收入 minio-go NOTICE。

**2. OFD 内嵌子库未列入声明。** `@lapo/asn1js` 为 ISC 许可，明文要求"版权声明与许可声明出现在所有副本中"；其版权头被 minify 剥离，bundle 与 notices 均无署名。`dltech/jbig2`、`dltech/ofd`（均 Apache-2.0）同样只以 renderer-ofd 名义笼统出现。这是本次审查中唯一确凿的署名义务缺口。

修复：notices 第一节补三行（组件 / 版本来源 / 许可 / 版权方：Mozilla Foundation、DLTech21、Lapo Luchini）。

### P2 — 建议补强（义务已满足，但署名在 bundle 内，审核不便）

**3. docx-preview 派生署名。** `@file-viewer/docx` 源自 docx-preview（Copyright (c) 2016-2023 Volodymyr Baydalka，Apache-2.0）。bundle 末尾 legal comment 已保留 `@license @file-viewer/docx, derived from docx-preview / Copyright Volodymyr Baydalka`，义务形式上满足；建议 notices 表格中补派生说明，便于商店审核对照。

**4. lucide 图标署名。** 图标 path 与 lucide 逐字一致，`icons.js` 注释仅写"lucide 风格"。lucide 为 ISC，需保留版权声明与许可声明。建议在 notices 中补 lucide（ISC）条目，并把注释改为"取自 lucide"。

### P3 — 文档措辞修正（无风险）

**5. "两个 bundle 均零 CDN 字符串"不准确。** o3dv.iife.js 内残留 2 处 `https://unpkg.com/chevrotain@`（three 的 VRMLLoader → chevrotain 捆绑代码自带的 diagrams 资源默认值，运行时不会请求；jsdelivr 确为零）。建议措辞改为"零 jsdelivr / 零运行时 CDN 请求"。

**6. 专有组件表述不精确。** notices 第五节写"`@file-viewer/renderer-ppt` / `@file-viewer/ppt` 专有"。实测 `renderer-ppt` 的 LICENSE 为 Apache-2.0，专有水印的是其**依赖** `@file-viewer/ppt`（引擎）。排除结论不变，措辞可精确为"renderer-ppt 因传递依赖专有引擎 @file-viewer/ppt 一并排除"。

---

## 四、与既有声明（THIRD-PARTY-NOTICES.md）的符合性核对

| 声明内容 | 核对结果 |
|---|---|
| "仅含 Apache-2.0 / MIT / ISC / Zlib 及双授权宽松项" | ✅ 与 metafile + LICENSE 原文一致（ISC 一项即 lapo-asn1js，但未列名） |
| "明确排除 @flyfish-dev/cad-viewer（AGPL-3.0）" | ✅ 未安装、未捆绑 |
| "明确排除 @file-viewer/ppt（专有水印）" | ✅ 未捆绑（表述见 P3.6） |
| "jszip 选 MIT、dompurify 选 Apache-2.0" | ✅ 成立 |
| "上游 NOTICE/LICENSE 已原样保留在 assets 对应目录" | ✅ xlsx 的 THIRD_PARTY_LICENSES.txt 在包内 |
| "实际捆绑 17 个包" | ⚠️ 顶层 17 包正确，但漏计 renderer-ofd 内 3 个 vendor 子库（P1.2） |
| "两个 bundle 均零 CDN 字符串" | ⚠️ o3dv 残留 2 处 unpkg 默认值（P3.5） |
| Go 后端许可 | ❌ 未覆盖（P1.1） |

---

## 五、修复记录（2026-10-22 已全部落地）

| # | 问题 | 修复 |
|---|---|---|
| P1.1 | Go 后端 15 模块声明缺失、minio-go NOTICE 未随包 | `ui/THIRD-PARTY-NOTICES.md` 新增第八节「Go Sidecar 依赖」：完整模块表 + BSD-3-Clause 全文 + minio-go NOTICE 全文 |
| P1.2 | lapo-asn1js（ISC）零署名；jbig2/ofd 未列名 | 新增 §1.2「renderer-ofd 内嵌子库」：三组件版权行 + asn1js ISC 全文 |
| P2.3 | docx-preview 派生署名仅在 bundle 内 | 新增 §1.1「docx-preview 派生署名」（Baydalka 版权行 + Apache-2.0） |
| P2.4 | lucide 图标无署名 | 新增第七节「UI 图标（lucide，ISC）」：ISC 全文 + Feather（MIT）派生说明；`ui/icons.js` 头注释同步改为"取自 lucide"并指向声明文件 |
| P3.5 | "零 CDN 字符串"表述不准确 | README / notices 均改为"零 jsdelivr / 零运行时 CDN 请求"，并注明 chevrotain unpkg 默认值不参与运行时 |
| P3.6 | renderer-ppt 被误写为专有 | notices 第五节改为：renderer-ppt 自身 Apache-2.0，因传递依赖专有 `@file-viewer/ppt` 一并排除（README 同步） |
| 附 | marked/highlight.js 运行时 CDN 加载未披露 | 新增第九节「运行时 CDN 加载组件」；README 文件预览条目注明离线降级行为 |

变更文件：`ui/THIRD-PARTY-NOTICES.md`（重写，含全部补充章节）、`ui/icons.js`（头注释）、`README.md`（3 处措辞）。
随下一次 `dbx-plugin package` 的 `.dbxp` 自动携带（notices 已在打包清单内）。

---

## 六、复核记录（2026-10-22 第二次审查，针对 v1.0.0 发行包）

复核手段：`vendor/node_modules` 全部 42 个包的 `package.json` license 字段统计、两个 metafile 逐包提取、
bundle 字符串上下文定位（区分「实体代码」与「死路径字符串」）、`.dbxp` 解包逐文件核对、Go `go.mod` 核对。

### 6.1 许可面核验结果（全部通过）

| 核验项 | 结果 |
|---|---|
| node_modules 许可字段统计 | MIT 27 / Apache-2.0 10 / BSD-2-Clause 1 / ISC 1 / 双授权 3（jszip、dompurify、pako）；**零 AGPL / GPL-only / 专有 / 缺字段** |
| @file-viewer/* 九个包 | 8 个 Apache-2.0 + doc（MIT）；各包均带 LICENSE 原文、**无 NOTICE 文件**（与声明一致） |
| MPL/LGPL 解码器是否实体入包 | **否**。o3dv bundle 内 `rhino3dm` / `web-ifc` / `occt` / `draco` 均为 `o3dv/external/...` 路径常量，对应资产未随包 → 运行时 404 优雅失败 |
| fileviewer bundle 内 `MPL-2.0` / `occt` / `wasm` 字符串 | **否**（5 处 MPL-2.0、20 处 occt 全部为 `core` 的资产清单常量，指向未安装的 model/wordperfect/design 渲染器，本子集不触发） |
| chevrotain | 确为实体代码（three 内置 `chevrotain.module.min.js` v9.0.1，Apache-2.0，SAP SE），已在声明中列名并已精确版本号 |
| o3dv-src | 源码目录自带 `O3DV-LICENSE.md`（MIT，Copyright (c) 2023 Viktor Kovacs），补丁后的授权边界成立 |
| `.dbxp` 解包（1.0.0，22 个文件） | 含 `LICENSE`、`ui/THIRD-PARTY-NOTICES.md`、`ui/licenses/APACHE-2.0.txt`、3 个 Worker（`docx/jszip/pptx/xlsx`）、`vendor/xlsx/licenses/THIRD_PARTY_LICENSES.txt`、`bin/windows-x64/backend.exe` —— **署名文件全部随包** |
| Go 侧 | `go.mod` 全部为 MIT / Apache-2.0 / BSD-3-Clause，无 copyleft；声明第八节已覆盖 |

### 6.2 本次新发现（P2 / P3，均非停发级，已修复）

| # | 问题 | 处置 |
|---|---|---|
| N1 (P2) | `styled-exceljs` 实为 **SheetJS Community Edition 源码 fork**（Apache-2.0），bundle 内保留 `xlsx.js (C) 2013-present SheetJS` 版权行，但声明表格未说明派生来源 | `THIRD-PARTY-NOTICES.md` 新增 §1.3 |
| N2 (P2) | `regenerator-runtime`（Facebook, Inc.，MIT）随 dompurify 通道内联进 bundle，legal comment 已保留但声明未列 | 第二节表格补行 |
| N3 (P3) | `@file-viewer/doc` 版权行（msdoc-viewer contributors）未写出；chevrotain 版本号未精确 | 已补版权行与 v9.0.1 |

另注（义务已满足，仅说明）：`sheet.worker.js` / `pptx.worker.js` 内 legal comment 被上游构建剥离，
但 xlsx 目录自带 `THIRD_PARTY_LICENSES.txt`、docx/jszip 保留头部声明、pptx Worker 内容全部来自已列名的
`@file-viewer/pptx`（Apache-2.0），整体署名义务不缺。

---

## 七、商业法律风险（非许可维度）

| 风险项 | 等级 | 现状与建议 |
|---|---|---|
| **第三方商标**（阿里云 / 腾讯云 / 华为云 / AWS / MinIO / Cloudflare / Wasabi / Backblaze B2） | 低 | 现状为兼容性「指示性使用」（下拉选项、README 罗列），不构成暗示背书；插件 id 已从 `com.aliyun.oss.browser` 改为中性的 `com.object.browser`，图标为自绘 SVG（无厂商 logo）。**缺口**：无免责声明 → 已在 README 新增「免责声明」章节；建议 `.dbx-store.json` 的 releaseNotes 同步一句「independent third-party plugin, not affiliated with or endorsed by the listed vendors」 |
| **凭据与数据安全** | 低-中 | Secret 默认不落盘，勾选后**明文**写入本机插件存储（代码注释已标明）。建议在勾选处显式提示「明文保存在本机」；预签名链接（最长 7 天）等于公开对象，建议弹窗提示「任何持有链接者均可访问」——两项均为商店审核常见关注点 |
| **运行时外联** | 低 | 仅 Markdown / 代码预览向 cdnjs 请求 marked(MIT) / highlight.js(BSD-3-Clause)；其余全部本地闭环。**无遥测、无数据上报**（已扫描确认外发域名仅 cdnjs）。企业内网/等保场景属外联行为，已在 README 披露；中长期建议随包内置这两个库（约 100KB，许可无障碍）以彻底闭环 |
| **加密出口管制** | 无 | 仅使用标准 TLS 与 HMAC/SHA（golang.org/x/crypto，公开可得开源代码），无自研加密算法 → 无需 EAR 申报；macOS 公证时的 Apple 出口合规问卷可勾选标准加密豁免 |
| **自许可与组件许可并存** | 无 | 本插件 MIT，内含 Apache-2.0 / MIT / ISC / BSD / Zlib 组件：方向兼容（宽松 → 更宽松），只需保留声明与 NOTICE，已履行。注意 Apache-2.0 §3 专利报复条款：不得就本插件对 Apache-2.0 组件提起专利诉讼（常规商业行为不受影响） |
| **专利明示授权** | 提示 | Apache-2.0 组件含明示专利授权；MIT / BSD / ISC / Zlib 仅隐含，无明示专利授权。行业通行做法，无需动作 |
| **分发平台合规** | 提示（流程） | 当前仅产出 `windows-x64`。发布 macOS 需 Developer ID 签名 + 公证（否则 Gatekeeper 拦截，需 Apple 付费账号）；dbx-store 审核要求签名包。`dist/` 内 45 个历史 `com.aliyun.*` / `com.huangqiang.*` artifact 已被 `.gitignore` 排除，不随发布流转 |

---

## 八、修复落地记录（第二轮复核后，2026-10-22）

| # | 问题 | 修复 |
|---|---|---|
| N1 (P2) | styled-exceljs = SheetJS CE fork 未说明派生来源 | `ui/THIRD-PARTY-NOTICES.md` 新增 §1.3（SheetJS 版权行 + Apache-2.0 同源说明） |
| N2 (P2) | regenerator-runtime（Facebook, MIT）未列入声明 | 第二节表格补行 |
| N3 (P3) | `@file-viewer/doc` 版权行、chevrotain 版本号缺失 | 已补（msdoc-viewer contributors；chevrotain v9.0.1） |
| N4 (商业) | 预签名链接的公开性未向用户提示 | `showCopy()` 新增 hint 参数；单文件 / 批量 / 打开原文件三处预签名结果弹窗显示 `presign.publicHint`（中英双语） |
| N5 (商业) | 商店侧缺商标免责 | `.dbx-store.json` releaseNotes 追加英文免责段落；README 新增「免责声明」章节 |
| N6 (合规) | Markdown / 代码预览运行时外联 cdnjs | marked 12.0.2、highlight.js 11.9.0 及 github 主题 CSS 下载至 `ui/vendor/` **随包分发**；`main.js` 改为「本地优先 → CDN 兜底」（`loadScriptAny` / `loadStyleAny`，3 处 cdnjs URL 仅作兜底常量保留）；notices 第九节改为随包分发并补版权行 |

复核修正：§七表中「Secret 明文落盘提示」一项**本已存在**（`field.rememberSk` 标注"明文存储"、`remember.help` 中英双语说明"明文写入本机、仅建议在个人设备开启"），无需改动。

冒烟验证：`node --check` 通过；`ui/vendor/` 两个库在 vm 中加载成功（marked 解析 `# hi` → `<h1>hi</h1>`；hljs 36 种语言可用）。

> 本报告为许可合规技术审查，不构成法律意见。涉及对外发行拿不准的条款，建议咨询专业法律人士。
