// "Talk to Phantom Island" — replaces the old direct-Anthropic-API chat
// (claude.rs) with one persistent ACP conversation routed through Phantom.
// The reply streams back as `island://chat-delta` / `island://chat-done` /
// `island://chat-error` events (see phantom.rs's `emit_mapped`, which
// mirrors the chat connection's own events into those channels), so the
// commands here are fire-and-forget from the frontend's point of view.

use std::sync::Arc;

use serde_json::Value;

use crate::phantom::PhantomState;
use crate::settings::Settings;

const DEFAULT_CHAT_AGENT: &str = "claude_code";
/// Only the agents the island shows ghosts for; anything else falls back.
const CHAT_AGENTS: &[&str] = &["claude_code", "open_code", "hermes"];

/// Sent once at the top of each new island conversation so the agent knows
/// where it lives and how to look at the desktop when asked.
const PREAMBLE: &str = "[Contexto de Phantom Island] Estás respondiendo desde la isla de Phantom, \
en el escritorio de Julian (Fedora, KDE Plasma 6 en Wayland). Responde breve y en español salvo que \
te escriban en otro idioma. Si te preguntan por lo que hay en pantalla, toma una captura con \
`spectacle -b -n -f -o /tmp/phantom-island-screen.png` (o `-a` para solo la ventana activa) y \
mírala con tu herramienta de lectura de imágenes antes de responder.";

fn home_dir() -> String {
    std::env::var("HOME").unwrap_or_else(|_| "/".to_string())
}

/// Starts (if needed) and continues the one persistent island conversation.
/// `attachments` are absolute paths already ingested via `ingest_file`; text
/// files under 200 KB are inlined into the prompt the same way the old
/// Anthropic client inlined file context. Every failure is logged and
/// returned so the frontend can show it instead of hanging on "thinking".
pub async fn send(
    state: &Arc<PhantomState>,
    _settings: &std::sync::Mutex<Settings>,
    agent_type: Option<String>,
    text: String,
    attachments: Vec<String>,
) -> Result<(), String> {
    let agent_type = agent_type
        .filter(|a| CHAT_AGENTS.contains(&a.as_str()))
        .unwrap_or_else(|| DEFAULT_CHAT_AGENT.to_string());
    let result = send_inner(state, &agent_type, &text, &attachments).await;
    if let Err(err) = &result {
        crate::log::line(format!("chat: send failed: {err}"));
    }
    result
}

async fn send_inner(state: &Arc<PhantomState>, agent_type: &str, text: &str, attachments: &[String]) -> Result<(), String> {
    let rest = state.rest.lock().await.clone().ok_or_else(|| "Phantom todavía no está conectado.".to_string())?;
    let prompt = build_prompt(text, attachments);

    // Phantom's idle sweep disconnects quiet connections after a few
    // minutes, so a remembered id may be gone: check it is still live.
    // Talking to a different ghost starts that agent's own conversation.
    let mut connection_id = state.chat_connection_id.lock().await.clone();
    if *state.chat_agent_type.lock().await != agent_type {
        if let Some(old) = connection_id.take() {
            let _ = rest.acp_disconnect(&old).await;
        }
    }
    if let Some(id) = &connection_id {
        let live = rest
            .list_connections()
            .await?
            .iter()
            .any(|c| c.get("id").and_then(Value::as_str) == Some(id.as_str()));
        if !live {
            connection_id = None;
        }
    }

    let (connection_id, folder_id, first_turn) = match connection_id {
        Some(id) => (id, None, false), // conversation already linked on the first prompt
        None => {
            let home = home_dir();
            let folder_id = rest.open_folder(&home).await?;
            let id = rest.acp_connect(agent_type, &home, None).await?;
            *state.chat_connection_id.lock().await = Some(id.clone());
            *state.chat_agent_type.lock().await = agent_type.to_string();
            crate::log::line(format!("chat: opened {agent_type} connection {id}"));
            wait_until_attached(state, &id).await?;
            (id, Some(folder_id), true)
        }
    };

    let prompt = if first_turn { format!("{PREAMBLE}\n\n{prompt}") } else { prompt };
    rest.acp_prompt(&connection_id, &prompt, folder_id).await
}

/// Forces an immediate reconcile and waits until the WS loop has picked the
/// connection up (reconcile records it right before sending the attach
/// frame), so the first streamed deltas are not lost. `acp_list_connections`'
/// `status` is not used: upstream fills it once at spawn and never updates it.
async fn wait_until_attached(state: &Arc<PhantomState>, connection_id: &str) -> Result<(), String> {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
    loop {
        state.relist_now.notify_one();
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        if state.sessions.lock().await.contains_key(connection_id) {
            // Let the attach frame reach Phantom before the prompt does.
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
            return Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            return Err("Phantom no respondió al abrir el chat.".to_string());
        }
    }
}

/// Ends the persisted conversation; the next `send` starts a fresh one.
pub fn reset(state: &Arc<PhantomState>, settings: &std::sync::Mutex<Settings>) {
    // chat_connection_id is behind a tokio Mutex; this command is sync on the
    // Tauri side, so hand the reset to a background task rather than
    // blocking on an async lock inside a non-async command.
    let state = state.clone();
    tauri::async_runtime::spawn(async move {
        let old = state.chat_connection_id.lock().await.take();
        let rest = state.rest.lock().await.clone();
        if let (Some(id), Some(rest)) = (old, rest) {
            let _ = rest.acp_disconnect(&id).await;
        }
    });
    let mut s = settings.lock().unwrap();
    s.chat_conversation_id = None;
    let _ = crate::settings::save(&s);
}

fn build_prompt(text: &str, attachments: &[String]) -> String {
    if attachments.is_empty() {
        return text.to_string();
    }
    let mut out = String::new();
    for path in attachments {
        match inline_if_small_text(path) {
            Some(inlined) => out.push_str(&inlined),
            None => out.push_str(&format!("[Attached file: {path}]\n")),
        }
    }
    out.push_str(text);
    out
}

const MAX_INLINE_TEXT: u64 = 200_000;

fn inline_if_small_text(path: &str) -> Option<String> {
    let p = std::path::Path::new(path);
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    const BINARY_EXTS: &[&str] = &["pdf", "jpg", "jpeg", "png", "gif", "webp", "zip", "exe"];
    if BINARY_EXTS.contains(&ext.as_str()) {
        return None;
    }
    let meta = std::fs::metadata(p).ok()?;
    if meta.len() > MAX_INLINE_TEXT {
        return None;
    }
    let content = std::fs::read_to_string(p).ok()?;
    Some(format!("File: {path}\n```\n{content}\n```\n\n"))
}
