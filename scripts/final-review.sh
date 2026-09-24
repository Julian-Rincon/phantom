#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODEL="${CLAUDE_REVIEW_MODEL:-opus[1m]}"
REPORT_DIR="$ROOT/reports"
mkdir -p "$REPORT_DIR"
REPORT="$REPORT_DIR/final-review-opus55-$(date +%Y%m%d-%H%M%S).md"
TMP_REPORT=$(mktemp)
trap 'rm -f "$TMP_REPORT"' EXIT

PROMPT=$(cat <<'EOF'
Realiza una revisión final, crítica y solo de lectura, de este proyecto y de sus cambios actuales.

Objetivo: mejorar una interfaz local unificada para OpenCode, Claude Code y Hermes, con historial, cambio de agente/modelo y delegación multiagente.

Revisa explícitamente:
1. Arquitectura y si los tres agentes tienen realmente el mismo peso operativo.
2. UI/UX y claridad de la línea temporal, selector de agente/modelo y estados.
3. Seguridad: loopback, token, permisos, secretos, aislamiento de worktrees y handoffs.
4. Historiales: importación, reanudación, procedencia y no sobrescritura de stores nativos.
5. Compatibilidad real con OpenCode 2.x y el parser historial.
6. Descargas, watchers, builds y recuperación ante reinicios.
7. Pruebas, errores y riesgos que bloquean la entrega.

No edites archivos, no ejecutes comandos destructivos y no expongas secretos. Devuelve:
- un veredicto en menos de 5 líneas;
- hallazgos P0/P1/P2 con ruta y evidencia;
- cambios concretos que recomendarías antes de ship;
- una lista de pruebas que faltan.
Sé específico y evita repetir lo que ya funciona.
EOF
)

if ! command -v claude >/dev/null 2>&1; then
  printf 'ERROR: Claude Code no está instalado en PATH\n' >&2
  exit 127
fi

printf 'Revisando con Claude Code, modelo %s...\n' "$MODEL"
cd "$ROOT"
claude -p "$PROMPT" \
  --model "$MODEL" \
  --effort high \
  --permission-mode plan \
  --output-format text \
  --no-session-persistence \
  > "$TMP_REPORT"

cp "$TMP_REPORT" "$REPORT"
printf 'Review guardada en %s\n\n' "$REPORT"
cat "$REPORT"
