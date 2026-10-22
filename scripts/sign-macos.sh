#!/usr/bin/env bash
# 对 macOS 后端二进制做 Developer ID 签名 + 公证（可选，仅 macOS 运行）。
#
# 为什么需要：
#   - darwin-arm64（Apple Silicon）上 macOS 拒绝执行未签名的 arm64 代码，直接起不来。
#     Go 链接器会自动施加 ad-hoc 签名，所以本机/插件中心安装默认可用；
#     但若通过"浏览器下载 .dbxp 再安装"的路径可能引入 quarantine，或要做正式分发，
#     建议用 Developer ID 签名并公证，消除 Gatekeeper 拦截。
#   - darwin-x64（Intel）接受未签名 x86_64，一般无需签名。
#
# 用法（在 Mac 上，且 backend 二进制已由 `dbx-plugin package` 编译到 bin/<target>/ 后，
#       或手动编译后）：
#   export APPLE_SIGN_IDENTITY="Developer ID Application: Huang Qiang (TEAMID123)"
#   export APPLE_ID="you@example.com"
#   export APPLE_TEAM_ID="TEAMID123"
#   export APPLE_APP_PASSWORD="abcd-efgh-ijkl-mnop"   # App 专用密码
#   # 或者改用 API Key 方式：
#   # export APPLE_API_KEY="$HOME/AuthKey_XXXXXXXXXX.p8"
#   # export APPLE_API_KEY_ID="XXXXXXXXXX"
#   # export APPLE_API_ISSUER="<issuer-uuid>"
#   bash scripts/sign-macos.sh
#
# 随后在本机执行 `dbx-plugin package .`，已签名的二进制会被打进 .dbxp。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/bin"

: "${APPLE_SIGN_IDENTITY:=}"

if [ -z "$APPLE_SIGN_IDENTITY" ]; then
  echo "SKIP: 未设置 APPLE_SIGN_IDENTITY，跳过 macOS 签名。"
  echo "  说明: darwin-arm64 至少需 Go 的 ad-hoc 签名（DBX 自解包可启动 sidecar）；"
  echo "        正式分发 / 浏览器下载安装路径建议做 Developer ID 签名 + 公证。"
  exit 0
fi

for target in darwin-arm64 darwin-x64; do
  bin="$BIN/$target/backend"
  [ -f "$bin" ] || { echo "SKIP: $bin 不存在（请先在本机 package 或编译）"; continue; }
  echo "==> codesign $bin"
  codesign --force --options runtime --timestamp --sign "$APPLE_SIGN_IDENTITY" "$bin"

  if [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ] && [ -n "${APPLE_APP_PASSWORD:-}" ]; then
    echo "==> notarize (Apple ID) $bin"
    xcrun notarytool submit "$bin" \
      --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" \
      --password "$APPLE_APP_PASSWORD" --wait
    xcrun stapler staple "$bin" || true
  elif [ -n "${APPLE_API_KEY:-}" ] && [ -n "${APPLE_API_KEY_ID:-}" ] && [ -n "${APPLE_API_ISSUER:-}" ]; then
    echo "==> notarize (API key) $bin"
    xcrun notarytool submit "$bin" \
      --key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" \
      --issuer "$APPLE_API_ISSUER" --wait
    xcrun stapler staple "$bin" || true
  else
    echo "WARN: 已签名但未公证（缺少 APPLE_ID/APPLE_APP_PASSWORD 或 APPLE_API_KEY*）"
  fi
done

echo "==> macOS 签名完成。随后在本机执行: dbx-plugin package ."
