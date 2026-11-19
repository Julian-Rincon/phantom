#!/usr/bin/env bash
# Envoltorio: el verificador vive en el fork (scripts/phantom-verificar-fork.sh)
# para que el CI también lo corra. Uso: phantom-verificar-fork.sh [checkout]
set -u
aqui="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
raiz="${1:-$aqui/codeg}"
exec bash "$raiz/scripts/phantom-verificar-fork.sh" "$raiz"
