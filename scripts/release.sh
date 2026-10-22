#!/usr/bin/env bash
# 聚合多平台 .dbxp 到 store-submission/release-candidates.json 的 targets 数组。
#
# DBX 的约束：带原生 sidecar 的插件不能用 universal 单包，必须逐平台本机打包。
# 因此发布流程是：在每台目标机（Windows / macOS arm64 / macOS x64 / Linux）上
#   分别执行 `dbx-plugin package .` 产出 dist/<id>-<version>-<target>.dbxp，
# 然后在本脚本所在仓库根目录执行本脚本，自动扫描 dist/ 下"当前版本"的所有包，
# 计算 sha256 与 size 并写入 release-candidates.json（供 dbx-store 聚合发布）。
#
# target 命名（DBX 约定）：windows-x64 / darwin-arm64 / darwin-x64 / linux-x64 / linux-arm64
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dist"
OUT="$ROOT/store-submission/release-candidates.json"
MANIFEST="$ROOT/manifest.json"

ID="com.object.browser"
PUBLISHER="huangqiang"
REPO="huangqiang008/dbx-object-storage"

VERSION="$(grep -m1 '"version"' "$MANIFEST" | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')"

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}
size_of() {
  wc -c < "$1" | tr -d ' '
}

mkdir -p "$(dirname "$OUT")"
TMP="$(mktemp)"
{
  echo "{"
  echo "  \"schemaVersion\": 1,"
  echo "  \"id\": \"$ID\","
  echo "  \"publisher\": \"$PUBLISHER\","
  echo "  \"version\": \"$VERSION\","
  echo "  \"targets\": ["
} > "$TMP"

# 先收集全部包再写：多平台时每个条目末尾需要逗号（最后一个不需要）。
# 早先的写法是「写下一个条目前补一行 }」，会在多平台时产出重复的 } 导致 JSON 非法，
# 单平台时恰好不暴露——所以必须先数出总数再决定每个条目的结尾。
pkgs=()
for f in "$DIST"/${ID}-${VERSION}-*.dbxp; do
  [ -e "$f" ] || continue
  pkgs+=("$f")
done
total=${#pkgs[@]}
idx=0
for f in "${pkgs[@]}"; do
  idx=$((idx + 1))
  fname="$(basename "$f")"
  target="${fname#"$ID-$VERSION-"}"
  target="${target%.dbxp}"
  sha="$(sha256_of "$f")"
  sz="$(size_of "$f")"
  url="https://github.com/$REPO/releases/download/v$VERSION/$fname"
  {
    echo "    {"
    echo "      \"target\": \"$target\","
    echo "      \"url\": \"$url\","
    echo "      \"sha256\": \"$sha\","
    echo "      \"size\": $sz"
    if [ "$idx" -lt "$total" ]; then echo "    },"; else echo "    }"; fi
  } >> "$TMP"
done
echo "  ]" >> "$TMP"
echo "}" >> "$TMP"

mv "$TMP" "$OUT"
echo "==> 已写入 $OUT (version=$VERSION)"
cat "$OUT"
