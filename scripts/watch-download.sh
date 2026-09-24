#!/usr/bin/env bash
set -euo pipefail

interval=15
ready_command=""
label="descarga"

usage() {
  cat <<'EOF'
Uso:
  watch-download.sh [--interval SEGUNDOS] [--label NOMBRE]
                    [--ready-command COMANDO] -- COMANDO [ARGUMENTOS...]

Ejecuta COMANDO en segundo plano, informa si sigue activo y ejecuta COMANDO
de verificacion cuando la descarga termina correctamente. El watcher nunca
cancela la descarga por un timeout artificial.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --interval)
      [[ $# -ge 2 ]] || { printf 'Falta el valor de --interval\n' >&2; exit 2; }
      interval="$2"
      shift 2
      ;;
    --label)
      [[ $# -ge 2 ]] || { printf 'Falta el valor de --label\n' >&2; exit 2; }
      label="$2"
      shift 2
      ;;
    --ready-command)
      [[ $# -ge 2 ]] || { printf 'Falta el valor de --ready-command\n' >&2; exit 2; }
      ready_command="$2"
      shift 2
      ;;
    --)
      shift
      break
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Opcion desconocida: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ $# -eq 0 ]]; then
  usage >&2
  exit 2
fi

if ! [[ "$interval" =~ ^[1-9][0-9]*$ ]]; then
  printf '--interval debe ser un entero positivo\n' >&2
  exit 2
fi

started=$(date +%s)
printf '[%s] DOWNLOAD_STARTED label=%s pid=soon\n' "$(date -Is)" "$label"

"$@" &
child_pid=$!
printf '[%s] WATCHING label=%s pid=%s interval=%ss\n' \
  "$(date -Is)" "$label" "$child_pid" "$interval"

while kill -0 "$child_pid" 2>/dev/null; do
  sleep "$interval"
  if kill -0 "$child_pid" 2>/dev/null; then
    printf '[%s] DOWNLOADING label=%s elapsed=%ss\n' \
      "$(date -Is)" "$label" "$(( $(date +%s) - started ))"
  fi
done

set +e
wait "$child_pid"
exit_code=$?
set -e

if [[ "$exit_code" -ne 0 ]]; then
  printf '[%s] DOWNLOAD_FAILED label=%s exit=%s elapsed=%ss\n' \
    "$(date -Is)" "$label" "$exit_code" "$(( $(date +%s) - started ))" >&2
  exit "$exit_code"
fi

if [[ -n "$ready_command" ]]; then
  printf '[%s] VERIFYING label=%s\n' "$(date -Is)" "$label"
  bash -lc "$ready_command"
fi

printf '[%s] READY label=%s elapsed=%ss\n' \
  "$(date -Is)" "$label" "$(( $(date +%s) - started ))"
