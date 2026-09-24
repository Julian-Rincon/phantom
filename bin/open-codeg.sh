#!/usr/bin/env bash
set -euo pipefail

SERVICE="codeg.service"
URL="http://127.0.0.1:3080"
ENV_FILE="${CODEG_ENV_FILE:-$HOME/.config/codeg/server.env}"

systemctl --user start "$SERVICE"

TOKEN=""
if [[ -r "$ENV_FILE" ]]; then
  TOKEN=$(sed -n 's/^CODEG_TOKEN=//p' "$ENV_FILE")
fi

# The token goes to curl through a config on stdin, never through argv, so it
# does not show up in `ps` or the process table.
healthy() {
  if [[ -n "$TOKEN" ]]; then
    printf 'header = "Authorization: Bearer %s"\n' "$TOKEN" |
      curl -fsS -X POST -K - -o /dev/null "$URL/api/health" 2>/dev/null
  else
    curl -fsS -o /dev/null "$URL" 2>/dev/null
  fi
}

for _ in $(seq 1 30); do
  healthy && break
  sleep 1
done

# Prefer a standalone app window (own taskbar entry, grouped under the Phantom
# UI launcher via StartupWMClass) when the default browser is Chromium-based.
# Any other browser falls back to a regular tab through xdg-open.
app_browser() {
  local desktop
  desktop=$(xdg-settings get default-web-browser 2>/dev/null || true)
  case "$desktop" in
    brave-browser*.desktop) command -v brave-browser ;;
    google-chrome*.desktop) command -v google-chrome ;;
    chromium*.desktop) command -v chromium-browser || command -v chromium ;;
    *) return 1 ;;
  esac
}

if [[ "${PHANTOM_UI_OPEN_MODE:-app}" == "app" ]] && browser=$(app_browser); then
  setsid -f "$browser" --app="$URL" >/dev/null 2>&1
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$URL" >/dev/null 2>&1
elif command -v sensible-browser >/dev/null 2>&1; then
  sensible-browser "$URL" >/dev/null 2>&1
else
  printf 'Phantom está listo en %s\n' "$URL"
fi
