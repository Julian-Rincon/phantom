# Actualizar Phantom a una versión nueva de Codeg

El fork lleva pocos cambios sobre Codeg, y casi todos viven en archivos propios
(`nexus_*`, `phantom_*`, `src/components/phantom/`). Lo único que toca código de
upstream son unas pocas líneas de enganche, y `bin/phantom-verificar-fork.sh`
comprueba que sigan ahí. Así un merge que las borre en silencio no llega a instalarse.

Todo se hace en el worktree `../wt-merge-0430`, nunca en el checkout instalado.

1. `git fetch upstream --tags`, rama `merge/vX.Y.Z` desde `local/opencode-v2-history`, `git merge vX.Y.Z`.
2. Conflicto habitual: `src-tauri/tauri.conf.json`. Queda `"productName": "Phantom"` con la versión nueva.
3. `bin/phantom-verificar-fork.sh <worktree>` debe decir OK. Si falta un enganche, se repone antes de seguir.
4. `pnpm install --frozen-lockfile`, `pnpm exec tsc --noEmit`, `cargo test --lib` (necesita `out/`), `pnpm exec vitest run`.
   Vitest da timeouts falsos con la máquina cargada: lo que falle se corre solo.
   Vitest local siempre con `--maxWorkers=2` y nunca a la vez que cargo.
   Después de hacer push de `merge/vX`, esperar a que el CI de Phantom
   (`.github/workflows/phantom-ci.yml`: enganches, frontend, Rust) esté en verde antes de instalar.
5. `pnpm tauri build --no-bundle` y `cargo build --release --features server-bin --bin codeg-server`.
6. `bin/phantom-ocupado.py` inactivo tres veces, con un minuto entre cada una.
7. `systemd-run --user --wait --collect bin/phantom-instalar-binario.sh <worktree>/src-tauri/target/release/codeg`.
8. Verificar: el binario en ejecución y `~/.local/bin/codeg-server` iguales a los compilados, `127.0.0.1:3080` responde 200.
9. `git merge --ff-only` en `codeg/`, push, y commit del puntero en este repo.

Regla para código nuevo del fork: archivo propio y una sola línea de enganche en
upstream. Cada enganche nuevo se añade a `phantom-verificar-fork.sh`.
