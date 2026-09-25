#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CODEG_ROOT="$ROOT/codeg"
STATIC_DIR="${CODEG_STATIC_DIR:-$HOME/.local/share/codeg/web}"
BACKUP="$STATIC_DIR.backup-$(date +%Y%m%d-%H%M%S)"

cd "$CODEG_ROOT"
pnpm build

if [[ -e "$STATIC_DIR" ]]; then
  cp -a "$STATIC_DIR" "$BACKUP"
fi
mkdir -p "$STATIC_DIR"
rsync -a --delete "$CODEG_ROOT/out/" "$STATIC_DIR/"

# Keep the web/runtime icon in sync with the build. The Plasma launcher is
# owned by install-plasma-integration.sh (it templates the checkout path).
install -m 644 "$CODEG_ROOT/public/phantom-emblem-256.png" "$STATIC_DIR/phantom-emblem-256.png"

printf 'PHANTOM_UI_WEB_INSTALLED static=%s backup=%s\n' "$STATIC_DIR" "${BACKUP:-none}"
