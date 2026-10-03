// Phantom Island for Linux — app wiring and the commands the island calls.
//
// Based on the MIT-licensed Coucou for Windows/macOS by Louis Raillé
// (github.com/louis-cfm/coucou). The character, name, icons and sounds are
// not part of that license and have been replaced; see README.md.

mod chat;
mod files;
mod integrations;
mod island;
mod log;
mod phantom;
mod secrets;
mod settings;
mod tray;
mod util;

use std::process::Command;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

use files::DroppedFile;
use island::{PollGate, ScreenInfo};
use phantom::PhantomState;
use settings::Settings;

pub struct Shared {
    pub settings: Mutex<Settings>,
    pub gate: Arc<PollGate>,
    pub phantom: Arc<PhantomState>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootInfo {
    settings: Settings,
    screen: ScreenInfo,
    version: String,
    /// Always empty on Linux — see BRIDGE.md "Removed": there is no hook
    /// relay binary anymore, Phantom replaces it entirely.
    hook_path: String,
}

#[tauri::command]
fn boot(app: AppHandle, shared: State<Shared>) -> BootInfo {
    let settings = shared.settings.lock().unwrap().clone();
    let screen = island::screen_info(&app, &settings.screen);
    BootInfo { settings, screen, version: env!("CARGO_PKG_VERSION").to_string(), hook_path: String::new() }
}

#[tauri::command]
fn save_settings(app: AppHandle, shared: State<Shared>, mut settings: Settings) {
    // The front end doesn't track the defaults generation; never let a save
    // send it back to 0 (that would re-run the migration on next start).
    settings.settings_version = settings::SETTINGS_VERSION;
    let (screen_changed, autostart_changed) = {
        let mut current = shared.settings.lock().unwrap();
        let screen_changed = current.screen != settings.screen;
        let autostart_changed = current.autostart != settings.autostart;
        *current = settings.clone();
        (screen_changed, autostart_changed)
    };
    if let Err(err) = settings::save(&settings) {
        eprintln!("[phantom-island] could not save settings: {err}");
    }
    if autostart_changed {
        // Login start is the supervised systemd user unit installed by
        // scripts/install-island.sh (tied to plasma-workspace.target), not an
        // XDG autostart entry — so toggle that unit instead of adding a second
        // launcher. `--now` is omitted: this very process is that unit.
        let verb = if settings.autostart { "enable" } else { "disable" };
        if let Err(err) = std::process::Command::new("systemctl")
            .args(["--user", verb, "phantom-island.service"])
            .status()
        {
            eprintln!("[phantom-island] autostart: {err}");
        }
    }
    if screen_changed {
        let collapsed = shared.gate.collapsed.load(Ordering::Relaxed);
        island::apply_geometry(&app, &settings.screen, collapsed);
    }
    let _ = app.emit("settings-changed", settings);
}

#[tauri::command]
fn set_collapsed(app: AppHandle, shared: State<Shared>, collapsed: bool) {
    let pref = shared.settings.lock().unwrap().screen.clone();
    shared.gate.collapsed.store(collapsed, Ordering::Relaxed);
    island::apply_geometry(&app, &pref, collapsed);
    island::set_ignore_cursor(&app, false);
    shared.gate.forget_ignore_state();
    shared.gate.set_active(!collapsed);
    let rect = if collapsed { None } else { Some(*shared.gate.rect.lock().unwrap()) };
    island::apply_input_shape(&app, rect);
}

#[tauri::command]
fn set_island_rect(app: AppHandle, shared: State<Shared>, x: f64, y: f64, width: f64, height: f64) {
    let rect = island::IslandRect { x, y, w: width, h: height };
    shared.gate.set_rect(rect);
    if !shared.gate.collapsed.load(Ordering::Relaxed) {
        island::apply_input_shape(&app, Some(rect));
    }
}

#[tauri::command]
fn focus_window(app: AppHandle, focused: bool) {
    let Some(win) = island::window(&app) else { return };
    island::set_activating(&win, focused);
    if focused {
        let _ = win.set_focus();
    }
}

#[tauri::command]
fn reposition(app: AppHandle, shared: State<Shared>) {
    let pref = shared.settings.lock().unwrap().screen.clone();
    let collapsed = shared.gate.collapsed.load(Ordering::Relaxed);
    island::apply_geometry(&app, &pref, collapsed);
}

#[tauri::command]
fn open_url(url: String) {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return;
    }
    let _ = Command::new("xdg-open").arg(url).spawn();
}

/// "Open terminal" opens the working folder in VS Code when `code` is on
/// PATH, and falls back to the desktop's own file manager via `xdg-open`.
#[tauri::command]
fn open_in_vscode(path: Option<String>) -> bool {
    if let Ok(code) = which_on_path("code") {
        let mut cmd = Command::new(code);
        if let Some(p) = path.as_deref().filter(|p| !p.is_empty()) {
            cmd.arg(p);
        }
        if cmd.spawn().is_ok() {
            return true;
        }
    }
    if let Some(p) = path.as_deref().filter(|p| !p.is_empty()) {
        let _ = Command::new("xdg-open").arg(p).spawn();
    }
    false
}

fn which_on_path(stem: &str) -> Result<std::path::PathBuf, ()> {
    let dirs = std::env::var_os("PATH").ok_or(())?;
    for dir in std::env::split_paths(&dirs) {
        let candidate = dir.join(stem);
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err(())
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn set_paused(paused: bool) {
    integrations::set_paused(paused);
}

// ── Phantom ──────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PhantomStatus {
    connected: bool,
    version: Option<String>,
    agents: Vec<phantom::AgentSummary>,
}

#[tauri::command]
async fn phantom_status(shared: State<'_, Shared>) -> Result<PhantomStatus, String> {
    let connected = shared.phantom.connected.load(Ordering::Relaxed);
    Ok(PhantomStatus { connected, version: None, agents: Vec::new() })
}

#[tauri::command]
async fn phantom_sessions(shared: State<'_, Shared>) -> Result<Vec<Value>, String> {
    let rest = shared.phantom.rest.lock().await.clone();
    let raw = match rest {
        Some(rest) => rest.list_connections().await?,
        None => return Ok(Vec::new()),
    };
    // Phantom answers `{id, agent_type, status}`; the island speaks the
    // BRIDGE.md shape, enriched with what the event feed already learned.
    let known = shared.phantom.sessions.lock().await.clone();
    Ok(raw.iter().filter_map(|c| phantom::session_to_bridge(c, &known)).collect())
}

#[tauri::command]
async fn phantom_respond_permission(
    shared: State<'_, Shared>,
    connection_id: String,
    request_id: String,
    option_id: String,
) -> Result<(), String> {
    let rest = shared.phantom.rest.lock().await.clone().ok_or_else(|| "Phantom not connected".to_string())?;
    rest.respond_permission(&connection_id, &request_id, &option_id).await
}

#[tauri::command]
async fn phantom_scorecard(shared: State<'_, Shared>) -> Result<Value, String> {
    let rest = shared.phantom.rest.lock().await.clone().ok_or_else(|| "Phantom not connected".to_string())?;
    rest.model_scorecard().await
}

#[tauri::command]
async fn phantom_successor(
    shared: State<'_, Shared>,
    agent_type: String,
    model: Option<String>,
    conversation_id: Option<i32>,
) -> Result<Value, String> {
    let rest = shared.phantom.rest.lock().await.clone().ok_or_else(|| "Phantom not connected".to_string())?;
    rest.phantom_successor(&agent_type, model.as_deref(), conversation_id).await
}

#[tauri::command]
async fn phantom_handoff(
    shared: State<'_, Shared>,
    conversation_id: i32,
    target_agent_type: String,
    target_model: Option<String>,
) -> Result<Value, String> {
    let rest = shared.phantom.rest.lock().await.clone().ok_or_else(|| "Phantom not connected".to_string())?;
    rest.phantom_handoff(conversation_id, &target_agent_type, target_model.as_deref()).await
}

// ── Chat, files and secrets ───────────────────────────────────────────────

#[tauri::command]
async fn island_chat_send(
    shared: State<'_, Shared>,
    text: String,
    attachments: Vec<String>,
    agent_type: Option<String>,
) -> Result<(), String> {
    chat::send(&shared.phantom, &shared.settings, agent_type, text, attachments).await
}

#[tauri::command]
fn island_chat_reset(shared: State<Shared>) {
    chat::reset(&shared.phantom, &shared.settings);
}

/// Kept as an alias so a frontend build that still calls the old name does
/// not break (see BRIDGE.md).
#[tauri::command]
fn chat_reset(shared: State<Shared>) {
    chat::reset(&shared.phantom, &shared.settings);
}

#[tauri::command]
async fn island_file_ask(
    shared: State<'_, Shared>,
    path: String,
    question: String,
    agent_type: Option<String>,
) -> Result<(), String> {
    let ingested = files::ingest(&path).unwrap_or(DroppedFile { name: path.clone(), path: path.clone(), size: 0 });
    chat::send(&shared.phantom, &shared.settings, agent_type, question, vec![ingested.path]).await
}

#[tauri::command]
fn ingest_file(path: String) -> Result<DroppedFile, String> {
    files::ingest(&path)
}

#[tauri::command]
fn secret_present(key: String) -> bool {
    secrets::present(&key)
}

#[tauri::command]
fn secret_set(key: String, value: String) -> Result<(), String> {
    secrets::set(&key, &value)
}

#[tauri::command]
fn secret_clear(key: String) -> Result<(), String> {
    secrets::clear(&key)
}

#[tauri::command]
fn open_n8n() {
    if let Some(url) = secrets::get("n8n-url") {
        open_url(url);
    }
}

#[tauri::command]
async fn refresh_integration(app: AppHandle, id: String) {
    integrations::poll_once(app, &id).await;
}

#[tauri::command]
fn log_line(message: String) {
    log::line(format!("ui  {message}"));
}

// ── Voice (local speech service on 127.0.0.1:3091) ────────────────────────

const VOICE_BASE: &str = "http://127.0.0.1:3091";

fn voice_token() -> Option<String> {
    phantom::load_config().map(|c| c.token)
}

#[tauri::command]
async fn voice_health() -> bool {
    let Some(token) = voice_token() else { return false };
    let client = reqwest::Client::new();
    client
        .post(format!("{VOICE_BASE}/health"))
        .bearer_auth(token)
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

#[tauri::command]
async fn voice_stt(bytes: Vec<u8>, mime: String) -> Result<Value, String> {
    let token = voice_token().ok_or_else(|| "Phantom token not available".to_string())?;
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{VOICE_BASE}/stt"))
        .bearer_auth(token)
        .header("content-type", mime)
        .body(bytes)
        .send()
        .await
        .map_err(|e| format!("voice service unreachable: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("voice_stt failed: {}", resp.status()));
    }
    resp.json().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn voice_tts(text: String, lang: String) -> Result<Value, String> {
    let token = voice_token().ok_or_else(|| "Phantom token not available".to_string())?;
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{VOICE_BASE}/tts"))
        .bearer_auth(token)
        .json(&json!({ "text": text, "lang": lang }))
        .send()
        .await
        .map_err(|e| format!("voice service unreachable: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("voice_tts failed: {}", resp.status()));
    }
    // phantom-voice answers with the WAV itself (audio/wav), not JSON; the
    // frontend plays it from a data: URL.
    use base64::Engine as _;
    let wav = resp.bytes().await.map_err(|e| e.to_string())?;
    Ok(json!({ "wavBase64": base64::engine::general_purpose::STANDARD.encode(&wav) }))
}

// ── Settings window ───────────────────────────────────────────────────────

fn settings_page_url(app: &AppHandle) -> WebviewUrl {
    #[cfg(dev)]
    if let Some(mut base) = app.config().build.dev_url.clone() {
        base.set_path("/settings.html");
        return WebviewUrl::External(base);
    }
    let _ = app;
    WebviewUrl::App("settings.html".into())
}

fn create_settings_window(app: &AppHandle) {
    let url = settings_page_url(app);
    match WebviewWindowBuilder::new(app, "settings", url)
        .title("Configuración — Phantom Island")
        .inner_size(560.0, 680.0)
        .min_inner_size(460.0, 480.0)
        .resizable(true)
        .visible(false)
        .center()
        .build()
    {
        // Closing destroys it: an idle hidden webview costs ~190 MB, so the
        // window is built on demand (see `show_settings_window`) instead.
        Ok(_) => {}
        Err(err) => log::line(format!("settings window failed: {err}")),
    }
}

pub fn show_settings_window(app: &AppHandle) {
    if app.get_webview_window("settings").is_none() {
        create_settings_window(app);
    }
    let Some(win) = app.get_webview_window("settings") else {
        log::line("settings window missing");
        return;
    };
    let _ = win.unminimize();
    let _ = win.show();
    let _ = win.set_focus();
}

#[tauri::command]
async fn open_settings_window(app: AppHandle) {
    // Async so the window is built off the IPC thread (a sync command that
    // creates a webview can deadlock on Linux/WebKitGTK).
    show_settings_window(&app);
}

pub fn run() {
    let loaded = settings::load();
    let gate = Arc::new(PollGate::new());
    let phantom_state = Arc::new(PhantomState::default());

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            let _ = app.emit_to(island::WINDOW_LABEL, "tray", "open".to_string());
        }))
        .manage(Shared { settings: Mutex::new(loaded.clone()), gate: gate.clone(), phantom: phantom_state.clone() })
        .invoke_handler(tauri::generate_handler![
            boot,
            save_settings,
            set_collapsed,
            set_island_rect,
            focus_window,
            reposition,
            open_url,
            open_in_vscode,
            quit_app,
            log_line,
            island_chat_send,
            island_chat_reset,
            chat_reset,
            island_file_ask,
            ingest_file,
            secret_present,
            secret_set,
            secret_clear,
            refresh_integration,
            open_n8n,
            open_settings_window,
            set_paused,
            phantom_status,
            phantom_sessions,
            phantom_respond_permission,
            phantom_scorecard,
            phantom_successor,
            phantom_handoff,
            voice_health,
            voice_stt,
            voice_tts,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            tray::build(&handle)?;

            let layer = island::init_layer_shell(&handle, &loaded.screen);
            if let Some(win) = island::window(&handle) {
                island::enable_microphone(&win);
                island::make_non_activating(&win);
                island::apply_geometry(&handle, &loaded.screen, false);
                let _ = win.show();
            }
            gate.collapsed.store(false, Ordering::Relaxed);
            gate.set_active(true);
            // Under layer-shell the webview gets real enter/leave/motion
            // events; the X11 pointer poll is only for the XWayland fallback.
            if !layer {
                island::spawn_cursor_poll(handle.clone(), gate.clone());
            }
            log::line(if layer { "window: native Wayland layer-shell" } else { "window: X11/XWayland fallback" });

            log::line(format!("--- Phantom Island {} started ---", env!("CARGO_PKG_VERSION")));
            integrations::start(handle.clone());
            phantom::start(handle.clone(), phantom_state.clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Phantom Island");
}
