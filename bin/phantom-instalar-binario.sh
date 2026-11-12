#!/usr/bin/env bash
# Instala un binario nuevo del escritorio de Phantom y reinicia el servicio.
# Corre fuera de Phantom (systemd-run): reiniciar el servicio corta las sesiones
# que viven en él, incluida la que lanzó este script.
#
#   bin/phantom-instalar-binario.sh <ruta-al-codeg-nuevo>
#
# Respalda la base y el binario actual; si Phantom no responde en :3080 tras el
# reinicio, vuelve al binario anterior y avisa.
set -uo pipefail
NEW="${1:?falta la ruta del binario nuevo}"
L="$HOME/.cache/phantom-instalar-binario.log"
exec >>"$L" 2>&1
DATA="$HOME/.local/share/codeg"
DEST="$HOME/.local/lib/phantom-desktop/codeg"
NEXUS="$HOME/Documentos/Proyectos/nexus/.venv/bin/nexus"
TS=$(date +%Y%m%d-%H%M%S)

log() { echo "$(date '+%F %T') $*"; }
avisa() { log "aviso: $1"; "$NEXUS" notify "$1" >/dev/null 2>&1 || true; }
responde() {
  for _ in $(seq 1 45); do
    curl -s -o /dev/null http://127.0.0.1:3080/ && return 0
    sleep 2
  done
  return 1
}

# Responder en 3080 no basta: tiene que ser el servicio, corriendo el binario instalado.
es_el_nuevo() {
  local pid
  pid=$(systemctl --user show -p MainPID --value phantom-desktop.service)
  [[ "$pid" -gt 0 && "$(readlink "/proc/$pid/exe")" == "$DEST" ]] && cmp -s "$NEW" "$DEST"
}

log "== instalación de $NEW"
[[ -x "$NEW" ]] || { avisa "⚠️ Phantom: el binario nuevo no existe; nada cambió."; exit 1; }

R="$HOME/.local/share/codeg-respaldos/$TS"
mkdir -p "$R" && chmod 700 "$HOME/.local/share/codeg-respaldos" "$R"
if ! sqlite3 "$DATA/codeg.db" ".backup '$R/codeg.db'"; then
  avisa "⚠️ Phantom: no pude respaldar la base; nada cambió."; exit 1
fi
cp -p "$DEST" "$DEST.backup-$TS"
log "respaldo de base en $R, binario en $DEST.backup-$TS"

install -m 0755 "$NEW" "$DEST.tmp" && mv -f "$DEST.tmp" "$DEST"

# Los binarios auxiliares salen de la misma compilación que el principal.
DIR_NEW=$(dirname "$NEW")
for aux in codeg-mcp codeg-cli codeg-computer-helper codeg-server; do
  [[ -x "$DIR_NEW/$aux" ]] || continue
  cp -p "$HOME/.local/bin/$aux" "$HOME/.local/bin/$aux.backup-$TS" 2>/dev/null || true
  install -m 0755 "$DIR_NEW/$aux" "$HOME/.local/bin/$aux.tmp" && mv -f "$HOME/.local/bin/$aux.tmp" "$HOME/.local/bin/$aux"
done

# La web de 3080 (y Tailscale) se sirve desde CODEG_STATIC_DIR, no del binario: sin esto
# queda un frontend viejo contra un backend nuevo (eventos que se ven como texto plano).
OUT_NEW=$(cd "$DIR_NEW/../../.." 2>/dev/null && pwd)/out
WEB="$DATA/web"
if [[ -f "$OUT_NEW/index.html" ]]; then
  [[ -d "$WEB" ]] && cp -a "$WEB" "$WEB.backup-$TS"
  mkdir -p "$WEB" && rsync -a --delete "$OUT_NEW/" "$WEB/"
  [[ -f "$OUT_NEW/../public/phantom-emblem-256.png" ]] && install -m 644 "$OUT_NEW/../public/phantom-emblem-256.png" "$WEB/"
  ls -1d "$WEB".backup-* 2>/dev/null | head -n -3 | xargs -r rm -rf
  log "web actualizada desde $OUT_NEW"
else
  log "sin $OUT_NEW/index.html: la web queda como estaba"
fi

# Una instancia lanzada por el autostart se queda con el candado de instancia única y el
# servicio saldría al instante, con el binario viejo todavía respondiendo en 3080.
systemctl --user stop 'app-phantom\x2dui@autostart.service' 2>/dev/null || true
systemctl --user restart phantom-desktop.service

if responde && es_el_nuevo; then
  avisa "✅ Phantom reiniciado con la versión nueva."
  exit 0
fi

log "no responde: vuelvo al binario anterior"
cp -p "$DEST.backup-$TS" "$DEST"
systemctl --user restart phantom-desktop.service
if responde; then
  avisa "↩️ Phantom: la versión nueva no arrancó; volví a la anterior (todo como antes)."
else
  avisa "🚨 Phantom no responde ni con la versión anterior. Revisa ~/.cache/phantom-instalar-binario.log"
fi
exit 1
