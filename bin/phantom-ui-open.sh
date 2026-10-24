#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Phantom como app de escritorio (bin/phantom-a-escritorio.sh): nunca arrancar
# además codeg-server, comparten la carpeta de datos.
if [[ "$(cat "$HOME/.config/phantom/modo" 2>/dev/null)" == escritorio ]]; then
  exec systemctl --user start phantom-desktop.service
fi
exec "$ROOT/bin/open-codeg.sh"
