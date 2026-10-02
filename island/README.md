# Phantom Island

**Una vista en vivo de tus sesiones de agentes de Phantom, arriba del centro de la pantalla.**

Phantom Island muestra, paso a paso, lo que están haciendo tus agentes (Claude
Code, OpenCode, Hermes) a través de Phantom (`codeg-server`,
`http://127.0.0.1:3080`): permisos para Aprobar/Denegar, chat con el fantasma
de cada agente, arrastrar un archivo para preguntarle, avisos de límite con
sucesor, y GitHub como integración opcional — sin salir de lo que estás
haciendo.

Siempre hay un fantasma por cada agente que usa Phantom (Claude Code,
OpenCode, Hermes). Cuando ese agente tiene una sesión en vivo, la sesión toma
su lugar; cuando termina, el fantasma vuelve. El chat de la isla habla con el
fantasma seleccionado (Claude Code por defecto) a través de Phantom, en tu
carpeta personal, así que la conversación también aparece en la app.

![Fedora 44](https://img.shields.io/badge/Fedora-44-51A2DA?logo=fedora)
![KDE Plasma 6](https://img.shields.io/badge/KDE%20Plasma-6-1D99F3?logo=kdeplasma)
![Tauri 2](https://img.shields.io/badge/Tauri-2-FFC131?logo=tauri&logoColor=black)
![Rust](https://img.shields.io/badge/Rust-backend-000?logo=rust)
![License: MIT](https://img.shields.io/badge/license-MIT-green)

---

## Qué es esto

`island/` nació como una copia de **Coucou**, la app de Louis Raillé
(github.com/louis-cfm/coucou) que pone a "Mochi" en la parte superior de la
pantalla mostrando hooks de Claude Code. El código base es MIT (ver
`LICENSE.coucou-MIT`), pero el nombre "Coucou"/"Mochi", el personaje, los
iconos y los sonidos **no** están licenciados — no aparecen en ninguna parte
de este puerto. Todo lo visible para el usuario (nombre del producto,
identificador de la app, título de ventanas/menús, nombre del servicio en el
llavero del sistema) es "Phantom Island" / `dev.phantom.island` /
`phantom-island`.

Este puerto reemplaza además la fuente de datos: ya no instala hooks en
`~/.claude/settings.json` ni relé por pipe con nombre — Phantom ya observa
cada sesión de agente directamente, así que la isla se conecta a Phantom por
WebSocket y REST en su lugar. Ver `src-tauri/BRIDGE.md` para el contrato
completo entre el backend de Rust y el frontend.

## Requisitos del sistema (Fedora 44 / KDE Plasma 6)

```bash
sudo dnf install webkit2gtk4.1-devel gtk3-devel libsoup3-devel \
  dbus-devel libappindicator-gtk3-devel librsvg2-devel
```

Phantom debe estar corriendo (`codeg-server` en `127.0.0.1:3080`) con un
token válido en `~/.config/codeg/server.env` — sin eso, la isla arranca igual
pero muestra "Phantom no conectado" y no hay nada que mostrar.

## Instalación

Desde la raíz del repo (`agent-control-center/`):

```bash
scripts/install-island.sh
```

Esto compila el backend en modo release, instala el binario en
`~/.local/bin/phantom-island`, crea un lanzador `.desktop` e instala la unidad
de usuario `phantom-island.service` (arranca con `plasma-workspace.target`,
espera a Wayland y a Phantom, y se reinicia sola si se cae). El script es
idempotente — correrlo de nuevo actualiza en el mismo lugar.

## Integración con Plasma (Wayland nativo)

La isla es una superficie **layer-shell** nativa de Wayland
(`gtk-layer-shell`, capa `Top`, anclada arriba, namespace `phantom-island`),
igual que los paneles de Plasma: KWin la pone arriba-centro, encima de las
ventanas, sin entrada en la barra de tareas y sin reservar espacio. No hace
falta XWayland ni reglas de KWin.

Colapsada, sólo una franja de 360×3 px recibe el mouse (región de entrada de
Wayland); el resto de la superficie deja pasar los clics a lo que está
debajo. Expandida, la región de entrada es exactamente el rectángulo de la
isla. El teclado es `OnDemand`: la isla sólo toma el foco cuando haces clic
en ella (por ejemplo, para escribir en el chat). Con la isla dormida las
animaciones CSS se pausan, así que el consumo en reposo es ~0 % de CPU.

`PHANTOM_ISLAND_X11=1` fuerza el camino antiguo por XWayland (ventana X11 con
región de entrada SHAPE), sólo como respaldo si el compositor no soporta
layer-shell.

Pantallas múltiples: Julian tiene dos monitores; `screen: "primary"` (por
defecto) usa siempre el monitor primario del sistema, `"cursor"` usa el
monitor bajo el puntero en el momento de posicionar.

## Variables de entorno

| Variable | Efecto |
|---|---|
| `PHANTOM_ISLAND_AUTOSTART=0` | El instalador deja la unidad de systemd desactivada. |
| `PHANTOM_ISLAND_X11=1` | Corre por XWayland en vez de layer-shell nativo (sólo respaldo). |
| `PHANTOM_ISLAND_KWIN_RULE=1` | El instalador además escribe una regla de KWin (sólo útil con `PHANTOM_ISLAND_X11=1`). |

## Desarrollo

```bash
cd island
npm install
npm run dev          # frontend (Vite) + backend (cargo) en modo dev
```

Backend solo (requiere las libs del sistema de arriba):

```bash
cd island/src-tauri
cargo check
cargo clippy -- -D warnings
cargo test
```

## Estructura

- `src-tauri/` — backend Rust (Tauri 2). Ver `BRIDGE.md` para los comandos
  `invoke` y eventos que expone al frontend.
- `src/`, `index.html`, `settings.html` — frontend (propiedad de otro agente
  en este puerto; no tocar desde el lado Rust salvo a través del contrato de
  `BRIDGE.md`).
- `scripts/` — generación de iconos (`gen-icons.mjs`) y empaquetado
  (`pack.mjs`).

## Licencia y atribución

Código MIT de Coucou (`LICENSE.coucou-MIT`) — personaje, nombre, iconos y
sonidos son propios de este proyecto, no de Coucou. Basado en el trabajo de
Louis Raillé (github.com/louis-cfm/coucou).
