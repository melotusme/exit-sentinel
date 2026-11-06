#!/usr/bin/env bash
# Install or upgrade Exit Sentinel on Linux (tested target: Omarchy / Arch, x86_64).
# Usage: install-linux.sh [vX.Y.Z]   (default: latest release)
# Needs: gh logged in with read access to the private release repo, sha256sum, libfuse2.
set -euo pipefail

REPO='melotusme/exit-sentinel-releases'
ASSET='Exit.Sentinel.linux.x86_64.AppImage'
APP_ID='dev.exit-sentinel.desktop'
LEGACY_APP_ID='local.mhzrm.exit-sentinel'
BIN_DIR="$HOME/.local/bin"
TARGET="$BIN_DIR/exit-sentinel.AppImage"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
SETTINGS="$DATA_HOME/$APP_ID/settings.json"
# Up to 0.5.1 the app used the legacy ID; the app copies that folder on first start.
[ -f "$SETTINGS" ] || SETTINGS="$DATA_HOME/$LEGACY_APP_ID/settings.json"
BACKUPS="$DATA_HOME/exit-sentinel/backups"

fail() { echo "安装失败：$*" >&2; exit 1; }

[ "$(uname -s)" = Linux ] || fail '此脚本仅用于 Linux'
[ "$(uname -m)" = x86_64 ] || fail "当前只提供 x86_64 包，本机为 $(uname -m)"
command -v gh >/dev/null || fail '需要 GitHub CLI：sudo pacman -S github-cli，然后 gh auth login'
command -v sha256sum >/dev/null || fail '缺少 sha256sum（coreutils）'
gh auth status --hostname github.com >/dev/null 2>&1 || fail 'GitHub 尚未登录，请执行 gh auth login'
if ! { ldconfig -p 2>/dev/null | grep -q 'libfuse.so.2'; } && [ ! -e /usr/lib/libfuse.so.2 ]; then
  fail 'AppImage 需要 libfuse2：sudo pacman -S --needed fuse2'
fi

TAG="${1:-}"
if [ -z "$TAG" ]; then
  TAG=$(gh release view --repo "$REPO" --json tagName --jq .tagName) || fail '无法读取最新版本，请确认账号可读取发布仓库'
fi
case "$TAG" in v[0-9]*.[0-9]*.[0-9]*) ;; *) fail "版本号格式无效：$TAG" ;; esac

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
echo "下载 Exit Sentinel $TAG …"
gh release download "$TAG" --repo "$REPO" --pattern "$ASSET" --pattern SHA256SUMS --dir "$WORK" \
  || fail "下载失败；确认 $TAG 包含 Linux 包"
LINE=$(grep -E "^[0-9a-f]{64}  \*?${ASSET//./\\.}\$" "$WORK/SHA256SUMS" || true)
[ "$(printf '%s\n' "$LINE" | grep -c .)" = 1 ] || fail '缺少唯一的安装包校验记录'
(cd "$WORK" && printf '%s\n' "$LINE" | sha256sum --check --status) || fail 'SHA-256 校验失败'
chmod 755 "$WORK/$ASSET"

STAMP=$(date +%Y%m%d-%H%M%S)
mkdir -p "$BACKUPS" "$BIN_DIR"
if [ -f "$TARGET" ]; then cp -p "$TARGET" "$BACKUPS/exit-sentinel-$STAMP.AppImage"; fi
if [ -f "$SETTINGS" ]; then cp -p "$SETTINGS" "$BACKUPS/settings-$STAMP.json"; fi

# Icon for the launcher: the AppImage root holds the app PNG.
ICON_DIR="$DATA_HOME/icons/hicolor/512x512/apps"
(cd "$WORK" && "./$ASSET" --appimage-extract '*.png' >/dev/null 2>&1) || true
ICON=$(find "$WORK/squashfs-root" -maxdepth 1 -name '*.png' -type f 2>/dev/null | head -n1)
if [ -n "$ICON" ]; then mkdir -p "$ICON_DIR" && cp "$ICON" "$ICON_DIR/exit-sentinel.png"; fi

mv -f "$WORK/$ASSET" "$TARGET.new"
mv -f "$TARGET.new" "$TARGET"

mkdir -p "$DATA_HOME/applications"
cat > "$DATA_HOME/applications/exit-sentinel.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Exit Sentinel
Name[zh_CN]=出口哨兵
Comment=国内外出口 IP 与网络变化监控
Exec="$TARGET"
Icon=exit-sentinel
Terminal=false
Categories=Utility;Network;
StartupWMClass=exit-sentinel
EOF
command -v update-desktop-database >/dev/null && update-desktop-database "$DATA_HOME/applications" >/dev/null 2>&1 || true

echo "已安装 $TAG 到 $TARGET"
[ -d "$BACKUPS" ] && echo "旧版应用与设置备份目录：$BACKUPS"
if pgrep -f "$TARGET" >/dev/null 2>&1; then
  echo '旧版仍在运行：从托盘退出后重新打开即可使用新版。'
fi
echo '启动：在启动器搜索 “Exit Sentinel”，或运行：'
echo "  \"$TARGET\" &"
