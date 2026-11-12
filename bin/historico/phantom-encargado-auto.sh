#!/usr/bin/env bash
# Encargado: compila el escritorio de Phantom con el interruptor de permisos
# automáticos (/menu, /auto), lo instala y lo verifica en vivo. Corre como unidad
# transitoria de systemd (fuera de Phantom), porque apaga Phantom mientras compila
# para liberar memoria. Pase lo que pase, al salir deja Phantom encendido.
set -uo pipefail
L="$HOME/.cache/phantom-encargado-auto.log"
exec >>"$L" 2>&1
WT="$HOME/Documentos/Proyectos/agent-control-center/wt-merge-040"
BIN="$WT/src-tauri/target/release/codeg"
INSTALL="$HOME/Documentos/Proyectos/agent-control-center/bin/phantom-instalar-binario.sh"
NEXUS="$HOME/Documentos/Proyectos/nexus/.venv/bin/nexus"
export PATH="$HOME/.cargo/bin:$PATH"

log() { echo "$(date '+%F %T') $*"; }
avisa() { log "aviso: $1"; "$NEXUS" notify "$1" >/dev/null 2>&1 || true; }
asegura_phantom() {
  systemctl --user is-active -q phantom-desktop.service || systemctl --user start phantom-desktop.service
}
trap asegura_phantom EXIT

log "== encargado inicia (rama $(git -C "$WT" rev-parse --abbrev-ref HEAD) $(git -C "$WT" rev-parse --short HEAD))"
avisa "🛠️ Encargado: apago Phantom ~15 min para compilar el botón de permisos automáticos. Te aviso al terminar."
sleep 60
systemctl --user stop phantom-desktop.service
sleep 5

avail_kb=$(awk '/MemAvailable/ {print $2}' /proc/meminfo)
cap_g=$(( avail_kb / 1048576 - 2 ))
(( cap_g > 20 )) && cap_g=20
log "memoria disponible $((avail_kb / 1048576))G, tope de compilación ${cap_g}G"
if (( cap_g < 14 )); then
  avisa "⚠️ Encargado: solo hay $((avail_kb / 1048576)) GB libres incluso con Phantom apagado; no compilo. Phantom vuelve a encenderse sin cambios."
  exit 1
fi

cd "$WT/src-tauri"
systemd-run --user --scope -q -p MemoryMax=${cap_g}G -p MemorySwapMax=0 \
  --setenv=PATH="$PATH" --setenv=CARGO_BUILD_JOBS=4 nice -n 5 \
  cargo build --release --bin codeg --features tauri/custom-protocol \
  --config 'profile.release.package.codeg.codegen-units=4'
rc=$?
log "cargo build rc=$rc"

embedded=$(strings "$BIN" | grep -c -E '_next/static|index.html')
feature=$(strings "$BIN" | grep -c 'Permisos: autom')
log "marcas: interfaz embebida=$embedded, botón=$feature"
if (( rc != 0 || embedded < 300 || feature < 1 )); then
  avisa "⚠️ Encargado: la compilación falló (rc=$rc, interfaz=$embedded). Phantom vuelve a encenderse sin cambios. Log: ~/.cache/phantom-encargado-auto.log"
  exit 1
fi

# Instala con respaldo de base y binario, reinicia y revierte si no responde.
if ! "$INSTALL" "$BIN"; then
  log "el instalador revirtió"
  exit 1
fi

# Verificación en vivo.
T=$(grep -oP '^CODEG_TOKEN=\K.*' "$HOME/.config/codeg/server.env")
tg="?"
for _ in $(seq 1 45); do
  tg=$(curl -s --max-time 5 -X POST -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
    -d '{}' http://127.0.0.1:3080/api/get_chat_channel_status | grep -oP '"status":"\K[^"]+' | head -1)
  [[ "$tg" == connected ]] && break
  sleep 2
done
web=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3080/)
ts=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
  --resolve julian-pc.tail6db58d.ts.net:443:100.79.241.31 https://julian-pc.tail6db58d.ts.net/)
inst=$(strings "$HOME/.local/lib/phantom-desktop/codeg" | grep -c 'Permisos: autom')
log "verificación: telegram=$tg web=$web tailscale=$ts botón_instalado=$inst"

if [[ "$tg" == connected && "$web" == 200 && "$inst" -ge 1 ]]; then
  avisa "✅ Encargado: Phantom actualizado y en línea (Telegram conectado, web $web, Tailscale $ts). Escribe /menu en Telegram: abajo está el botón ✋/🤖 de permisos. También /auto on y /auto off."
else
  avisa "⚠️ Encargado: Phantom instalado pero la verificación no cerró (telegram=$tg web=$web tailscale=$ts). Revisa ~/.cache/phantom-encargado-auto.log"
fi
