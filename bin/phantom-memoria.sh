#!/usr/bin/env bash
# Reinicia Phantom de madrugada solo si su webview se infló y no hay nadie trabajando.
# El WebKitWebProcess de la ventana crece sin parar (4.9 GB tras 11 h el 2026-11-12) y el
# PC termina en swap; las sesiones de agente casi no pesan. Nunca reinicia con un agente
# activo: phantom-ocupado.py tiene que decir "inactivo" 3 veces seguidas, 1 min entre cada una.
set -uo pipefail
LIMITE_MB=${PHANTOM_WEBKIT_MAX_MB:-3000}
BIN="$(cd "$(dirname "$0")" && pwd)"
log() { echo "phantom-memoria: $*"; }

cg=$(systemctl --user show -p ControlGroup --value phantom-desktop.service)
[[ -n "$cg" && -d "/sys/fs/cgroup$cg" ]] || { log "Phantom no está corriendo"; exit 0; }
mb=0
for pid in $(find "/sys/fs/cgroup$cg" -name cgroup.procs -exec cat {} + 2>/dev/null); do
  if [[ "$(ps -o comm= -p "$pid" 2>/dev/null)" == WebKitWebProces* ]]; then
    r=$(ps -o rss= -p "$pid" 2>/dev/null || echo 0); (( r / 1024 > mb )) && mb=$(( r / 1024 ))
  fi
done
if (( mb < LIMITE_MB )); then log "webview en ${mb} MB (< ${LIMITE_MB}): nada que hacer"; exit 0; fi
for i in 1 2 3; do
  if ! motivo=$("$BIN/phantom-ocupado.py"); then log "webview en ${mb} MB pero ocupado ($motivo): no se toca"; exit 0; fi
  (( i < 3 )) && sleep 60
done
log "webview en ${mb} MB y Phantom inactivo 3/3: reinicio"
systemctl --user restart phantom-desktop.service
