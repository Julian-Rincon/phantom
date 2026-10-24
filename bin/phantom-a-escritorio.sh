#!/usr/bin/env bash
# Phantom pasa de codeg-server (navegador) a la app de escritorio, con LA MISMA carpeta
# de datos (~/.local/share/codeg): los chats de la barra, las pestañas, Telegram y las
# automatizaciones siguen ahí. El escritorio sirve la web en 127.0.0.1:3080 como el
# servidor (tailscale serve y la vigía no cambian) y trae el gancho de FORGE encendido.
#
#   bin/phantom-a-escritorio.sh            hace el cambio (espera la compilación)
#   bin/phantom-a-escritorio.sh --revertir vuelve a codeg-server
#
# Corre fuera de Phantom (systemd-run): parar el servidor corta las sesiones que viven
# en él. Nunca borra datos: respalda la base antes y la reversión solo cambia servicios.
set -uo pipefail
L="$HOME/.cache/phantom-a-escritorio.log"
exec >>"$L" 2>&1
DATA="$HOME/.local/share/codeg"
DEST="$HOME/.local/lib/phantom-desktop"
BIN_SRC="$HOME/Documentos/Proyectos/agent-control-center/codeg/src-tauri/target/release/codeg"
BUILD_LOG="$HOME/.cache/phantom-desktop-build.log"
MODO="$HOME/.config/phantom/modo"
NEXUS="$HOME/Documentos/Proyectos/nexus/.venv/bin/nexus"
ENV_FILE="$HOME/.config/codeg/server.env"

log() { echo "$(date '+%F %T') $*"; }
avisa() { log "aviso: $1"; "$NEXUS" notify "$1" >/dev/null 2>&1 || true; }

revertir() {
  log "revirtiendo a codeg-server"
  rm -f "$MODO"
  systemctl --user disable --now phantom-desktop.service 2>/dev/null || true
  systemctl --user enable --now codeg.service
  for _ in $(seq 1 30); do
    curl -s -o /dev/null http://127.0.0.1:3080/ && { log "codeg-server responde"; return 0; }
    sleep 2
  done
  log "codeg-server NO responde tras revertir"; return 1
}

if [[ "${1:-}" == --revertir ]]; then
  revertir && avisa "↩️ Phantom volvió a codeg-server (navegador)."; exit $?
fi

log "== inicio del cambio a escritorio"
# 1. La compilación del escritorio (con el gancho de FORGE) tiene que haber terminado bien.
until grep -q '^EXIT=' "$BUILD_LOG" 2>/dev/null; do sleep 30; done
if ! grep -q '^EXIT=0' "$BUILD_LOG" || [[ ! -x "$BIN_SRC" ]]; then
  avisa "⚠️ Phantom: la compilación del escritorio falló; sigo con el servidor, nada cambió."
  exit 1
fi

# 2. Respaldo con el servidor todavía vivo (copia consistente de SQLite).
TS=$(date +%Y%m%d-%H%M%S)
R="$HOME/.local/share/codeg-respaldos/$TS"
mkdir -p "$R" && chmod 700 "$HOME/.local/share/codeg-respaldos" "$R"
if ! sqlite3 "$DATA/codeg.db" ".backup '$R/codeg.db'"; then
  avisa "⚠️ Phantom: no pude respaldar la base; no cambio nada."; exit 1
fi
cp -p "$DATA/tokens.json" "$R/" 2>/dev/null || true
log "respaldo en $R ($(sqlite3 "$R/codeg.db" 'select count(*) from conversation') chats)"

# 3. Binario del escritorio en un lugar estable (no en target/, que se recompila).
mkdir -p "$DEST" && cp "$BIN_SRC" "$DEST/codeg.new" && mv "$DEST/codeg.new" "$DEST/codeg"

# 4. Parar el servidor (aquí se corta la sesión de Claude que corre en él).
systemctl --user stop codeg.service
systemctl --user disable codeg.service 2>/dev/null || true

# 5. La web del escritorio arranca sola en 3080 con el mismo token que el servidor.
token=$(sed -n 's/^CODEG_TOKEN=//p' "$ENV_FILE")
ahora=$(date -u +%Y-%m-%dT%H:%M:%S.%N+00:00)
sqlite3 "$DATA/codeg.db" <<SQL
INSERT INTO app_metadata(key, value, created_at, updated_at) VALUES
  ('web_service_auto_start', 'true', '$ahora', '$ahora'),
  ('web_service_port', '3080', '$ahora', '$ahora'),
  ('web_service_token', '$token', '$ahora', '$ahora')
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at,
  deleted_at = NULL;
SQL
unset token

# 6. Arrancar el escritorio.
mkdir -p "$(dirname "$MODO")" && echo escritorio > "$MODO"
systemctl --user daemon-reload
systemctl --user enable --now phantom-desktop.service
sleep 45

# 7. Comprobaciones: vivo, web en 3080 solo en loopback, sin pánico, Telegram arriba.
fallo=""
systemctl --user is-active -q phantom-desktop.service || fallo="el servicio no quedó activo"
codigo=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3080/ || echo 000)
[[ -z "$fallo" && "$codigo" =~ ^(200|401|404)$ ]] || fallo="${fallo:-la web no responde en 3080 ($codigo)}"
escucha=$(ss -ltnH 'sport = :3080' | awk '{print $4}' | sort -u)
while read -r dir; do
  [[ -z "$dir" || "$dir" == "127.0.0.1:3080" ]] || fallo="${fallo:-3080 escucha en $dir}"
done <<<"$escucha"
journalctl --user -u phantom-desktop.service --since "-2min" --no-pager | grep -q panicked \
  && fallo="${fallo:-pánico en el log}"
if [[ -n "$fallo" ]]; then
  log "falló: $fallo"
  revertir
  avisa "⚠️ Phantom: el escritorio falló ($fallo); volví a codeg-server. Log: $L"
  exit 1
fi
log "escritorio arriba: web $codigo en 127.0.0.1:3080"
avisa "✅ Phantom ya es la app de escritorio, con todos tus chats y el gancho de FORGE encendido. Reabre la conversación de FORGE y escribe «continúa»."
