#!/usr/bin/env bash
# 后备工具：手动将 manifest.json 的 backend executable 指向指定平台路径。
#
# 正常情况下 `dbx-plugin package` 会按本机平台自动重写 executable，无需手动调用本脚本。
# 仅在以下情况使用：你用的打包器版本不自动重写，或想本地 dev 强制指定某平台二进制。
#
# 用法:
#   bash scripts/set-target.sh <target>
#   target ∈ windows-x64 | darwin-arm64 | darwin-x64 | linux-x64 | linux-arm64
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="$ROOT/manifest.json"
TARGET="${1:?usage: set-target.sh <windows-x64|darwin-arm64|darwin-x64|linux-x64|linux-arm64>}"

case "$TARGET" in
  windows-*) ext=".exe" ;;
  *) ext="" ;;
esac
BIN="bin/$TARGET/backend$ext"

node -e '
  const fs = require("fs");
  const manifest = process.argv[1];
  const bin = process.argv[2];
  const d = JSON.parse(fs.readFileSync(manifest, "utf8"));
  d.entrypoints.backend.executable = bin;
  fs.writeFileSync(manifest, JSON.stringify(d, null, 2) + "\n");
  console.log("set executable -> " + bin);
' "$MANIFEST" "$BIN"
