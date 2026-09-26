#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APPLICATIONS_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
NOTIFY_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/knotifications6"
ICON_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor"
DROPIN_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/codeg.service.d"
DESKTOP_ID="phantom-ui.desktop"
LEGACY_ID="codeg-multiagent.desktop"

install -d -m 755 "$APPLICATIONS_DIR" "$NOTIFY_DIR" "$DROPIN_DIR"
# The launcher points at this checkout, wherever it was cloned.
sed "s#@PHANTOM_ROOT@#$ROOT#g" "$ROOT/integrations/plasma/$DESKTOP_ID" >"$APPLICATIONS_DIR/$DESKTOP_ID"
chmod 644 "$APPLICATIONS_DIR/$DESKTOP_ID"
install -m 644 "$ROOT/integrations/plasma/phantom-ui.notifyrc" "$NOTIFY_DIR/phantom-ui.notifyrc"
# Raster emblem from brand/phantom-logo.png at the standard hicolor sizes. The
# old vector placeholder in scalable/ would outrank them, so it is removed.
for size in 32 64 192 256 512; do
  install -d -m 755 "$ICON_ROOT/${size}x${size}/apps"
  install -m 644 "$ROOT/codeg/public/phantom-emblem-$size.png" "$ICON_ROOT/${size}x${size}/apps/phantom-ui.png"
done
rm -f "$ICON_ROOT/scalable/apps/phantom-ui.svg"

# Keep one visible launcher. The old entry was created by the previous local
# setup; keep a one-time .legacy copy instead of deleting it outright.
if [[ -e "$APPLICATIONS_DIR/$LEGACY_ID" ]]; then
  mv "$APPLICATIONS_DIR/$LEGACY_ID" "$APPLICATIONS_DIR/$LEGACY_ID.legacy"
fi

# Open the Phantom window at login (XDG autostart; Plasma runs it once the
# session is up, and open-codeg.sh waits for the service to answer first).
# PHANTOM_AUTOSTART=0 removes it.
AUTOSTART_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/autostart"
if [[ "${PHANTOM_AUTOSTART:-1}" == "1" ]]; then
  install -d -m 755 "$AUTOSTART_DIR"
  sed -e "s#@PHANTOM_ROOT@#$ROOT#g" \
    -e '/^\[Desktop Action /,$d' \
    -e 's/^Actions=.*$/X-KDE-autostart-phase=2/' \
    "$ROOT/integrations/plasma/$DESKTOP_ID" >"$AUTOSTART_DIR/$DESKTOP_ID"
  chmod 644 "$AUTOSTART_DIR/$DESKTOP_ID"
else
  rm -f "$AUTOSTART_DIR/$DESKTOP_ID"
fi

# Resource weights and crash-loop limit for the service (see the file header).
# Picked up on the next service (re)start; nothing is restarted from here.
install -m 644 "$ROOT/integrations/systemd/phantom-desktop.conf" "$DROPIN_DIR/phantom-desktop.conf"
systemctl --user daemon-reload

if command -v desktop-file-validate >/dev/null 2>&1; then
  desktop-file-validate "$APPLICATIONS_DIR/$DESKTOP_ID"
fi
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$APPLICATIONS_DIR"
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -f "${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor" >/dev/null 2>&1 || true
fi

printf 'Phantom Plasma integration installed\n'
printf '  launcher: %s\n' "$APPLICATIONS_DIR/$DESKTOP_ID"
printf '  notify:   %s\n' "$NOTIFY_DIR/phantom-ui.notifyrc"
printf '  icon:     %s\n' "$ICON_ROOT/<size>/apps/phantom-ui.png"
printf '  systemd:  %s\n' "$DROPIN_DIR/phantom-desktop.conf"
printf '  autostart: %s\n' "$([[ "${PHANTOM_AUTOSTART:-1}" == "1" ]] && echo "$AUTOSTART_DIR/$DESKTOP_ID" || echo off)"
