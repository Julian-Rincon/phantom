#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${CODEG_ENV_FILE:-$HOME/.config/codeg/server.env}"
BASE_URL="${CODEG_URL:-http://127.0.0.1:3080}"

if [[ ! -r "$ENV_FILE" ]]; then
  printf 'ERROR: no se puede leer %s\n' "$ENV_FILE" >&2
  exit 1
fi

TOKEN=$(sed -n 's/^CODEG_TOKEN=//p' "$ENV_FILE")
if [[ -z "$TOKEN" ]]; then
  printf 'ERROR: CODEG_TOKEN no esta configurado\n' >&2
  exit 1
fi

# The token reaches curl through a config on stdin, never through argv.
api() {
  local endpoint="$1"
  local payload="${2:-\{\}}"
  printf 'header = "Authorization: Bearer %s"\n' "$TOKEN" |
    curl -fsS -X POST -K - \
      -H 'Content-Type: application/json' \
      --data "$payload" \
      "$BASE_URL/api/$endpoint"
}

printf 'Servicio: %s\n' "$(systemctl --user is-active codeg.service 2>/dev/null || printf 'desconocido')"
printf 'Habilitado al iniciar: %s\n' "$(systemctl --user is-enabled codeg.service 2>/dev/null || printf 'desconocido')"
printf 'Health: '
api health | jq -c '{status,version}'

printf 'Delegacion: '
api get_delegation_settings | jq -c '{enabled,depth_limit,completed_cache_max_mb}'

printf 'Broker MCP: '
api get_codeg_mcp_service_status | jq -c '{state,listening,binary_path,companion_count,session_count,active_delegations,depth_limit,last_error}'

printf 'Agentes principales: '
api acp_list_agents \
  | jq -c '[.[] | select(.agent_type == "open_code" or .agent_type == "claude_code" or .agent_type == "hermes") | {agent_type,name,enabled,available,installed_version}]'

python3 - "$HOME/.local/share/codeg/codeg.db" <<'PY'
import json
import sqlite3
import sys

path = sys.argv[1]
connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
rows = connection.execute(
    """
    SELECT agent_type, COUNT(*)
    FROM conversation
    WHERE deleted_at IS NULL
      AND agent_type IN ('open_code', 'claude_code', 'hermes')
    GROUP BY agent_type
    ORDER BY agent_type
    """
).fetchall()
connection.close()
print("Conversaciones importadas: " + json.dumps(dict(rows), ensure_ascii=False, sort_keys=True))
PY
