# 发布 Runbook

对象存储 DBX 插件（`com.object.browser`）从「代码就绪」到「GitHub Release 上线」的完整可执行步骤。
命令均在本仓库根目录执行，Windows 用 Git Bash。适用版本：v1.0.0 起。

---

## 0. 前提工具

| 工具 | 用途 | 说明 |
|---|---|---|
| `dbx-plugin` | 打包 `.dbxp` | 必须**在目标平台本机**执行；会自动重写 `manifest.json` 的 `entrypoints.backend.executable` 并编译 Go sidecar |
| Go 1.22+ | sidecar 编译 | 由打包器调用，无需手动 build |
| `git` | 提交 / 打 tag | 远端 `origin = https://github.com/huangqiang008/dbx-object-storage.git` |
| `gh` | 创建 Release、上传资产 | 见下 |

### gh CLI 安装与认证（本次踩坑点）

未安装时：

```bash
winget install --id GitHub.cli -e --accept-source-agreements --accept-package-agreements
```

安装后可执行文件在 `C:\Program Files\GitHub CLI\gh.exe`，Git Bash 中先补 PATH：

```bash
export PATH="$PATH:/c/Program Files/GitHub CLI"
gh --version
```

认证：**不要走 `gh auth login --web`**——在带代理的环境会失败（`login/device/code` 返回 502，或 `oauth/access_token` unexpected EOF）。
改用 Windows 凭据管理器里已有的 git 凭据（就是 `git push` 用的那个）：

```bash
# 取本机已保存的 git 凭据作为 GH_TOKEN（不会显示明文），验证是否可用
GH_TOKEN=$(printf "protocol=https\nhost=github.com\n\n" | git credential fill | sed -n 's/^password=//p') \
  gh api user --jq .login
# 输出 huangqiang008 即通过
```

> `gh auth login --with-token` 会因缺少 `read:org` scope 拒绝该令牌，属正常现象；直接用 `GH_TOKEN=$(...)` 环境变量调用 `gh` 即可，gh 不会再做 scope 校验。

后续所有 `gh` 命令都加同一前缀。为少打字可先定义函数：

```bash
ghp() { GH_TOKEN=$(printf "protocol=https\nhost=github.com\n\n" | git credential fill | sed -n 's/^password=//p') gh "$@"; }
```

---

## 1. 同步版本号（四处）

漏改会让状态栏显示旧版本，反而干扰排查。

| 位置 | 字段 |
|---|---|
| `manifest.json` | `version` |
| `backend/oss.go` | `const pluginVersion` |
| `ui/main.js` | `const BUILD` |
| `README.md` | 顶部版本徽章 |

```bash
grep -n '"version"' manifest.json
grep -n 'const pluginVersion' backend/oss.go
grep -n 'const BUILD' ui/main.js
grep -n 'shields.io/badge/version' README.md
```

---

## 2. 重新打包（逐平台本机）

```bash
dbx-plugin package .
```

产出：

- `dist/com.object.browser-<ver>-windows-x64.dbxp`
- `dist/com.object.browser-<ver>-windows-x64.artifact.json`（target / url / sha256 / size）
- 终端提示 `Signature: unsigned review candidate` 属正常，dbx-store 侧由维护者审核签名

打包范围由 `dbx-plugin.toml` 决定：`include = ["assets", "ui", "LICENSE"]`。
新增随包资产只要放在 `ui/` 下即自动入包，无需改配置（例如 `ui/vendor/`）。

macOS 目标：先 `bash scripts/sign-macos.sh`（Developer ID 签名 + 公证），再 `dbx-plugin package`。
`darwin-arm64` 至少要有 Go 的 ad-hoc 签名，否则 Gatekeeper 拦截。

---

## 3. 聚合校验值

```bash
bash scripts/release.sh
```

扫描 `dist/` 下当前版本的全部 `.dbxp`，把 sha256 / size 写入 `store-submission/release-candidates.json` 的 `targets`（版本从 `manifest.json` 读取）。多平台打完后重跑一次即可聚合全部 target。

---

## 4. 提交、打 tag、推送

**提交前先查忽略命中**（踩过坑）：

```bash
git check-ignore -v ui/vendor/marked.min.js ui/fileviewer/viewer.iife.js ui/o3dv/o3dv.iife.js scripts/release.sh
```

四个都必须输出 `TRACKABLE`。`.gitignore` 中写 `vendor/`（无前导斜杠）会匹配任意层级，曾把 `ui/vendor/`（随包 marked / highlight.js）静默排除；现在已写为 `/vendor/`，只忽略根目录构建目录。

```bash
git add <改动文件>                       # 不要 git add -A：ui.pen（设计稿）与 backend/*.exe 不入库
git commit -F - <<'EOF'
feat: ...（中文说明要点）
EOF

git tag -a v1.0.0 -m "v1.0.0: <一句话摘要>"
git push origin main
git push origin v1.0.0
git ls-remote --tags origin | tail -3     # 确认 tag 已上远端
```

---

## 5. 创建 GitHub Release

```bash
export PATH="$PATH:/c/Program Files/GitHub CLI"

GH_TOKEN=$(printf "protocol=https\nhost=github.com\n\n" | git credential fill | sed -n 's/^password=//p') \
gh release create v1.0.0 --title "v1.0.0" --notes-file - \
  "dist/com.object.browser-1.0.0-windows-x64.dbxp" \
  "dist/com.object.browser-1.0.0-windows-x64.artifact.json" \
  "store-submission/release-candidates.json" <<'EOF'
## Object Storage v1.0.0

（Release notes 结构见文末模板）
EOF
```

补充资产（例如后补 macOS 包）用 `upload`，不要重建 Release：

```bash
GH_TOKEN=$(...) gh release upload v1.0.0 dist/com.object.browser-1.0.0-darwin-arm64.dbxp
```

复核：

```bash
GH_TOKEN=$(...) gh release view v1.0.0
```

### Release notes 模板

```markdown
## Object Storage vX.Y.Z

一句话定位：通用对象存储浏览器，同时支持阿里云 OSS 原生与 S3 兼容协议。

### 本版本新增
- **功能点**（一条一行，写清覆盖范围与约束，如支持的扩展名数量、不支持的格式）

### 安装
下载对应平台的 `.dbxp`；注明本版本包含哪些 target，缺失平台说明需在本机打包后补发。
手动安装：从本 Release 下载 `com.object.browser-vX.Y.Z-<target>.dbxp`。

校验：sha256 `<值>`，`<size>` 字节（另见 `release-candidates.json`）。

### 许可与合规
- 插件本体：MIT
- 第三方组件：随包分发 `ui/THIRD-PARTY-NOTICES.md`
- 审查报告：仓库根目录 `LICENSE-AUDIT.md`

**免责声明**：本插件为独立第三方开发，与文中提及的各存储服务厂商无隶属、代理、赞助或背书关系；相关商标归各自权利人所有。
```

---

## 6. 发布后自检

包内容核对（`.dbxp` 是 zip）：

```bash
python - <<'PY'
import zipfile, os
p = "dist/com.object.browser-1.0.0-windows-x64.dbxp"
z = zipfile.ZipFile(p)
print("size", os.path.getsize(p))
for i in z.infolist():
    print(" ", i.file_size, i.filename)
PY
```

必须包含：`LICENSE`、`ui/THIRD-PARTY-NOTICES.md`、`ui/licenses/APACHE-2.0.txt`、两个预览 bundle、`ui/fileviewer/assets/**` 的 Worker、`ui/vendor/*`、`bin/<target>/backend.exe`。

一致性核对：

```bash
grep -o '"sha256": "[^"]*"' dist/com.object.browser-1.0.0-windows-x64.artifact.json
grep -o '"sha256": "[^"]*"' store-submission/release-candidates.json
sha256sum dist/com.object.browser-1.0.0-windows-x64.dbxp    # 三者必须一致
```

宿主实测清单：连接建立、目录分页、上传/下载、Office / OFD 预览、3D 预览、Markdown / 代码预览（确认走包内 `ui/vendor/` 而非 CDN）。

---

## 7. 商店同步

Release 发布后，`dbx-store` 的同步 Workflow 读取 Release 中的 `release-candidates.json` 自动创建候选 PR → 维护者审核签名 → 进入官方目录。
`store-submission/` 被 `.gitignore` 排除，只通过 Release 资产流转，不进仓库。

---

## 8. 已知坑

1. **`vendor/` 忽略规则**：无前导斜杠会匹配 `ui/vendor/`，导致随包资产不入库。已改为 `/vendor/`。
2. **不能在单一平台打全平台包**：原生 sidecar 必须逐平台本机 `dbx-plugin package`，无 universal 包。
3. **未签名是候选包**：`unsigned review candidate` 属正常，正式分发需签名（macOS 需 Developer ID + 公证）。
4. **gh 网页登录在代理环境不可用**：改用 `git credential fill` 取本机凭据（见 §0）。
5. **`ui.pen` 不入库**：设计稿文件（约 792KB），提交时不要 `git add -A`。
6. **改 `ui/` 下任何文件都要重新打包**：`dist/` 里的 `.dbxp` 是构建产物，不会自动同步源码改动。
