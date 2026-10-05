#!/usr/bin/env bash
# Launcher used by the phantom-voice-chatterbox systemd unit (and manual runs).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="${PHANTOM_CHATTERBOX_VENV:-$HOME/.local/share/brag/chatterbox}"
PY="$VENV/bin/python"

if [[ ! -x "$PY" ]]; then
  echo "phantom-chatterbox: venv not found at $VENV" >&2
  exit 1
fi

cd "$ROOT"
exec "$PY" -m uvicorn chatterbox_server:app --host 127.0.0.1 --port "${PHANTOM_CHATTERBOX_PORT:-3092}" --app-dir "$ROOT"
