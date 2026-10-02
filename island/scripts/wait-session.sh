#!/bin/sh
# Wait (max 90 s) until the compositor's display socket exists and Phantom
# answers, so the island never starts before Plasma's display is usable.
# Wayland (the native layer-shell path) is preferred; the X socket is only
# checked when the XWayland fallback is forced. Never fails: the island
# itself reconnects to Phantom on its own.
n=0
d="${DISPLAY#:}"; d="${d%%.*}"
display_ready() {
  if [ -n "$PHANTOM_ISLAND_X11" ]; then
    [ -S "/tmp/.X11-unix/X$d" ]
  else
    [ -S "${XDG_RUNTIME_DIR}/${WAYLAND_DISPLAY:-wayland-0}" ]
  fi
}
while [ "$n" -lt 90 ]; do
  if display_ready && curl -s -o /dev/null --max-time 2 http://127.0.0.1:3080/; then
    exit 0
  fi
  n=$((n + 1))
  sleep 1
done
exit 0
