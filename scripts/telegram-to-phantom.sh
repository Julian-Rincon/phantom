#!/usr/bin/env bash
# Move the Hermes Telegram bot into Phantom as the general chat.
#
# - Creates (or reuses) a Telegram chat channel in Phantom with Claude Code as
#   the default lead agent, and stores the bot token through Phantom's API.
# - Stops the Hermes gateway from polling Telegram (two long-pollers on one
#   bot fight over getUpdates). ~/.hermes/.env is left untouched, so tools
#   that only SEND with that token (e.g. ai-job-search/tools/notify.py) keep
#   working.
# - `--revert` undoes it: disconnects the Phantom channel and re-enables
#   Telegram in Hermes.
#
# Secrets never reach argv, stdout or logs: tokens travel through stdin.
set -euo pipefail

PHANTOM_URL="${PHANTOM_URL:-http://127.0.0.1:3080}"
CODEG_ENV="${CODEG_ENV_FILE:-$HOME/.config/codeg/server.env}"
HERMES_ENV="${HERMES_ENV_FILE:-$HOME/.hermes/.env}"
HERMES_CONFIG="${HERMES_CONFIG_FILE:-$HOME/.hermes/config.yaml}"
CHANNEL_NAME="Telegram"
STAMP=$(date +%Y%m%d-%H%M%S)

env_value() { sed -n "s/^$2=//p" "$1" | tail -n1 | tr -d '"'"'"; }

CODEG_TOKEN=$(env_value "$CODEG_ENV" CODEG_TOKEN)
[[ -n "$CODEG_TOKEN" ]] || { echo "No encuentro CODEG_TOKEN en $CODEG_ENV" >&2; exit 1; }

# POST to Phantom's API; body comes from stdin, bearer header from a curl
# config on a separate descriptor, so neither shows up in `ps`.
api() {
  curl -fsS -X POST -K <(printf 'header = "Authorization: Bearer %s"\n' "$CODEG_TOKEN") \
    -H 'Content-Type: application/json' --data-binary @- "$PHANTOM_URL/api/$1"
}

find_channel_id() {
  echo '{}' | api list_chat_channels | python3 -c '
import json, sys
name = sys.argv[1]
for c in json.load(sys.stdin):
    if c.get("channel_type") == "telegram" and c.get("name") == name:
        print(c["id"]); break
' "$CHANNEL_NAME"
}

set_hermes_telegram() {
  local enabled="$1"
  cp -p "$HERMES_CONFIG" "$HERMES_CONFIG.bak-$STAMP"
  python3 - "$HERMES_CONFIG" "$enabled" <<'PY'
import re, sys
path, enabled = sys.argv[1], sys.argv[2]
text = open(path).read()
block = f"platforms:\n  telegram:\n    enabled: {enabled}\n"
if re.search(r"^platforms:\n  telegram:\n    enabled: (true|false)\n", text, re.M):
    text = re.sub(r"^platforms:\n  telegram:\n    enabled: (true|false)\n", block, text, flags=re.M)
elif re.search(r"^platforms:", text, re.M):
    sys.exit("config.yaml ya tiene un bloque platforms: distinto; edítalo a mano")
else:
    text = text.rstrip("\n") + "\n" + block
open(path, "w").write(text)
PY
  systemctl --user restart hermes-gateway.service
}

if [[ "${1:-}" == "--revert" ]]; then
  id=$(find_channel_id || true)
  if [[ -n "$id" ]]; then
    printf '{"id":%s}' "$id" | api disconnect_chat_channel >/dev/null || true
    printf '{"id":%s,"enabled":false}' "$id" | api update_chat_channel >/dev/null
  fi
  set_hermes_telegram true
  echo "Revertido: Hermes vuelve a atender Telegram; el canal de Phantom quedó deshabilitado."
  exit 0
fi

BOT_TOKEN=$(env_value "$HERMES_ENV" TELEGRAM_BOT_TOKEN)
CHAT_ID=$(env_value "$HERMES_ENV" TELEGRAM_HOME_CHANNEL)
if [[ -z "$CHAT_ID" ]]; then
  # A private chat's id is the user's id: fall back to the first allowed user.
  CHAT_ID=$(env_value "$HERMES_ENV" TELEGRAM_ALLOWED_USERS | cut -d, -f1 | tr -d ' ')
fi
[[ -n "$BOT_TOKEN" ]] || { echo "No encuentro TELEGRAM_BOT_TOKEN en $HERMES_ENV" >&2; exit 1; }
[[ -n "$CHAT_ID" ]] || { echo "No encuentro el chat de Telegram en $HERMES_ENV" >&2; exit 1; }

id=$(find_channel_id || true)
config=$(python3 -c 'import json,sys; print(json.dumps({"chat_id": sys.argv[1], "topic_mode": False, "default_agent_type": "claude_code"}))' "$CHAT_ID")
if [[ -z "$id" ]]; then
  python3 -c 'import json,sys; print(json.dumps({"name": sys.argv[1], "channelType": "telegram", "configJson": sys.argv[2], "enabled": True, "dailyReportEnabled": False, "dailyReportTime": None}))' \
    "$CHANNEL_NAME" "$config" | api create_chat_channel >/dev/null
  id=$(find_channel_id)
else
  python3 -c 'import json,sys; print(json.dumps({"id": int(sys.argv[1]), "enabled": True, "configJson": sys.argv[2]}))' \
    "$id" "$config" | api update_chat_channel >/dev/null
fi

# Token through stdin only.
BOT_TOKEN="$BOT_TOKEN" python3 -c 'import json,os,sys; print(json.dumps({"channelId": int(sys.argv[1]), "token": os.environ["BOT_TOKEN"]}))' "$id" \
  | api save_chat_channel_token >/dev/null
unset BOT_TOKEN

# Free the bot from Hermes first, then let Phantom start polling.
set_hermes_telegram false
sleep 3
printf '{"id":%s}' "$id" | api connect_chat_channel >/dev/null

echo "Listo: el bot de Telegram ahora entra a Phantom (canal $id, líder Claude Code)."
echo "Hermes dejó de escuchar Telegram (backup: $HERMES_CONFIG.bak-$STAMP)."
echo "Para volver atrás: $0 --revert"
