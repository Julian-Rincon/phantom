// Island window: placement on the chosen display, the two window sizes
// (full panel / invisible wake strip), click-through and the cursor poll.
//
// There is no notch on a PC, so the island is a black shape drawn at the top
// centre of the main display inside a borderless, transparent, always-on-top
// window that never takes focus.
//
// ── Placement on Plasma (read this before touching placement code) ───────
//
// Wayland gives an ordinary client no way to place itself at absolute
// screen coordinates, so on Plasma the island is a native **layer-shell**
// surface instead (`init_layer_shell`): the same protocol Plasma's own
// panels use. KWin anchors it to the top edge of the chosen monitor, keeps
// it above windows on the `Top` layer and never lists it in the task bar.
// Clicks only land where the input region says (`apply_input_shape`): the
// thin `STRIP_W`×`STRIP_H` wake strip while collapsed, the island rectangle
// while expanded. Hover arrives as ordinary DOM pointer events, so there is
// no cursor polling on this path.
//
// `PHANTOM_ISLAND_X11=1` keeps the old XWayland path as a fallback for
// compositors without layer-shell: a borderless always-on-top X11 window
// positioned with `set_position`, an X SHAPE input region, and the
// `XQueryPointer` poll (which only sees the pointer over XWayland surfaces).
//
// Multi-monitor: `target_monitor` always resolves against
// `app.primary_monitor()` for `pref == "primary"`; the user has two
// screens, so this matters and is exercised by `screen_info`/`apply_geometry`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Monitor, PhysicalPosition, PhysicalSize, WebviewWindow};

/// Logical size of the full window — the largest island view, like the macOS panel.
pub const PANEL_W: f64 = 720.0;
pub const PANEL_H: f64 = 320.0;
/// Logical size of the invisible-ish strip that wakes the island when it is
/// hidden. This is the hot-zone window described in the module docs above:
/// a real, always-on-top, nearly-transparent window a WM/compositor always
/// delivers enter events to, independent of the XWayland pointer-query gap.
pub const STRIP_W: f64 = 360.0;
pub const STRIP_H: f64 = 3.0;

pub const WINDOW_LABEL: &str = "island";

/// Margin around the island that still counts as "on the island", in logical px.
const HIT_MARGIN: f64 = 14.0;

#[derive(Serialize, Clone)]
pub struct CursorPayload {
    pub x: f64,
    pub y: f64,
}

#[derive(Serialize, Clone)]
pub struct ScreenInfo {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub scale: f64,
}

/// The island shape in window-logical coordinates, pushed by the front end.
/// The poll thread owns the click-through decision so it lands in the same
/// tick as the cursor read.
#[derive(Clone, Copy, Default)]
pub struct IslandRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Wakes / parks the cursor poll thread so a hidden island costs literally nothing.
pub struct PollGate {
    active: Mutex<bool>,
    cv: Condvar,
    pub collapsed: AtomicBool,
    pub rect: Mutex<IslandRect>,
    /// Mirrors the window flag so we only call into the backend when it changes.
    ignoring: AtomicBool,
}

impl PollGate {
    pub fn new() -> Self {
        Self {
            active: Mutex::new(false),
            cv: Condvar::new(),
            collapsed: AtomicBool::new(true),
            rect: Mutex::new(IslandRect::default()),
            ignoring: AtomicBool::new(false),
        }
    }

    pub fn set_rect(&self, rect: IslandRect) {
        *self.rect.lock().unwrap() = rect;
    }

    pub fn forget_ignore_state(&self) {
        self.ignoring.store(false, Ordering::Relaxed);
    }

    pub fn set_active(&self, on: bool) {
        let mut guard = self.active.lock().unwrap();
        *guard = on;
        self.cv.notify_all();
    }

    fn wait_until_active(&self) {
        let mut guard = self.active.lock().unwrap();
        while !*guard {
            guard = self.cv.wait(guard).unwrap();
        }
    }

    fn is_active(&self) -> bool {
        *self.active.lock().unwrap()
    }
}

pub fn window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(WINDOW_LABEL)
}

/// True when the island runs as a native Wayland layer-shell surface (Plasma's
/// own mechanism for panels and docks) instead of an XWayland window.
pub static LAYER_SHELL: AtomicBool = AtomicBool::new(false);

pub fn layer_shell() -> bool {
    LAYER_SHELL.load(Ordering::Relaxed)
}

/// Turn the island window into a layer-shell surface anchored to the top edge
/// of the target monitor, in the `Top` layer (above windows, below fullscreen
/// apps such as games), ignoring other exclusive zones so it sits flush with
/// the screen edge like a notch. Must run on the main thread during setup.
/// Returns false (and changes nothing) when the compositor lacks layer-shell.
pub fn init_layer_shell(app: &AppHandle, pref: &str) -> bool {
    use gtk::prelude::*;
    use gtk_layer_shell::{Edge, KeyboardMode, Layer, LayerShell};
    if std::env::var_os("WAYLAND_DISPLAY").is_none() || !gtk_layer_shell::is_supported() {
        return false;
    }
    let Some(win) = window(app) else { return false };
    let Ok(gw) = win.gtk_window() else { return false };
    // Layer-shell must be set up on an unmapped, unrealized window.
    gw.hide();
    if gw.is_realized() {
        gw.unrealize();
    }
    gw.init_layer_shell();
    gw.set_namespace("phantom-island");
    gw.set_layer(Layer::Top);
    gw.set_anchor(Edge::Top, true);
    gw.set_exclusive_zone(-1);
    gw.set_keyboard_mode(KeyboardMode::OnDemand);
    if let Some(m) = gdk_monitor_for(app, pref) {
        gw.set_monitor(&m);
    }
    gw.show();
    LAYER_SHELL.store(true, Ordering::Relaxed);
    true
}

/// The GDK monitor matching Tauri's target monitor (by logical geometry).
fn gdk_monitor_for(app: &AppHandle, pref: &str) -> Option<gtk::gdk::Monitor> {
    use gtk::prelude::*;
    let target = target_monitor(app, pref)?;
    let scale = target.scale_factor();
    let tx = (target.position().x as f64 / scale).round() as i32;
    let ty = (target.position().y as f64 / scale).round() as i32;
    let display = gtk::gdk::Display::default()?;
    (0..display.n_monitors())
        .filter_map(|i| display.monitor(i))
        .find(|m| {
            let g = m.geometry();
            g.x() == tx && g.y() == ty
        })
        .or_else(|| display.primary_monitor())
}

fn monitor_contains(m: &Monitor, x: f64, y: f64) -> bool {
    let p = m.position();
    let s = m.size();
    x >= p.x as f64
        && x < (p.x + s.width as i32) as f64
        && y >= p.y as f64
        && y < (p.y + s.height as i32) as f64
}

/// The display the island lives on: the primary one, or the one under the cursor.
fn target_monitor(app: &AppHandle, pref: &str) -> Option<Monitor> {
    let monitors = app.available_monitors().ok()?;
    if pref == "cursor" {
        if let Some((cx, cy)) = x11::cursor_physical() {
            if let Some(m) = monitors.iter().find(|m| monitor_contains(m, cx, cy)) {
                return Some(m.clone());
            }
        }
    }
    app.primary_monitor().ok().flatten().or_else(|| monitors.into_iter().next())
}

pub fn screen_info(app: &AppHandle, pref: &str) -> ScreenInfo {
    match target_monitor(app, pref) {
        Some(m) => {
            let scale = m.scale_factor();
            let p = m.position();
            let s = m.size();
            ScreenInfo {
                x: p.x as f64 / scale,
                y: p.y as f64 / scale,
                width: s.width as f64 / scale,
                height: s.height as f64 / scale,
                scale,
            }
        }
        None => ScreenInfo { x: 0.0, y: 0.0, width: 1920.0, height: 1080.0, scale: 1.0 },
    }
}

/// Places and sizes the window. `collapsed` picks the wake strip instead of the panel.
pub fn apply_geometry(app: &AppHandle, pref: &str, collapsed: bool) {
    let Some(win) = window(app) else { return };
    let Some(m) = target_monitor(app, pref) else { return };

    let scale = m.scale_factor();
    let mp = *m.position();
    let ms = *m.size();

    let (lw, lh) = if collapsed { (STRIP_W, STRIP_H) } else { (PANEL_W, PANEL_H) };
    let pw = (lw * scale).round().max(1.0) as u32;
    let ph = (lh * scale).round().max(1.0) as u32;
    let x = mp.x + (ms.width as i32 - pw as i32) / 2;
    let y = mp.y;

    if layer_shell() {
        // The compositor places a layer surface from its anchors; only the
        // size and the output are ours to set.
        use gtk::prelude::*;
        use gtk_layer_shell::LayerShell;
        if let Ok(gw) = win.gtk_window() {
            if let Some(gm) = gdk_monitor_for(app, pref) {
                gw.set_monitor(&gm);
            }
            gw.set_size_request(lw as i32, lh as i32);
            gw.resize(lw as i32, lh as i32);
        }
        let _ = (x, y);
        return;
    }

    let _ = win.set_size(PhysicalSize::new(pw, ph));
    let _ = win.set_position(PhysicalPosition::new(x, y));
    // Moving across displays can rescale the window: re-assert the physical size.
    let _ = win.set_size(PhysicalSize::new(pw, ph));
    let _ = win.set_always_on_top(true);
}

/// WS_EX_NOACTIVATE's X11 analogue: set ICCCM `WM_HINTS.input = False` so the
/// window manager never gives this window input focus on click, plus the EWMH
/// `_NET_WM_STATE` atoms for skip-taskbar/pager (tauri's `skip_taskbar: true`
/// in tauri.conf.json already requests these through the GTK layer; this is
/// belt-and-braces for window managers — KWin included — that only honour
/// the ICCCM hint reliably).
pub fn make_non_activating(win: &WebviewWindow) {
    if layer_shell() {
        return; // keyboard interactivity is the layer surface's OnDemand mode
    }
    x11::set_input_hint(win, false);
}

/// Temporarily allow activation so a text field inside the island can be typed in.
pub fn set_activating(win: &WebviewWindow, activating: bool) {
    if layer_shell() {
        return;
    }
    x11::set_input_hint(win, activating);
}

fn current_screen_key(app: &AppHandle) -> Option<(i32, i32, u32, u32, u64)> {
    let pref = app
        .try_state::<crate::Shared>()
        .map(|s| s.settings.lock().unwrap().screen.clone())
        .unwrap_or_else(|| "primary".into());
    let m = target_monitor(app, &pref)?;
    let p = m.position();
    let size = m.size();
    Some((p.x, p.y, size.width, size.height, m.scale_factor().to_bits()))
}

/// Emits `cursor` (window-logical coordinates) at ~60 Hz while the island is
/// visible. Parked on a condvar the rest of the time. See the module-level
/// doc comment for what this poll can and can't see on Wayland.
pub fn spawn_cursor_poll(app: AppHandle, gate: Arc<PollGate>) {
    std::thread::spawn(move || {
        let mut last_screen: Option<(i32, i32, u32, u32, u64)> = None;
        loop {
            gate.wait_until_active();
            let mut last = (f64::MIN, f64::MIN);
            let mut ticks: u32 = 0;
            while gate.is_active() {
                std::thread::sleep(Duration::from_millis(16));

                ticks = ticks.wrapping_add(1);
                if ticks.is_multiple_of(30) {
                    let now = current_screen_key(&app);
                    if now.is_some() && now != last_screen {
                        let first = last_screen.is_none();
                        last_screen = now;
                        if !first {
                            crate::log::line("display layout changed — repositioning");
                            let _ = app.emit_to(WINDOW_LABEL, "screen-changed", ());
                        }
                    }
                }

                let Some(win) = window(&app) else { continue };
                let Ok(origin) = win.outer_position() else { continue };
                let scale = win.scale_factor().unwrap_or(1.0);
                let Some((cx, cy, buttons)) = x11::cursor_physical_and_buttons() else { continue };
                let x = (cx - origin.x as f64) / scale;
                let y = (cy - origin.y as f64) / scale;
                let size = match win.inner_size() {
                    Ok(s) => (s.width as f64 / scale, s.height as f64 / scale),
                    Err(_) => (PANEL_W, PANEL_H),
                };
                if (x - last.0).abs() < 1.0 && (y - last.1).abs() < 1.0 {
                    continue;
                }
                last = (x, y);

                let r = *gate.rect.lock().unwrap();
                let on_island = r.w > 0.0
                    && x >= r.x - HIT_MARGIN
                    && x <= r.x + r.w + HIT_MARGIN
                    && y >= r.y - HIT_MARGIN
                    && y <= r.y + r.h + HIT_MARGIN;

                // A file being dragged has to be able to find us: while a
                // button is held anywhere over the panel, the whole panel
                // takes the mouse. WebKitGTK handles HTML5 drag-and-drop
                // itself (no OLE drop-target dance like the Win32 port
                // needed), so this is the only drag-related logic left.
                let dragging = buttons && x >= 0.0 && x <= size.0 && y >= 0.0 && y <= size.1;

                // Click-through is done with an X11 input shape (see
                // `apply_input_shape`), not by toggling ignore-cursor: once a
                // window ignores the pointer under XWayland it never sees it
                // again, so it could never turn input back on.
                let _ = (on_island, dragging);

                let _ = win.emit("cursor", CursorPayload { x, y });
            }
        }
    });
}

pub fn set_ignore_cursor(app: &AppHandle, ignore: bool) {
    if let Some(win) = window(app) {
        let _ = win.set_ignore_cursor_events(ignore);
    }
}

/// Restrict the window's input region to the visible island (window-logical
/// rect plus `HIT_MARGIN`), so clicks inside always reach the island and clicks
/// on the transparent rest of the window fall through to what is underneath.
/// `None` makes the whole window clickable (the collapsed wake strip).
pub fn apply_input_shape(app: &AppHandle, rect: Option<IslandRect>) {
    let Some(win) = window(app) else { return };
    if layer_shell() {
        // Native Wayland input region (wl_surface.set_input_region), in
        // logical pixels.
        use gtk::prelude::*;
        let Ok(gw) = win.gtk_window() else { return };
        let Some(gdk_win) = gw.window() else { return };
        let (w, h) = (gdk_win.width(), gdk_win.height());
        let r = match rect {
            Some(r) if r.w > 0.0 && r.h > 0.0 => {
                let x0 = (r.x - HIT_MARGIN).max(0.0).floor() as i32;
                let x1 = ((r.x + r.w + HIT_MARGIN).ceil() as i32).min(w);
                let y1 = ((r.y + r.h + HIT_MARGIN).ceil() as i32).min(h);
                gtk::cairo::RectangleInt::new(x0, 0, (x1 - x0).max(1), y1.max(1))
            }
            _ => gtk::cairo::RectangleInt::new(0, 0, w.max(1), h.max(1)),
        };
        let region = gtk::cairo::Region::create_rectangle(&r);
        gdk_win.input_shape_combine_region(&region, 0, 0);
        return;
    }
    let scale = win.scale_factor().unwrap_or(1.0);
    let Ok(size) = win.inner_size() else { return };
    let (x, y, w, h) = match rect {
        Some(r) if r.w > 0.0 && r.h > 0.0 => {
            let x0 = ((r.x - HIT_MARGIN).max(0.0) * scale).floor();
            let y0 = ((r.y).max(0.0) * scale).floor();
            let x1 = ((r.x + r.w + HIT_MARGIN) * scale).ceil().min(size.width as f64);
            let y1 = ((r.y + r.h + HIT_MARGIN) * scale).ceil().min(size.height as f64);
            (x0, y0, (x1 - x0).max(1.0), (y1 - y0).max(1.0))
        }
        _ => (0.0, 0.0, size.width as f64, size.height as f64),
    };
    x11::set_input_rect(&win, x as i16, y as i16, w as u16, h as u16);
}

/// X11 (via XWayland) pointer polling and window-hint helpers. Everything
/// here degrades to "do nothing" rather than panicking when there is no X11
/// display at all (e.g. a pure-Wayland CI sandbox) — the window still
/// places itself once via `apply_geometry`, it just never click-throughs.
mod x11 {
    use std::sync::OnceLock;
    use tauri::WebviewWindow;
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::{self, Atom, ConnectionExt as _, InputFocus, Window};
    use x11rb::wrapper::ConnectionExt as _;
    use x11rb::rust_connection::RustConnection;

    struct X11 {
        conn: RustConnection,
        root: Window,
    }

    static X11_CONN: OnceLock<Option<X11>> = OnceLock::new();

    fn x11() -> Option<&'static X11> {
        X11_CONN
            .get_or_init(|| {
                let (conn, screen_num) = RustConnection::connect(None).ok()?;
                let root = conn.setup().roots[screen_num].root;
                Some(X11 { conn, root })
            })
            .as_ref()
    }

    /// Root-relative pointer position in physical pixels, or `None` if there
    /// is no X11 connection or the pointer is currently over a native-Wayland
    /// surface the X server can't see (see module docs).
    pub fn cursor_physical() -> Option<(f64, f64)> {
        let x = x11()?;
        let reply = x.conn.query_pointer(x.root).ok()?.reply().ok()?;
        if !reply.same_screen {
            return None;
        }
        Some((reply.root_x as f64, reply.root_y as f64))
    }

    /// Same as `cursor_physical`, plus whether button 1 is currently held —
    /// read from the same `QueryPointer` reply's modifier mask, avoiding a
    /// second round trip (the Win32 port polled `GetAsyncKeyState` separately;
    /// X11 hands both back in one call).
    pub fn cursor_physical_and_buttons() -> Option<(f64, f64, bool)> {
        let x = x11()?;
        let reply = x.conn.query_pointer(x.root).ok()?.reply().ok()?;
        if !reply.same_screen {
            return None;
        }
        // Raw X11 KeyButMask bit for button 1 (0x0100) — see the X11 protocol
        // spec §5 "Keyboard and Pointer Events". Avoids depending on x11rb's
        // `ButtonMask` enum repr, which varies across crate versions.
        const BUTTON1_MASK: u16 = 0x0100;
        let down = (u16::from(reply.mask) & BUTTON1_MASK) != 0;
        Some((reply.root_x as f64, reply.root_y as f64, down))
    }

    fn window_id(win: &WebviewWindow) -> Option<Window> {
        use raw_window_handle::{HasWindowHandle, RawWindowHandle};
        match win.window_handle().ok()?.as_raw() {
            RawWindowHandle::Xlib(h) => Some(h.window as Window),
            RawWindowHandle::Xcb(h) => Some(h.window.get()),
            _ => None, // native Wayland surface — nothing to set an X11 hint on
        }
    }

    /// Sets the window's SHAPE input region to one rectangle (physical px).
    pub fn set_input_rect(win: &WebviewWindow, x: i16, y: i16, w: u16, h: u16) {
        use x11rb::protocol::shape::{self, ConnectionExt as _};
        let Some(xc) = x11() else { return };
        let Some(window) = window_id(win) else { return };
        let rect = xproto::Rectangle { x, y, width: w, height: h };
        let _ = xc.conn.shape_rectangles(
            shape::SO::SET,
            shape::SK::INPUT,
            xproto::ClipOrdering::UNSORTED,
            window,
            0,
            0,
            &[rect],
        );
        let _ = xc.conn.flush();
    }

    fn wm_hints_atom(x: &X11) -> Option<Atom> {
        Some(x.conn.intern_atom(false, b"WM_HINTS").ok()?.reply().ok()?.atom)
    }

    /// Sets (or clears) ICCCM `WM_HINTS.input`. The property's wire layout is
    /// fixed by the ICCCM: `flags, input, initial_state, icon_pixmap,
    /// icon_window, icon_x, icon_y, icon_mask, window_group` — nine 32-bit
    /// words. `flags` bit 0 (`InputHint`) must be set for `input` to be read
    /// at all.
    pub fn set_input_hint(win: &WebviewWindow, accepts_input: bool) {
        let Some(x) = x11() else { return };
        let Some(window) = window_id(win) else { return };
        let Some(atom) = wm_hints_atom(x) else { return };

        const INPUT_HINT_FLAG: u32 = 1 << 0;
        let hints: [u32; 9] = [
            INPUT_HINT_FLAG,
            accepts_input as u32,
            u32::from(InputFocus::PARENT),
            0,
            0,
            0,
            0,
            0,
            0,
        ];
        let _ = x.conn.change_property32(
            xproto::PropMode::REPLACE,
            window,
            atom,
            xproto::AtomEnum::WM_HINTS,
            &hints,
        );
        let _ = x.conn.flush();
    }
}
