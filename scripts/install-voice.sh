#!/usr/bin/env bash
# Idempotent installer for phantom-voice: local, loopback-only STT/TTS
# service. Creates/updates the dedicated venv, verifies the kokoro model
# files (reused from brag, never duplicated), installs the systemd user
# unit, and enables+starts it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VOICE_DIR="$ROOT/voice"
VENV="$HOME/.local/share/phantom/voice-venv"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
MODELS_DIR="$HOME/.local/share/brag/models"
KOKORO_ONNX="$MODELS_DIR/kokoro-v1.0.onnx"
KOKORO_VOICES="$MODELS_DIR/voices-v1.0.bin"

printf 'phantom-voice installer\n'

# --- Python venv --------------------------------------------------------
PYBIN="python3.12"
if ! command -v "$PYBIN" >/dev/null 2>&1; then
  echo "  python3.12 not found on PATH, falling back to system python3"
  PYBIN="python3"
fi

if [[ ! -x "$VENV/bin/python" ]]; then
  echo "  creating venv at $VENV ($PYBIN)"
  mkdir -p "$(dirname "$VENV")"
  "$PYBIN" -m venv "$VENV"
else
  echo "  venv already exists at $VENV, reusing"
fi

echo "  installing/updating requirements"
"$VENV/bin/pip" install --upgrade pip --quiet
"$VENV/bin/pip" install -r "$VOICE_DIR/requirements.txt" --quiet

# --- kokoro model files ---------------------------------------------------
# These ~300 MB files already live under brag's model dir; phantom-voice
# reads them directly (PHANTOM_VOICE_MODELS_DIR), no copy or symlink needed.
if [[ ! -f "$KOKORO_ONNX" || ! -f "$KOKORO_VOICES" ]]; then
  cat >&2 <<EOF
  MISSING kokoro model files:
    $KOKORO_ONNX
    $KOKORO_VOICES
  Download them (same files brag's TTS uses) with, e.g.:
    mkdir -p "$MODELS_DIR"
    curl -L -o "$KOKORO_ONNX"  https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx
    curl -L -o "$KOKORO_VOICES" https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin
  Then re-run this script.
EOF
  exit 1
else
  echo "  kokoro model files present ($MODELS_DIR)"
fi

# --- executable bits (scripts committed without +x has bitten this repo before) ---
chmod +x "$VOICE_DIR/run-phantom-voice.sh" "$ROOT/scripts/install-voice.sh"

# --- systemd user unit ---------------------------------------------------
install -d -m 700 "$UNIT_DIR"
install -m 644 "$ROOT/integrations/systemd/phantom-voice.service" "$UNIT_DIR/phantom-voice.service"
systemctl --user daemon-reload
systemctl --user enable --now phantom-voice.service

printf 'phantom-voice installed and started\n'
printf '  venv:     %s\n' "$VENV"
printf '  unit:     %s\n' "$UNIT_DIR/phantom-voice.service"
printf '  models:   %s (reused, not duplicated)\n' "$MODELS_DIR"
printf '  endpoint: http://127.0.0.1:%s (health: /health)\n' "${PHANTOM_VOICE_PORT:-3091}"
printf '  status:   systemctl --user status phantom-voice\n'
printf '  logs:     journalctl --user -u phantom-voice -f\n'
