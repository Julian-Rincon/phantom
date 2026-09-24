#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/codeg/src-tauri"
DEST_BIN="${CODEG_BIN_DIR:-$HOME/.local/bin}"
STAMP=$(date +%Y%m%d-%H%M%S)

export PATH="$HOME/.cargo/bin:$PATH"
cd "$SRC"

cargo build --release --no-default-features --bin codeg-server --bin codeg-mcp

# First install (or an updated unit in the repo): put the user unit in place
# before stopping it, so `systemctl stop` has something to act on.
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
if ! cmp -s "$ROOT/integrations/systemd/codeg.service" "$UNIT_DIR/codeg.service"; then
  install -d -m 755 "$UNIT_DIR"
  install -m 644 "$ROOT/integrations/systemd/codeg.service" "$UNIT_DIR/codeg.service"
  systemctl --user daemon-reload
  systemctl --user enable codeg.service
fi

systemctl --user stop codeg.service
restore_service=1
cleanup() {
  if [[ "$restore_service" == 1 ]]; then
    systemctl --user start codeg.service >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

for name in codeg-server codeg-mcp; do
  test -x "$SRC/target/release/$name"
  if test -e "$DEST_BIN/$name"; then
    cp -p "$DEST_BIN/$name" "$DEST_BIN/$name.backup-$STAMP"
  fi
  install -m 0755 "$SRC/target/release/$name" "$DEST_BIN/$name"
done

systemctl --user start codeg.service
restore_service=0
trap - EXIT
printf 'LOCAL_BUILD_INSTALLED version=%s backup_suffix=%s\n' \
  "$($DEST_BIN/codeg-server --version)" "$STAMP"
