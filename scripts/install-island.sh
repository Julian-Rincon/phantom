#!/usr/bin/env bash
# Builds and installs Phantom Island (island/) for the current user.
#
#   scripts/install-island.sh
#
# Idempotent: running it again rebuilds and overwrites in place, and the
# .desktop / autostart entries are regenerated from scratch each time rather
# than patched, so a stale previous run never lingers half-applied.
#
# Env vars:
#   PHANTOM_ISLAND_AUTOSTART=0   leave the systemd user unit disabled
#   PHANTOM_ISLAND_KWIN_RULE=1   also install the KWin "keep above" fallback
#                                rule (reversible — see uninstall notes below)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ISLAND_DIR="$ROOT/island"
BIN_DIR="$HOME/.local/bin"
APPLICATIONS_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
ICON_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/256x256/apps"
AUTOSTART_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/autostart"
DESKTOP_ID="phantom-island.desktop"
BINARY_NAME="phantom-island"

if [[ ! -d "$ISLAND_DIR/src-tauri" ]]; then
  echo "error: $ISLAND_DIR/src-tauri not found — run this from the agent-control-center checkout" >&2
  exit 1
fi

for tool in cargo npm; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "error: '$tool' is required but not on PATH" >&2
    exit 1
  fi
done

missing_libs=()
for pc in webkit2gtk-4.1 gtk+-3.0 dbus-1; do
  pkg-config --exists "$pc" 2>/dev/null || missing_libs+=("$pc")
done
# Fedora ships libappindicator (appindicator3-0.1); Debian/Ubuntu ship Ayatana.
pkg-config --exists ayatana-appindicator3-0.1 2>/dev/null \
  || pkg-config --exists appindicator3-0.1 2>/dev/null \
  || missing_libs+=("appindicator3-0.1")
if [[ ${#missing_libs[@]} -gt 0 ]]; then
  echo "error: missing system libraries for the Tauri build: ${missing_libs[*]}" >&2
  echo "  sudo dnf install webkit2gtk4.1-devel gtk3-devel libsoup3-devel dbus-devel libappindicator-gtk3-devel librsvg2-devel" >&2
  exit 1
fi

echo "==> Building the frontend (npm)"
(cd "$ISLAND_DIR" && npm ci && npm run build)

echo "==> Generating icons"
if command -v magick >/dev/null 2>&1; then
  node "$ISLAND_DIR/scripts/gen-icons.mjs" || echo "warning: icon generation failed, keeping whatever is in src-tauri/icons/" >&2
else
  echo "warning: ImageMagick ('magick') not found — skipping icon regeneration" >&2
fi

echo "==> Building the Rust backend (release)"
(cd "$ISLAND_DIR/src-tauri" && cargo build --release)

# The crate lives in src-tauri/, but island/Cargo.toml is the workspace
# root, so cargo always places build output under island/target/ regardless
# of which member directory the build was invoked from.
BUILT_BIN="$ISLAND_DIR/target/release/$BINARY_NAME"
if [[ ! -x "$BUILT_BIN" ]]; then
  echo "error: build did not produce $BUILT_BIN" >&2
  exit 1
fi

echo "==> Installing to $BIN_DIR/$BINARY_NAME"
install -d -m 755 "$BIN_DIR"
install -m 755 "$BUILT_BIN" "$BIN_DIR/$BINARY_NAME"

echo "==> Installing icon and .desktop launcher"
install -d -m 755 "$APPLICATIONS_DIR" "$ICON_DIR"
ICON_SRC="$ISLAND_DIR/src-tauri/icons/icon.png"
if [[ -f "$ICON_SRC" ]]; then
  install -m 644 "$ICON_SRC" "$ICON_DIR/phantom-island.png"
fi

cat >"$APPLICATIONS_DIR/$DESKTOP_ID" <<EOF
[Desktop Entry]
Type=Application
Name=Phantom Island
Comment=Live view of your Phantom agent sessions at the top of the screen
Exec=$BIN_DIR/$BINARY_NAME
Icon=phantom-island
Terminal=false
Categories=Utility;Development;
StartupNotify=false
NoDisplay=false
EOF
chmod 644 "$APPLICATIONS_DIR/$DESKTOP_ID"

UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
# Older installs used an XDG autostart entry; the supervised unit replaces it.
rm -f "$AUTOSTART_DIR/$DESKTOP_ID"
if [[ "${PHANTOM_ISLAND_AUTOSTART:-1}" == "1" ]]; then
  echo "==> Installing the supervised user unit (starts with Plasma, restarts on crash)"
  install -d -m 755 "$UNIT_DIR"
  install -m 755 "$ISLAND_DIR/scripts/wait-session.sh" "$BIN_DIR/phantom-island-wait-session"
  install -m 644 "$ROOT/integrations/systemd/phantom-island.service" "$UNIT_DIR/phantom-island.service"
  systemctl --user daemon-reload
  systemctl --user enable phantom-island.service >/dev/null
  systemctl --user restart phantom-island.service || true
else
  echo "==> PHANTOM_ISLAND_AUTOSTART=0 — disabling the user unit"
  systemctl --user disable --now phantom-island.service >/dev/null 2>&1 || true
fi

if [[ "${PHANTOM_ISLAND_KWIN_RULE:-0}" == "1" ]]; then
  if command -v kwriteconfig6 >/dev/null 2>&1; then
    echo "==> Installing KWin window rule fallback (keep above / skip taskbar-pager-switcher / no border)"
    RULE_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/kwinrulesrc"
    RULE_GROUP="phantom-island-rule"
    # Append to the existing rule list instead of replacing the user's rules.
    existing=$(kreadconfig6 --file "$RULE_FILE" --group "General" --key "rules" 2>/dev/null || true)
    case ",$existing," in
      *",$RULE_GROUP,"*) rules="$existing" ;;
      ",,") rules="$RULE_GROUP" ;;
      *) rules="$existing,$RULE_GROUP" ;;
    esac
    count=$(awk -F, '{print NF}' <<<"$rules")
    kwriteconfig6 --file "$RULE_FILE" --group "General" --key "rules" "$rules"
    kwriteconfig6 --file "$RULE_FILE" --group "General" --key "count" "$count"
    kwriteconfig6 --file "$RULE_FILE" --group "$RULE_GROUP" --key "Description" "Phantom Island"
    kwriteconfig6 --file "$RULE_FILE" --group "$RULE_GROUP" --key "wmclass" "phantom-island"
    kwriteconfig6 --file "$RULE_FILE" --group "$RULE_GROUP" --key "wmclassmatch" "1"
    kwriteconfig6 --file "$RULE_FILE" --group "$RULE_GROUP" --key "above" "true"
    kwriteconfig6 --file "$RULE_FILE" --group "$RULE_GROUP" --key "aboverule" "2"
    kwriteconfig6 --file "$RULE_FILE" --group "$RULE_GROUP" --key "skiptaskbar" "true"
    kwriteconfig6 --file "$RULE_FILE" --group "$RULE_GROUP" --key "skiptaskbarrule" "2"
    kwriteconfig6 --file "$RULE_FILE" --group "$RULE_GROUP" --key "skippager" "true"
    kwriteconfig6 --file "$RULE_FILE" --group "$RULE_GROUP" --key "skippagerrule" "2"
    kwriteconfig6 --file "$RULE_FILE" --group "$RULE_GROUP" --key "skipswitcher" "true"
    kwriteconfig6 --file "$RULE_FILE" --group "$RULE_GROUP" --key "skipswitcherrule" "2"
    kwriteconfig6 --file "$RULE_FILE" --group "$RULE_GROUP" --key "noborder" "true"
    kwriteconfig6 --file "$RULE_FILE" --group "$RULE_GROUP" --key "noborderrule" "2"
    if command -v qdbus6 >/dev/null 2>&1; then
      qdbus6 org.kde.KWin /KWin reconfigure >/dev/null 2>&1 || true
    fi
    echo "    (reversible: delete the [$RULE_GROUP] group from $RULE_FILE, or use KWin's Window Rules settings page)"
  else
    echo "warning: PHANTOM_ISLAND_KWIN_RULE=1 but 'kwriteconfig6' is not available — skipping" >&2
  fi
fi

echo ""
echo "Phantom Island installed: $BIN_DIR/$BINARY_NAME"
echo "Launch it from the application menu, or run it directly."
