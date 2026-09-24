# Integración nativa con KDE Plasma

## Objetivo

Phantom se presenta como una aplicación local integrada con el
escritorio, sin fingir que la UI web es una ventana Qt nativa. La integración se
limita a superficies soportadas por Plasma/KDE y deja el servidor en loopback.

La sesión detectada en el equipo es:

- Fedora 44 KDE Plasma Desktop Edition;
- Plasma/KWin 6.7.5;
- Wayland (`XDG_SESSION_TYPE=wayland`);
- `xdg-desktop-portal-kde` y `xdg-desktop-portal` instalados;
- Plasma Workspace, KDE Frameworks 6, KDE Connect y `plasma-workspace-devel`
  disponibles.

## Integración implementada

### Launcher de aplicaciones

`integrations/plasma/phantom-ui.desktop` se instala como
`~/.local/share/applications/phantom-ui.desktop` y usa:

- `TryExec` para que el launcher no aparezca si se movió el proyecto;
- `StartupNotify=false`, porque el proceso de arranque abre el navegador y no
  implementa el protocolo de notificación de startup;
- `Categories=Development;IDE;` y `Keywords` para el buscador de aplicaciones;
- un icono SVG instalado en el tema de iconos del usuario;
- una acción de menú **Abrir Phantom** sin acciones destructivas.

El lanzador conserva el servicio local y la URL loopback; no abre un puerto
adicional ni cambia la configuración de red.

### Ventana propia

`bin/open-codeg.sh` abre la UI como ventana de aplicación (`--app`) cuando el
navegador predeterminado es Brave, Chrome o Chromium. Así Phantom tiene su
propia entrada en la barra de tareas, en Alt+Tab y en el conmutador de
ventanas, en vez de ser una pestaña más. En Wayland esa ventana se identifica
como `brave-127.0.0.1__-Default` (comprobado con `org.kde.KWin.getWindowInfo`),
y el `.desktop` lo declara en `StartupWMClass` para que Plasma la agrupe bajo
el icono de Phantom. Solo está comprobado con Brave: con Chrome o Chromium
la ventana se abre igual, pero puede quedar sin agrupar bajo el icono. Con cualquier otro navegador se usa `xdg-open` y se
abre una pestaña normal. `PHANTOM_UI_OPEN_MODE=tab` fuerza la pestaña.

La ventana usa el mismo perfil del navegador, así que respeta el tema
claro/oscuro que Plasma publica por el portal (`prefers-color-scheme`).

### Convivencia con la sesión de Plasma

El servicio y los agentes que lanza (Claude Code, OpenCode, Hermes) viven en
el mismo cgroup de `codeg.service`. El drop-in
`integrations/systemd/phantom-desktop.conf` se instala en
`~/.config/systemd/user/codeg.service.d/` y deja al escritorio primero:

- `CPUWeight=50` e `IOWeight=50`: con contención, KWin/Plasma y la app en
  primer plano reciben el doble de reparto; sin contención los agentes usan
  toda la máquina.
- `Nice=5`.
- `MemoryHigh=8G`: frena y recupera memoria en vez de mandar el escritorio a
  swap. No hay `MemoryMax`, para no matar un turno de agente en curso.
- `StartLimitBurst=5` en `StartLimitIntervalSec=120`: si el servidor entra en
  bucle de fallos se detiene en vez de reiniciarse para siempre en segundo
  plano.

Además:

- el servicio depende de `default.target`, no de `graphical-session.target`;
  no necesita el socket de Wayland, así que no participa en la carrera de
  arranque de Plasma 6;
- no instala autostart de KDE, tray ni scripts de KWin;
- los scripts pasan el token a `curl` por stdin (`-K -`), nunca por la línea
  de comandos, para que no aparezca en `ps`.

### Notificaciones

`integrations/plasma/phantom-ui.notifyrc` se instala en
`~/.local/share/knotifications6/phantom-ui.notifyrc` con los eventos:

- `turn_complete`;
- `error`;
- `permission_request`;
- `question_request`.

El `DesktopEntry` coincide con `phantom-ui.desktop` y el icono usa el nombre
del tema (`phantom-ui`). Esto permite que Plasma reconozca la aplicación en
**Configurar aplicaciones** y respete sus preferencias por evento. Las
notificaciones del navegador siguen siendo las que usa la UI web; esta
configuración deja la identidad nativa lista para el transporte de escritorio
y para las pruebas de notificación del producto.

### Color y tema

La UI web aplica un acento raíz según el modelo seleccionado en la conexión ACP
activa. El puente está en `codeg/src/components/phantom-model-accent-bridge.tsx`
y la paleta/reglas en `codeg/src/lib/phantom-ui.ts` y `codeg/src/app/globals.css`.

- Cada acento tiene un tono para modo claro y otro para oscuro; ambos cumplen
  WCAG AA (4.5:1) contra el texto del botón y contra fondo y tarjetas, y los
  tests unitarios lo verifican.
- El acento solo recolorea `primary`, `ring`, `sidebar-primary` y `chart-3`
  sobre el preset base neutral. Un preset de color elegido explícitamente o un
  tema custom conservan prioridad. Error, permisos y destructivo nunca cambian.
- El último acento se guarda en `localStorage` (`phantom-ui-accent`) y un
  script previo a la hidratación lo restaura, sin parpadeo azul al abrir.

## Decisiones deliberadamente no tomadas

- **No se instala un script de KWin.** Un script puede registrar atajos, pero no
  es la API adecuada para convertir una aplicación web en una ventana nativa y
  puede quedar acoplado a una versión de KWin. Si más adelante se necesita un
  atajo global, se añadirá como componente KGlobalAccel/KRunner con una
  integración probada en Plasma 6.7, no como efecto lateral de KWin.
- **No se añade un tray permanente.** La guía de KDE recomienda que las apps
  en segundo plano prioricen notificaciones, insignias/progreso y widgets; un
  icono de bandeja permanente solo se justifica si existe estado anormal que
  la aplicación no pueda expresar de otro modo. La UI ya muestra progreso y
  estados en la aplicación.
- **No se usa WebKit/Qt embebido para reimplementar Codeg.** La UI existente
  conserva streaming, permisos, diffs, historial y worktrees; una carcasa Qt
  duplicaría esa superficie sin aportar interoperabilidad.

## Fuentes oficiales consultadas

- [KNotification — KDE Developer](https://develop.kde.org/docs/features/knotification/)
  — `notifyrc`, `DesktopEntry`, eventos, urgencia y acciones.
- [Desktop Entry Specification](https://specifications.freedesktop.org/desktop-entry/latest/)
  — `TryExec`, `Exec`, `StartupNotify`, acciones y discoverability.
- [KDE Desktop file](https://develop.kde.org/docs/features/additional-features/desktop-file/)
  — campos recomendados para el launcher y el icono.
- [KDE D-Bus autostart services](https://develop.kde.org/docs/features/d-bus/dbus_autostart_services/)
  — alternativa soportada si Phantom se convierte en un proceso D-Bus
  activable; no se usa mientras el launcher sea un script.
- [Communicating status changes — KDE HIG](https://develop.kde.org/hig/status_changes/)
  —cuándo usar notificaciones, progreso, insignias y por qué no añadir un tray
  permanente.
- [Plasma Widget properties](https://develop.kde.org/docs/plasma/widget/properties/)
  —reservado para una futura superficie opcional, no para el núcleo actual.
- [KWin scripting API](https://develop.kde.org/docs/plasma/kwin/api/)
  —referencia evaluada; no se usa por la decisión anterior.

## Instalación y comprobación

```bash
./scripts/install-plasma-integration.sh
desktop-file-validate ~/.local/share/applications/phantom-ui.desktop
```

## Atajo global opcional

Para no escribir a mano archivos internos de KGlobalAccel, se recomienda
configurarlo desde **Configuración del sistema → Teclado → Atajos → Atajos
personalizados**:

- Nombre: `Phantom`;
- Comando: `<ruta del repo>/bin/phantom-ui-open.sh`;
- Atajo sugerido: `Ctrl+Alt+P` (o una combinación libre).

El script es idempotente y abre la interfaz aunque el servicio ya esté activo.
No se modifica automáticamente la configuración de Plasma para no sustituir
preferencias ni reservar pulsaciones del usuario.

Después se puede abrir desde el menú de aplicaciones de Plasma. Para una
verificación de notificaciones, usar el botón de prueba de notificaciones de la
propia UI y comprobar que el nombre mostrado sea **Phantom**.
