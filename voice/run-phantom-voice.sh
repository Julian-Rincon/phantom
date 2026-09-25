#!/usr/bin/env bash
# Launcher used by the phantom-voice systemd unit (and for manual runs).
# faster-whisper's ctranslate2 backend does not auto-discover the pip-installed
# nvidia-cublas-cu12/nvidia-cudnn-cu12 wheels the way torch does, so we point
# LD_LIBRARY_PATH at them explicitly before starting uvicorn.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="${PHANTOM_VOICE_VENV:-$HOME/.local/share/phantom/voice-venv}"
PY="$VENV/bin/python"

if [[ ! -x "$PY" ]]; then
  echo "phantom-voice: venv not found at $VENV (run scripts/install-voice.sh)" >&2
  exit 1
fi

SITE_PACKAGES="$("$PY" -c 'import sysconfig; print(sysconfig.get_paths()["purelib"])')"
CUDA_LIB_DIRS="$SITE_PACKAGES/nvidia/cublas/lib:$SITE_PACKAGES/nvidia/cudnn/lib"
export LD_LIBRARY_PATH="$CUDA_LIB_DIRS${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

cd "$ROOT"
exec "$PY" -m uvicorn phantom_voice:app --host 127.0.0.1 --port "${PHANTOM_VOICE_PORT:-3091}"
