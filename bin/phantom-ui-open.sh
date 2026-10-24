#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Phantom como app de escritorio (bin/phantom-a-escritorio.sh): nunca arrancar
# además codeg-server, comparten la carpeta de datos.
if [[ "$(cat "$HOME/.config/phantom/modo" 2>/dev/null)" == escritorio ]]; then
  if ! systemctl --user is-active -q phantom-desktop.service; then
    systemctl --user start phantom-desktop.service
    [[ $# -eq 0 ]] && exit 0
    sleep 5
  fi
  # Ya corre: un segundo lanzamiento le pasa la ventana (o el enlace codeg://) a la
  # instancia viva y sale. Mismo entorno que el servicio, por si acaso.
  set -a; . "$HOME/.config/codeg/server.env"; set +a
  exec "$HOME/.local/lib/phantom-desktop/codeg" "$@"
fi
exec "$ROOT/bin/open-codeg.sh"
