#!/usr/bin/env bash
# 把打包好的 NSIS 安装包发布到 GitHub Releases。
#
# 用法：
#   1) 先在 https://github.com/settings/tokens 生成一个 Personal Access Token
#      （classic 勾选 repo 权限；fine-grained 勾选 Contents: Read and write）
#   2) export GITHUB_TOKEN=ghp_xxxxxxxx
#   3) bash scripts/release.sh              # 版本号自动从 tauri.conf.json 读取
#      bash scripts/release.sh 0.2.0        # 或手动指定
#      bash scripts/release.sh 0.2.0 --draft
#
# 说明：仓库是 https 远端，token 只用于 API 调用，不会写进 git config。

set -euo pipefail

REPO="GP6142500/LanShare"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONF="$ROOT/src-tauri/tauri.conf.json"

# ---- 参数 ----
VERSION="${1:-}"
DRAFT=""
for a in "$@"; do
  [ "$a" = "--draft" ] && DRAFT="--draft-flag"
done

if [ -z "$VERSION" ] || [ "${VERSION#--}" != "$VERSION" ]; then
  VERSION="$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' "$CONF" | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
fi
TAG="v$VERSION"

if [ -z "${GITHUB_TOKEN:-}" ]; then
  echo "错误：未设置 GITHUB_TOKEN。"
  echo "  请先生成 token： https://github.com/settings/tokens"
  echo "  然后： export GITHUB_TOKEN=ghp_xxx"
  exit 1
fi

SETUP="$ROOT/src-tauri/target/release/bundle/nsis/LanShare_${VERSION}_x64-setup.exe"
if [ ! -f "$SETUP" ]; then
  echo "错误：找不到安装包 $SETUP"
  echo "  请先执行： npx tauri build --bundles nsis"
  exit 1
fi

echo "仓库：   $REPO"
echo "标签：   $TAG"
echo "产物：   $SETUP ($(du -h "$SETUP" | cut -f1))"
echo ""

API="https://api.github.com/repos/$REPO"
H_AUTH="Authorization: Bearer $GITHUB_TOKEN"
H_ACC="Accept: application/vnd.github+json"
H_VER="X-GitHub-Api-Version: 2022-11-28"

# ---- 1. 创建 release（已存在则复用）----
echo "==> 创建/复用 release $TAG"
BODY='{"tag_name":"'"$TAG"'","name":"LanShare '"$TAG"'","generate_release_notes":true'
[ -n "$DRAFT" ] && BODY="$BODY,\"draft\":true"
BODY="$BODY}"

RESP="$(curl -sS -X POST "$API/releases" -H "$H_AUTH" -H "$H_ACC" -H "$H_VER" -d "$BODY")"
RELEASE_ID="$(printf '%s' "$RESP" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)"

if [ -z "$RELEASE_ID" ]; then
  # 多半是「该 tag 已存在」，取出已有 release 的 id
  echo "  创建未成功，尝试查找已存在的 release…"
  RESP="$(curl -sS "$API/releases/tags/$TAG" -H "$H_AUTH" -H "$H_ACC" -H "$H_VER")"
  RELEASE_ID="$(printf '%s' "$RESP" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)"
  if [ -z "$RELEASE_ID" ]; then
    echo "错误：无法创建或找到 release。服务端返回："
    printf '%s\n' "$RESP"
    exit 1
  fi
  echo "  复用已存在的 release id=$RELEASE_ID"
else
  echo "  已创建 release id=$RELEASE_ID"
fi

# ---- 2. 上传安装包 ----
NAME="$(basename "$SETUP")"
echo "==> 上传 $NAME"
UP_URL="https://uploads.github.com/repos/$REPO/releases/$RELEASE_ID/assets?name=$NAME"
curl -sS -X POST "$UP_URL" \
  -H "$H_AUTH" -H "$H_ACC" -H "$H_VER" \
  -H "Content-Type: application/octet-stream" \
  --data-binary "@$SETUP" \
  | grep -o '"browser_download_url":"[^"]*"' | head -1 | sed 's/.*:"//;s/"$//' \
  | { read -r url; echo ""; echo "完成： $url"; }

echo ""
echo "Release 页面： https://github.com/$REPO/releases/tag/$TAG"
