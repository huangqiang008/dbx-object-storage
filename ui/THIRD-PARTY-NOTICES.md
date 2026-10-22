# 第三方许可声明 / THIRD-PARTY NOTICES

本插件（Object Storage DBX 插件，MIT License，Copyright (c) 2026 huangqiang）集成了以下
开源组件：

- **Office / OFD 预览**：FlyFish file-viewer 安全子集（4 个渲染器，覆盖 Word（doc/docx/rtf/odt）、
  Excel（xls/xlsx/ods/dbf）、PowerPoint（pptx/potx/ppsx 等）、OFD 共 28 个扩展名）；
- **3D 模型预览**：Online3DViewer 安全子集（13 个扩展名：obj/stl/ply/off/3ds/glb/gltf/bim/fbx/dae/wrl/3mf/amf）；
- **Go Sidecar**：`backend.exe` 链入的 Go 模块（对象存储 SDK 与通用库，见第八节）；
- **UI 图标**：`ui/icons.js` 内嵌 SVG 图标 path 取自 lucide（见第七节）。

以下组件按其各自授权随本发行包（.dbxp）一同分发。

集成前已完成授权审查，集成范围遵守以下原则：

1. 仅包含 Apache-2.0 / MIT / ISC / BSD / Zlib 及双授权中的宽松项；
2. **明确排除** `@flyfish-dev/cad-viewer`（AGPL-3.0，具有整包传染性，与 MIT 不兼容）；
3. **明确排除** `@file-viewer/ppt`（"Flyfish Public Watermarked Runtime License"，
   专有运行时且带水印，非开源）；`@file-viewer/renderer-ppt` 自身为 Apache-2.0，
   但因传递依赖上述专有引擎，一并排除；
4. 对双授权组件明确选择宽松项（见"授权选择"一节）；
5. 本文件及 `licenses/APACHE-2.0.txt` 随包分发；上游自带的 NOTICE / LICENSE /
   THIRD_PARTY_LICENSES 文件已原样保留在 `ui/fileviewer/assets/` 对应目录中；
6. PDF 预览不走本子集（沿用插件既有 iframe + blob 路径，不依赖 WASM、CSP 更稳），
   故 `@file-viewer/renderer-pdf` 未打包。

---

## 一、file-viewer 安全子集（Apache-2.0）

以下组件经 esbuild 捆绑为 `ui/fileviewer/viewer.iife.js`（全局名 `FileViewerSDK`，
挂载入口 `mountViewer`）。
Copyright: The FlyFish Viewer Authors。授权全文见 `licenses/APACHE-2.0.txt`。

| 组件 | 版本 | 用途 |
|---|---|---|
| @file-viewer/web | 3.2.2 | 查看器 Web 宿主组件（mountViewer） |
| @file-viewer/core | 3.2.2 | 核心渲染框架与渲染器注册表 |
| @file-viewer/renderer-word | 3.2.2 | Word 渲染器（doc/docx/docm/dot/rtf/odt/odp） |
| @file-viewer/renderer-spreadsheet | 3.2.2 | Excel 渲染器（xls/xlsx/xlsm/xlsb/ods/dbf 等） |
| @file-viewer/renderer-pptx | 3.2.2 | PowerPoint 渲染器（pptx/pptm/potx/ppsx 等） |
| @file-viewer/renderer-ofd | 3.2.2 | OFD 渲染器（ofd） |
| @file-viewer/doc | 3.2.2 | Word 解析引擎（MIT，Copyright (c) 2026 msdoc-viewer contributors） |
| @file-viewer/docx | 0.3.36 | DOCX 解析引擎，派生自 docx-preview（见 §1.1） |
| @file-viewer/pptx | 3.2.2 | PPTX 解析引擎 |

> 已核验：以上各 `@file-viewer/*` 包均不附带 NOTICE 文件；本次集成未修改其源码
> （`@file-viewer/docx` 为上游既有派生，本次集成未再改动）。

### 1.1 docx-preview 派生署名

`@file-viewer/docx` 的渲染引擎派生自
[docx-preview](https://github.com/VolodymyrBaydalka/docxjs)：

> Copyright (c) 2016-2023 Volodymyr Baydalka
> Licensed under the Apache License, Version 2.0

该署名同时以 `@license` 注释形式保留在 `viewer.iife.js` 与
`ui/fileviewer/assets/vendor/docx/docx.worker.js` 内。docx-preview 为 Apache-2.0
（已核验上游 npm 包与 GitHub 仓库），与本发行包授权兼容。

### 1.2 renderer-ofd 内嵌子库

`@file-viewer/renderer-ofd` 捆绑（vendor）了以下第三方代码，随 `viewer.iife.js`
一并分发：

| 组件 | 来源 | 许可 | 版权声明 |
|---|---|---|---|
| jbig2 解码器 | `vendor/dltech/jbig2`（源自 Mozilla pdf.js） | Apache-2.0 | Copyright 2012 Mozilla Foundation |
| ofd.js | [DLTech21/ofd.js](https://github.com/DLTech21/ofd.js) | Apache-2.0 | Copyright (c) 2020. DLTech21 All Rights Reserved. |
| asn1js | [@lapo/asn1js](https://github.com/lapo-luchini/asn1js) v1.2.1 | **ISC** | Copyright (c) 2008-2020 Lapo Luchini |

### 1.3 styled-exceljs 派生自 SheetJS Community Edition

`@file-viewer/renderer-spreadsheet` 依赖的 `styled-exceljs` 是
[SheetJS Community Edition](https://sheetjs.com) 源码的 fork（保留 SheetJS 兼容数据模型，
扩展样式/行列尺寸/图片绘制）。二者同为 Apache-2.0，授权兼容。

> xlsx.js (C) 2013-present SheetJS — http://sheetjs.com
> Licensed under the Apache License, Version 2.0

该版权行以 `@license` 注释形式保留在 `viewer.iife.js` 内；`ui/fileviewer/assets/vendor/xlsx/`
目录另附 `licenses/THIRD_PARTY_LICENSES.txt`（含 styled-exceljs 及其传递依赖的许可全文）。

asn1js 的 ISC 许可全文：

> Permission to use, copy, modify, and/or distribute this software for any
> purpose with or without fee is hereby granted, provided that the above
> copyright notice and this permission notice appear in all copies.
>
> THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
> WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
> MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
> ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
> WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
> ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
> OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

## 二、JavaScript 传递依赖（随 viewer.iife.js 捆绑）

| 组件 | 版本 | 许可 | 版权声明 |
|---|---|---|---|
| dompurify | 3.4.16 | (MPL-2.0 OR Apache-2.0) → 选 Apache-2.0 | —（LICENSE 为未填版权行的标准 Apache-2.0 文本） |
| jszip | 3.10.2 | (MIT OR GPL-3.0-or-later) → 选 MIT | Copyright (c) 2009-2016 Stuart Knightley, David Duponchel, Franz Buchinger, António Afonso |
| pako | 1.0.11 | MIT AND Zlib | Copyright (C) 2014-2017 by Vitaly Puzrin and Andrei Tuputcyn |
| utif | 3.1.0 | MIT | Copyright (c) 2017 Photopea |
| tinycolor2 | 1.6.0 | MIT | Copyright (c), Brian Grinstead, http://briangrinstead.com |
| e-virt-table | 1.4.16 | MIT | Copyright (c) 2024 ewen |
| styled-exceljs | 0.21.6 | Apache-2.0 | — |
| @xmldom/xmldom | 0.9.12 | MIT | Copyright 2019 - present Christopher J. Brody and other contributors; Copyright 2012 - 2017 @jindw and other contributors |
| regenerator-runtime（随 dompurify 分发通道内联） | — | MIT | Copyright (c) 2014-present, Facebook, Inc. |

此外，`@file-viewer/docx` 内嵌 Adobe Symbol Encoding 映射表
（Copyright (c) 1991-2011 Unicode, Inc.，Unicode 使用条款），以 `@license`
注释形式保留在 bundle 内。

MIT 许可文本（适用于上表所有 MIT 组件、@file-viewer/doc，以及第六节的
online-3d-viewer / three / fflate）：

> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in
> all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
> THE SOFTWARE.

## 三、运行时资产（ui/fileviewer/assets/）

预览引擎在运行时按需加载以下本地 Worker（均为同源普通 JS，无 WASM、无外部请求），
各目录自带的许可文件已原样保留：

| 资产文件 | 用途 |
|---|---|
| `vendor/docx/docx.worker.js` | Word/DOCX 解析 Worker |
| `vendor/docx/jszip.min.js` | DOCX Worker 依赖的 jszip（MIT） |
| `vendor/xlsx/sheet.worker.js` | Excel/XLSX 解析 Worker |
| `vendor/xlsx/licenses/THIRD_PARTY_LICENSES.txt` | XLSX 引擎传递依赖许可清单 |
| `vendor/pptx/pptx.worker.js` | PPTX 解析 Worker |
| `flyfish-viewer-assets.json` / `flyfish-viewer-manifest.json` | 资产解析清单 |

OFD 渲染器无独立资产（jszip 已捆绑在 viewer.iife.js 内）。

## 四、授权选择声明（双授权组件）

- **jszip**（MIT OR GPL-3.0-or-later）：本项目选择 **MIT** 条款。
- **dompurify**（MPL-2.0 OR Apache-2.0）：本项目选择 **Apache-2.0** 条款。
- **pako**（MIT AND Zlib）：同时满足两项义务（Zlib 条款要求不得歪曲来源、
  改动需明确标记、保留许可声明——本集成未修改 pako 源码）。

## 五、已排除组件（授权不兼容、专有或超出范围，未集成）

以下组件存在于 file-viewer 上游生态，但经审查**未包含**在本插件中：

| 组件 | 许可 | 排除原因 |
|---|---|---|
| @flyfish-dev/cad-viewer | AGPL-3.0 | 强 Copyleft，会要求整个插件转为 AGPL 开源，与 MIT 冲突 |
| @file-viewer/preset-all / preset-engineering / preset-office | — | 传递依赖上述 AGPL CAD 引擎或专有 ppt 引擎 |
| @file-viewer/ppt | 专有（Flyfish Public Watermarked Runtime License） | 非开源、运行时带水印、禁止修改 |
| @file-viewer/renderer-ppt | Apache-2.0 | 自身为 Apache-2.0，但传递依赖专有 `@file-viewer/ppt` 引擎，一并排除 |
| @file-viewer/renderer-hangul / renderer-iwork / renderer-wordperfect | Apache-2.0 | 授权虽兼容但非目标格式，为减小包体积未集成 |
| @file-viewer/renderer-pdf | Apache-2.0 | 授权兼容，但 PDF 预览沿用插件既有 iframe 路径（不依赖 WASM），未打包 |

## 六、3D 模型预览子集（Online3DViewer，MIT）

3D 预览基于 [Online3DViewer](https://github.com/kovacsv/Online3DViewer) v0.18.0
（Copyright (c) 2023 Viktor Kovács，MIT），经 esbuild 捆绑为 `ui/o3dv/o3dv.iife.js`
（全局名 `OV`）。引擎源码随包内构建做了如下**补丁**（MIT 允许修改，补丁说明已写入源码）：

1. 从导入器注册表摘除 `Importer3dm`（rhino3dm wasm 9MB+）、`ImporterIfc`
   （web-ifc，MPL-2.0）、`ImporterOcct` / `ImporterFcstd`（occt-import-js，
   **LGPL-2.1**）——授权合规优先于格式覆盖；
2. 引擎上游默认在运行时从 cdn.jsdelivr.net 拉取上述解码器，已全部改为包内路径
   （未随包分发 → 优雅失败），**最终 bundle 经 grep 校验零 jsdelivr 字符串、
   零运行时 CDN 请求、零 WASM**（bundle 内残留的 `unpkg.com/chevrotain` 字符串为
   chevrotain 自带的 diagrams 资源默认值，本集成不触发该代码路径）。

捆绑组件及其授权：

| 组件 | 版本 | 许可 | 版权声明 |
|---|---|---|---|
| online-3d-viewer（引擎源码） | 0.18.0 | MIT | Copyright (c) 2023 Viktor Kovács |
| three（含 examples 加载器） | 0.176.0 | MIT | Copyright © 2010-2024 three.js authors |
| fflate | 0.8.2 | MIT | Copyright © 2021 101arrowz |
| chevrotain（经 three 的 VRMLLoader 间接捆绑） | 9.0.1（three 内置副本） | Apache-2.0 | Copyright © 2015 SAP SE or an SAP affiliate company |

支持的扩展名（13 个）：obj / stl / ply / off / 3ds / glb / gltf / bim / fbx / dae / wrl / 3mf / amf。
刻意不支持：3dm / ifc / step / iges / brep / fcstd / dwg（解码器授权见上，扩展名不匹配走优雅失败）。

## 七、UI 图标（lucide，ISC）

`ui/icons.js` 内嵌的 SVG 图标 path 取自 [lucide](https://github.com/lucide-icons/lucide)
图标库：

> ISC License
>
> Copyright (c) 2026 Lucide Icons and Contributors
>
> Permission to use, copy, modify, and/or distribute this software for any
> purpose with or without fee is hereby granted, provided that the above
> copyright notice and this permission notice appear in all copies.
>
> THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
> WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
> MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
> ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
> WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
> ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
> OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

其中 download / link / link-2 / trash / trash-2 等图标源自
[Feather](https://github.com/feathericons/feather)（MIT，Copyright (c) 2013-present
Cole Bemis；源自 Feather 的完整图标清单见 lucide LICENSE 附录），MIT 条款同第二节全文。

## 八、Go Sidecar 依赖（bin/*/backend.exe）

Go 后端静态链接以下模块，按各自授权随二进制分发（`go version -m` 实测链入清单）：

| 模块 | 版本 | 许可 | 版权声明 |
|---|---|---|---|
| github.com/aliyun/aliyun-oss-go-sdk | v3.0.2+incompatible | MIT | Copyright (c) 2015 aliyun.com |
| github.com/minio/minio-go/v7 | v7.0.77 | Apache-2.0（含 NOTICE） | MinIO, Inc.（见下方 NOTICE 全文） |
| github.com/go-ini/ini | v1.67.0 | Apache-2.0 | Copyright 2017 Unknwon |
| github.com/minio/md5-simd | v1.1.2 | Apache-2.0 | MinIO, Inc.（含 Go Authors 代码段，BSD-3-Clause） |
| github.com/google/uuid | v1.6.0 | BSD-3-Clause | Copyright (c) 2009,2014 Google Inc. |
| github.com/klauspost/compress | v1.17.9 | BSD-3-Clause | Copyright (c) 2012 The Go Authors; Copyright (c) 2019 Klaus Post |
| github.com/klauspost/cpuid/v2 | v2.2.8 | MIT | Copyright (c) 2015 Klaus Post |
| github.com/dustin/go-humanize | v1.0.1 | MIT | Copyright (c) 2005-2008 Dustin Sallings |
| github.com/goccy/go-json | v0.10.3 | MIT | Copyright (c) 2020 Masaaki Goshima |
| github.com/rs/xid | v1.6.0 | MIT | Copyright (c) 2015 Olivier Poitrey |
| golang.org/x/crypto | v0.26.0 | BSD-3-Clause | Copyright 2009 The Go Authors |
| golang.org/x/net | v0.28.0 | BSD-3-Clause | Copyright 2009 The Go Authors |
| golang.org/x/sys | v0.24.0 | BSD-3-Clause | Copyright 2009 The Go Authors |
| golang.org/x/text | v0.17.0 | BSD-3-Clause | Copyright 2009 The Go Authors |
| golang.org/x/time | v0.5.0 | BSD-3-Clause | Copyright 2009 The Go Authors |

BSD-3-Clause 许可文本（适用于上表 BSD 组件）：

> Redistribution and use in source and binary forms, with or without
> modification, are permitted provided that the following conditions are met:
>
> 1. Redistributions of source code must retain the above copyright notice,
>    this list of conditions and the following disclaimer.
> 2. Redistributions in binary form must reproduce the above copyright notice,
>    this list of conditions and the following disclaimer in the documentation
>    and/or other materials provided with the distribution.
> 3. Neither the name of the copyright holder nor the names of its
>    contributors may be used to endorse or promote products derived from
>    this software without specific prior written permission.
>
> THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
> AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
> IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
> ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
> LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
> CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
> SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
> INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
> CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
> ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
> POSSIBILITY OF SUCH DAMAGE.

minio-go 附带的 NOTICE 文件全文（Apache-2.0 4(d) 条款要求随发行物保留）：

> MinIO Cloud Storage, (C) 2014-2020 MinIO, Inc.
>
> This product includes software developed at MinIO, Inc.
> (https://min.io/).
>
> The MinIO project contains unmodified/modified subcomponents too with
> separate copyright notices and license terms. Your use of the source
> code for these subcomponents is subject to the terms and conditions
> of Apache License Version 2.0

（测试期依赖 go-spew / go-difflib / check.v1 / yaml.v3 未链入发布二进制，
不产生随包分发义务，故不列入。）

## 九、Markdown / 代码高亮组件（随包分发）

`ui/main.js` 预览 Markdown / 代码文件时按需加载以下库。**自 v1.0.0 起随发行包分发**
（位于 `ui/vendor/`，加载顺序为「本地资产优先 → cdnjs 兜底」），故按各自许可履行署名义务。

| 组件 | 版本 | 许可 | 版权声明 | 包内路径 |
|---|---|---|---|---|
| marked | 12.0.2 | MIT | Copyright (c) 2011-2024, Christopher Jeffrey | `ui/vendor/marked.min.js` |
| highlight.js | 11.9.0 | BSD-3-Clause | Copyright (c) 2006-2023 Ivan Sagalaev and other contributors | `ui/vendor/highlight.min.js` + `ui/vendor/highlight-github.min.css` |

highlight.js 的 BSD-3-Clause 许可全文同第八节（BSD-3-Clause 文本一致）。
两个文件均从 cdnjs 官方分发渠道原样获取、未做任何修改，文件自带的上游版权头完整保留。

> 兜底路径（仅当包内资产缺失时才会请求）：cdnjs.cloudflare.com 上同版本的同名文件。
> 离线/内网环境下若本地资产存在，Markdown / 代码高亮可正常工作；两者均不可用则降级为纯文本。

## 十、Apache-2.0 全文

见 `licenses/APACHE-2.0.txt`（与本文件同目录）。
上游地址：http://www.apache.org/licenses/LICENSE-2.0

---

本声明由安装后的真实依赖树、esbuild 构建元数据与 Go 模块构建信息生成：
- `ui/fileviewer/viewer.iife.js`（file-viewer 安全子集，实际捆绑 17 个顶层包
  及 §1.2 的 3 个 renderer-ofd 内嵌子库）；
- `ui/o3dv/o3dv.iife.js`（Online3DViewer 安全子集，实际捆绑 three + fflate，引擎源码经授权补丁）；
- `bin/*/backend.exe`（Go Sidecar，`go version -m` 链入 15 个模块）。
若升级任一引擎版本、增删渲染器/导入器或 Go 依赖，必须重新生成本文件。
