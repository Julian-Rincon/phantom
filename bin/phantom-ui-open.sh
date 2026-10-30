#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Phantom como app de escritorio (bin/phantom-a-escritorio.sh): nunca arrancar
# además codeg-server, comparten la carpeta de datos.
if [[ "$(cat "$HOME/.config/phantom/modo" 2>/dev/null)" == escritorio ]]; then
  if ! systemctl --user is-active -q phantom-desktop.service; then
    systemctl --user start phantom-desktop.service
    [[ $# -eq 0 ]] && exit 0
  fi
  # El servicio puede estar activo sin haber tomado aún el candado de instancia única
  # (al iniciar sesión arrancan juntos): lanzar ahora dejaría a este proceso como
  # instancia principal, fuera del servicio y sin su entorno. Esperar a la web.
  for _ in $(seq 1 30); do
    curl -s -o /dev/null http://127.0.0.1:3080/ && break
    sleep 1
  done
  curl -s -o /dev/null http://127.0.0.1:3080/ || exit 1
  # Ya corre: un segundo lanzamiento le pasa la ventana (o el enlace codeg://) a la
  # instancia viva y sale. Mismo entorno que el servicio, por si acaso.
  set -a; . "$HOME/.config/codeg/server.env"; set +a
  exec "$HOME/.local/lib/phantom-desktop/codeg" "$@"
fi
exec "$ROOT/bin/open-codeg.sh"
