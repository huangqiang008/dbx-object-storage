#!/usr/bin/env bash
# 聚合多平台 .dbxp 元数据到 store-submission/release-candidates.json，供 dbx-store 自动上架。
#
# DBX store 的 sync-release-candidate.mjs 对 release-candidates.json 的硬性要求：
#   - 身份块必须放在 "plugin" 子对象：plugin.id / plugin.publisher / plugin.version / plugin.permissions
#   - 产物数组必须叫 "artifacts"（不是 "targets"）
#   - 每个 artifact 含 target / url / sha256 / size
#
# 关键约束：sha256 / size 必须来自 GitHub Release 上随包发布的 <target>.artifact.json，
# 那是 dbx-plugin package 为该次构建生成的权威元数据。绝不要用本地 dist/ 的 .dbxp 重算——
# 本地 dist 经常和 CI 实际发布的包不一致（本仓库曾因此产生 hash/size 不匹配，导致上架被拒）。
#
# 用法：在 CI 打出 vX.Y.Z Release（含各平台 .dbxp 与 .artifact.json）后，于仓库根目录执行本脚本，
# 再把生成的 store-submission/release-candidates.json 用 `gh release upload vX.Y.Z --clobber` 覆盖上传。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/store-submission/release-candidates.json"
MANIFEST="$ROOT/manifest.json"
REPO="huangqiang008/dbx-object-storage"

# 版本号从 manifest.json 读取（供列出对应 Release 的资产生效）。
VERSION="$(python3 - "$MANIFEST" <<'PY'
import json, sys
print(json.load(open(sys.argv[1]))["version"])
PY
)"

mkdir -p "$(dirname "$OUT")"

# 枚举 Release 上的 *.artifact.json（每个平台一个，CI 生成的权威元数据）。
mapfile -t ARTIFACT_NAMES < <(gh api "repos/$REPO/releases/tags/v$VERSION" --jq '.assets[].name' | grep '\.artifact\.json$')
if [ "${#ARTIFACT_NAMES[@]}" -eq 0 ]; then
  echo "ERROR: v$VERSION 的 Release 上未找到任何 *.artifact.json，请先确认 CI 打包并上传完成。" >&2
  exit 1
fi

python3 - "$OUT" "$MANIFEST" "$REPO" "$VERSION" "${ARTIFACT_NAMES[@]}" <<'PY'
import json, sys, subprocess

out_path, manifest, repo, ver = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
artifact_names = sys.argv[5:]

m = json.load(open(manifest))
pid = m.get("id", "com.object.browser")
pub = "huangqiang"
permissions = m.get("permissions", [])

artifacts = []
for name in artifact_names:
    # name 形如 com.object.browser-1.2.0-darwin-arm64.artifact.json
    meta_url = f"https://github.com/{repo}/releases/download/v{ver}/{name}"
    raw = subprocess.run(["curl", "-sL", meta_url], capture_output=True, text=True, check=True).stdout
    meta = json.loads(raw)
    target = meta["target"]
    sha = meta["sha256"]
    size = meta["size"]
    dbxp = f"{pid}-{ver}-{target}.dbxp"
    dl = f"https://github.com/{repo}/releases/download/v{ver}/{dbxp}"
    artifacts.append({"target": target, "url": dl, "sha256": sha, "size": size})

artifacts.sort(key=lambda a: a["target"])
candidate = {
    "schemaVersion": 1,
    "plugin": {
        "id": pid,
        "publisher": pub,
        "version": ver,
        "permissions": permissions,
    },
    "artifacts": artifacts,
}
with open(out_path, "w") as f:
    json.dump(candidate, f, indent=2)
    f.write("\n")
print(f"==> 已写入 {out_path} (version={ver}, targets={len(artifacts)}: {', '.join(a['target'] for a in artifacts)})")
PY

cat "$OUT"
