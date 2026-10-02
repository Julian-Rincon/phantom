// Phantom data source — replaces the Claude-Code hook relay entirely.
//
// Phantom (codeg-server, http://127.0.0.1:3080) already watches every live
// agent session (Claude Code, OpenCode, Hermes, …), so instead of installing
// hooks into ~/.claude/settings.json and relaying them over a named pipe
// (the old hook/ + pipe.rs + hooks.rs trio), the island connects to Phantom
// directly:
//   - REST (`reqwest`, bearer token) for one-shot calls: list connections,
//     respond to a permission request, the model scorecard, successor /
//     handoff, chat.
//   - WebSocket (`tokio-tungstenite`) for the live event feed, speaking the
//     exact attach protocol the web frontend speaks — see
//     `codeg/src/lib/transport/web-transport.ts` and
//     `codeg/src-tauri/src/web/{ws.rs,ws_attach.rs}` upstream, and
//     `codeg/src/lib/transport/ws-auth.ts` for the subprotocol encoding
//     reproduced in `ws_protocols` below.
//
// Every mapped event is re-emitted to the island webview under the
// `phantom://*` channels documented in `BRIDGE.md` — that file is the
// contract, keep it in sync with any shape change here.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;

use crate::island::WINDOW_LABEL;
use crate::log;

const DEFAULT_HOST: &str = "127.0.0.1";
const DEFAULT_PORT: u16 = 3080;
const WS_READY_CHANNEL: &str = "__ready__";
const CODEG_WS_PROTOCOL: &str = "codeg-events";
const CODEG_WS_TOKEN_PROTOCOL_PREFIX: &str = "codeg-token.";
/// How often to re-list live connections and reconcile WS attach subscriptions.
/// Phantom has no "a new connection appeared" broadcast on the legacy global
/// channel that every transport is guaranteed to receive, so this is the
/// "re-list on connection lifecycle events" fallback the task calls for.
const RELIST_INTERVAL: Duration = Duration::from_secs(3);
const WS_BACKOFF_INITIAL: Duration = Duration::from_secs(1);
const WS_BACKOFF_MAX: Duration = Duration::from_secs(32);

// ── Config: reading ~/.config/codeg/server.env ─────────────────────────────

#[derive(Debug, Clone, Default)]
pub struct PhantomConfig {
    pub host: String,
    pub port: u16,
    pub token: String,
}

impl PhantomConfig {
    pub fn base_url(&self) -> String {
        format!("http://{}:{}", self.host, self.port)
    }

    pub fn ws_url(&self) -> String {
        format!("ws://{}:{}/ws/events", self.host, self.port)
    }
}

/// Reads `CODEG_HOST` / `CODEG_PORT` / `CODEG_TOKEN` out of a `KEY=value`
/// `.env`-style file. Never logs the token. Returns `None` entirely if the
/// token is missing — everything else has a sane localhost default.
pub fn load_config() -> Option<PhantomConfig> {
    let path = crate::settings::codeg_server_env_path();
    let text = std::fs::read_to_string(&path).ok()?;
    parse_server_env(&text)
}

fn parse_server_env(text: &str) -> Option<PhantomConfig> {
    let mut vars: HashMap<&str, &str> = HashMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((key, value)) = line.split_once('=') {
            vars.insert(key.trim(), value.trim().trim_matches('"'));
        }
    }
    let token = vars.get("CODEG_TOKEN").filter(|v| !v.is_empty())?.to_string();
    let host = vars.get("CODEG_HOST").filter(|v| !v.is_empty()).unwrap_or(&DEFAULT_HOST).to_string();
    let port = vars
        .get("CODEG_PORT")
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_PORT);
    Some(PhantomConfig { host, port, token })
}

/// Reproduces `buildCodegWebSocketProtocols` from `ws-auth.ts`: base64url
/// (no padding) encoding of the token, as the second Sec-WebSocket-Protocol
/// offer.
pub fn ws_protocols(token: &str) -> Vec<String> {
    let trimmed = token.trim();
    if trimmed.is_empty() {
        return vec![CODEG_WS_PROTOCOL.to_string()];
    }
    vec![CODEG_WS_PROTOCOL.to_string(), format!("{CODEG_WS_TOKEN_PROTOCOL_PREFIX}{}", base64_url_no_pad(trimmed.as_bytes()))]
}

fn base64_url_no_pad(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        if chunk.len() > 1 {
            out.push(TABLE[(n >> 6) as usize & 63] as char);
        }
        if chunk.len() > 2 {
            out.push(TABLE[n as usize & 63] as char);
        }
    }
    out
}

// ── REST client ─────────────────────────────────────────────────────────

#[derive(Clone)]
pub struct PhantomRest {
    client: reqwest::Client,
    base_url: String,
    token: String,
}

impl PhantomRest {
    pub fn new(cfg: &PhantomConfig) -> Self {
        Self {
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(60))
                .build()
                .unwrap_or_else(|_| reqwest::Client::new()),
            base_url: cfg.base_url(),
            token: cfg.token.clone(),
        }
    }

    async fn call(&self, command: &str, body: Value) -> Result<Value, String> {
        let resp = self
            .client
            .post(format!("{}/api/{command}", self.base_url))
            .bearer_auth(&self.token)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Phantom unreachable: {e}"))?;
        let status = resp.status();
        let text = resp.text().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(format!("Phantom {command} failed ({status}): {}", text.chars().take(300).collect::<String>()));
        }
        if text.is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_str(&text).map_err(|e| format!("bad response from {command}: {e}"))
    }

    pub async fn health(&self) -> bool {
        self.call("health", json!({})).await.is_ok()
    }

    pub async fn list_connections(&self) -> Result<Vec<Value>, String> {
        let v = self.call("acp_list_connections", json!({})).await?;
        Ok(v.as_array().cloned().unwrap_or_default())
    }

    pub async fn respond_permission(&self, connection_id: &str, request_id: &str, option_id: &str) -> Result<(), String> {
        self.call(
            "acp_respond_permission",
            json!({ "connectionId": connection_id, "requestId": request_id, "optionId": option_id }),
        )
        .await?;
        Ok(())
    }

    pub async fn model_scorecard(&self) -> Result<Value, String> {
        self.call("model_scorecard", json!({})).await
    }

    pub async fn phantom_successor(&self, agent_type: &str, model: Option<&str>, conversation_id: Option<i32>) -> Result<Value, String> {
        self.call(
            "phantom_successor",
            json!({ "agentType": agent_type, "model": model, "conversationId": conversation_id }),
        )
        .await
    }

    pub async fn phantom_handoff(&self, conversation_id: i32, target_agent_type: &str, target_model: Option<&str>) -> Result<Value, String> {
        self.call(
            "phantom_handoff",
            json!({ "conversationId": conversation_id, "targetAgentType": target_agent_type, "targetModel": target_model }),
        )
        .await
    }

    pub async fn acp_connect(
        &self,
        agent_type: &str,
        working_dir: &str,
        session_id: Option<&str>,
    ) -> Result<String, String> {
        let v = self
            .call(
                "acp_connect",
                json!({
                    "agentType": agent_type,
                    "workingDir": working_dir,
                    "sessionId": session_id,
                }),
            )
            .await?;
        v.as_str().map(str::to_string).ok_or_else(|| "acp_connect: no connection id".into())
    }

    /// A new conversation row needs a folder; Phantom upserts the path and
    /// returns its id (the same call the web UI makes when opening a folder).
    pub async fn open_folder(&self, path: &str) -> Result<i32, String> {
        let v = self.call("open_folder", json!({ "path": path })).await?;
        v.get("id")
            .and_then(Value::as_i64)
            .map(|id| id as i32)
            .ok_or_else(|| "open_folder: no folder id".into())
    }

    pub async fn acp_disconnect(&self, connection_id: &str) -> Result<(), String> {
        self.call("acp_disconnect", json!({ "connectionId": connection_id })).await?;
        Ok(())
    }

    pub async fn acp_prompt(&self, connection_id: &str, text: &str, folder_id: Option<i32>) -> Result<(), String> {
        self.call(
            "acp_prompt",
            json!({
                "connectionId": connection_id,
                "blocks": [{ "type": "text", "text": text }],
                "folderId": folder_id,
            }),
        )
        .await?;
        Ok(())
    }
}

// ── Pure event mapping (unit-tested, no I/O) ────────────────────────────

/// Extra fields the island adds to every raw `EventEnvelope` before handing
/// it to the frontend — see `BRIDGE.md`'s `phantom://event` shape.
pub struct EventContext<'a> {
    pub agent_type: &'a str,
    pub model: Option<&'a str>,
    pub conversation_id: Option<i32>,
    pub folder: Option<&'a str>,
}

/// Maps one `EventEnvelope` (`{seq, connectionId, <AcpEvent fields flattened
/// with a "type" tag>}`) into the island's `phantom://event` payload. `kind`
/// is the AcpEvent's serde tag (already snake_case from the Rust `#[serde(tag
/// = "type", rename_all = "snake_case")]` on `AcpEvent` upstream), `data` is
/// everything else in the envelope verbatim.
pub fn map_event(envelope: &Value, connection_id: &str, ctx: &EventContext) -> Option<Value> {
    let mut data = envelope.as_object()?.clone();
    data.remove("seq");
    data.remove("connectionId");
    let kind = data.remove("type")?.as_str()?.to_string();

    Some(json!({
        "connectionId": connection_id,
        "agentType": ctx.agent_type,
        "model": ctx.model,
        "conversationId": ctx.conversation_id,
        "folder": ctx.folder,
        "kind": kind,
        "data": Value::Object(data),
    }))
}

/// Best-effort quota/limit detector, mirroring (reduced fidelity —
/// documented in BRIDGE.md) `codeg`'s `acp::model_limits::detect_limit`:
/// a `session_failure` event whose `record.category == "limit"`, or an
/// `error` event whose message/details contain a quota keyword.
pub fn detect_limit(kind: &str, data: &Value) -> Option<(String, String)> {
    const QUOTA_WORDS: &[&str] = &[
        "quota", "rate limit", "usage limit", "out of credits", "insufficient_quota",
        "429", "exhausted", "resets at", "resets in",
    ];
    let haystack = match kind {
        "session_failure" => {
            let record = data.get("record")?;
            if record.get("category").and_then(Value::as_str) != Some("limit") {
                return None;
            }
            format!(
                "{} {}",
                record.get("title").and_then(Value::as_str).unwrap_or_default(),
                record.get("details").and_then(Value::as_str).unwrap_or_default(),
            )
        }
        "error" => format!(
            "{} {}",
            data.get("message").and_then(Value::as_str).unwrap_or_default(),
            data.get("details").and_then(Value::as_str).unwrap_or_default(),
        ),
        _ => return None,
    };
    let lower = haystack.to_lowercase();
    if !QUOTA_WORDS.iter().any(|w| lower.contains(w)) {
        return None;
    }
    // A `session_failure` is a connection-wide advisory by construction (the
    // ACP Session Failure RFD has no per-model scoping at all), so absent a
    // more specific hint it defaults to "account"; a plain `error` defaults
    // to "model" (the common case: one call against one model got rate
    // limited) unless the text itself names the wider scope.
    let scope = if lower.contains("session") || lower.contains("account") || lower.contains("plan") || kind == "session_failure" {
        "account"
    } else {
        "model"
    };
    Some((scope.to_string(), haystack.trim().to_string()))
}

// ── WS client msgs (mirrors ws_attach.rs's ClientMsg/ServerMsg) ─────────

#[derive(Serialize)]
#[serde(tag = "action", rename_all = "snake_case")]
enum ClientMsg {
    Attach { subscription_id: String, connection_id: String, since_seq: Option<u64> },
    Detach { subscription_id: String },
}

// `subscription_id`/`event_seq`/`high_water_seq`/`reason` are part of the
// server's wire shape and must stay here for `serde` to deserialize each
// frame correctly, even though today's handling (see `handle_server_text`)
// only reads a subset of them — we always attach cold (`since_seq: None`),
// so a server-assigned `event_seq`/`high_water_seq` cursor is not yet
// resumed anywhere.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
#[allow(dead_code)]
enum ServerMsg {
    Snapshot { subscription_id: String, connection_id: String, snapshot: Value, event_seq: u64 },
    Replay { subscription_id: String, connection_id: String, events: Vec<Value>, high_water_seq: u64 },
    Event { subscription_id: String, envelope: Value },
    Detached { subscription_id: String, reason: Value },
    Pong,
}

/// Legacy global-broadcast frame shape — only the `__ready__` one matters here.
#[derive(Deserialize)]
struct LegacyFrame {
    channel: String,
}

// ── Runtime: connection state + background task ─────────────────────────

#[derive(Clone, Default, Serialize)]
pub struct AgentSummary {
    pub agent_type: String,
    pub available: bool,
}

pub struct PhantomState {
    pub connected: AtomicBool,
    pub rest: Mutex<Option<PhantomRest>>,
    /// connection_id -> (agentType, conversationId, folder) as last seen from
    /// `acp_list_connections` / `ConversationLinked` events. Used to enrich
    /// every mapped event with the extra BRIDGE.md fields.
    pub sessions: Mutex<HashMap<String, SessionInfo>>,
    /// The connection backing the persistent "Phantom Island" chat, if one
    /// is currently live. Its `content_delta`/`turn_complete`/`error` events
    /// are additionally mirrored to `island://chat-*` (see `emit_mapped`
    /// and `chat.rs`) alongside the normal `phantom://event` stream.
    pub chat_connection_id: Mutex<Option<String>>,
    /// Wakes the WS loop for an immediate reconcile, so a connection the
    /// island just opened is attached before its first prompt streams.
    pub relist_now: tokio::sync::Notify,
    /// Agent behind `chat_connection_id` (the ghost the user is talking to).
    pub chat_agent_type: Mutex<String>,
    /// Set when the chat agent ran a tool since its last text chunk.
    pub chat_text_break: AtomicBool,
}

/// One `acp_list_connections` row in the BRIDGE.md `PhantomSession` shape.
/// Rows without an id are dropped rather than sent half-formed to the UI.
pub fn session_to_bridge(
    row: &Value,
    known: &HashMap<String, SessionInfo>,
) -> Option<Value> {
    let id = row.get("id").and_then(Value::as_str)?;
    let seen = known.get(id);
    let agent_type = row
        .get("agent_type")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| seen.map(|s| s.agent_type.clone()))
        .unwrap_or_default();
    Some(json!({
        "connectionId": id,
        "agentType": agent_type,
        "status": row.get("status").and_then(Value::as_str).unwrap_or("connected"),
        "conversationId": seen.and_then(|s| s.conversation_id),
        "model": seen.and_then(|s| s.model.clone()),
        "folder": seen.and_then(|s| s.folder.clone()),
    }))
}

#[derive(Clone, Default)]
pub struct SessionInfo {
    pub agent_type: String,
    pub status: String,
    pub conversation_id: Option<i32>,
    pub folder: Option<String>,
    pub model: Option<String>,
}

impl Default for PhantomState {
    fn default() -> Self {
        Self {
            connected: AtomicBool::new(false),
            rest: Mutex::new(None),
            sessions: Mutex::new(HashMap::new()),
            chat_connection_id: Mutex::new(None),
            relist_now: tokio::sync::Notify::new(),
            chat_agent_type: Mutex::new(String::new()),
            chat_text_break: AtomicBool::new(false),
        }
    }
}

/// Spawns the background task that owns the Phantom connection for the
/// whole app lifetime: loads the token, opens the WS, reconciles attach
/// subscriptions against `acp_list_connections` every `RELIST_INTERVAL`,
/// and reconnects with exponential backoff on any drop. Never panics the
/// app — a missing token or unreachable server just means `phantom_status`
/// reports `connected: false` until the user starts Phantom.
pub fn start(app: AppHandle, state: Arc<PhantomState>) {
    tauri::async_runtime::spawn(async move {
        let mut backoff = WS_BACKOFF_INITIAL;
        loop {
            let Some(cfg) = load_config() else {
                log::line("phantom: no ~/.config/codeg/server.env yet — retrying");
                tokio::time::sleep(Duration::from_secs(5)).await;
                continue;
            };
            let rest = PhantomRest::new(&cfg);
            *state.rest.lock().await = Some(rest.clone());

            match run_session(&app, &state, &cfg, &rest).await {
                Ok(()) => backoff = WS_BACKOFF_INITIAL,
                Err(err) => log::line(format!("phantom: session ended: {err}")),
            }
            state.connected.store(false, Ordering::Relaxed);
            let _ = app.emit_to(WINDOW_LABEL, "phantom://status", json!({ "connected": false }));
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(WS_BACKOFF_MAX);
        }
    });
}

async fn run_session(app: &AppHandle, state: &Arc<PhantomState>, cfg: &PhantomConfig, rest: &PhantomRest) -> Result<(), String> {
    let mut request = cfg.ws_url().into_client_request().map_err(|e| e.to_string())?;
    let protocols = ws_protocols(&cfg.token).join(", ");
    request.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        HeaderValue::from_str(&protocols).map_err(|e| e.to_string())?,
    );

    let (ws, _resp) = tokio_tungstenite::connect_async(request).await.map_err(|e| format!("WS connect failed: {e}"))?;
    let (mut write, mut read) = ws.split();

    // Wait for __ready__ before treating the socket as usable, mirroring
    // web-transport.ts's waitForReady() gate.
    let ready = tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(Ok(Message::Text(text))) = read.next().await {
            if let Ok(frame) = serde_json::from_str::<LegacyFrame>(&text) {
                if frame.channel == WS_READY_CHANNEL {
                    return true;
                }
            }
        }
        false
    })
    .await
    .unwrap_or(false);
    if !ready {
        return Err("no __ready__ frame within 5s".into());
    }

    state.connected.store(true, Ordering::Relaxed);
    let _ = app.emit_to(WINDOW_LABEL, "phantom://status", json!({ "connected": true }));
    log::line("phantom: connected");

    let mut attached: HashSet<String> = HashSet::new();
    let mut relist = tokio::time::interval(RELIST_INTERVAL);

    loop {
        tokio::select! {
            _ = relist.tick() => {
                reconcile_connections(app, state, rest, &mut write, &mut attached).await;
            }
            _ = state.relist_now.notified() => {
                reconcile_connections(app, state, rest, &mut write, &mut attached).await;
            }
            msg = read.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        handle_server_text(app, state, &text).await;
                    }
                    Some(Ok(Message::Close(_))) | None => return Err("socket closed".into()),
                    Some(Err(e)) => return Err(format!("WS error: {e}")),
                    _ => {}
                }
            }
        }
    }
}

async fn reconcile_connections(
    app: &AppHandle,
    state: &Arc<PhantomState>,
    rest: &PhantomRest,
    write: &mut (impl SinkExt<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin),
    attached: &mut HashSet<String>,
) {
    let list = match rest.list_connections().await {
        Ok(l) => l,
        Err(err) => {
            log::line(format!("phantom: list_connections failed: {err}"));
            return;
        }
    };
    let live: HashSet<String> = list
        .iter()
        .filter_map(|c| c.get("id").and_then(Value::as_str).map(str::to_string))
        .collect();

    {
        let mut sessions = state.sessions.lock().await;
        for conn in &list {
            let Some(id) = conn.get("id").and_then(Value::as_str) else { continue };
            let agent_type = conn
                .get("agent_type")
                .or_else(|| conn.get("agentType"))
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_string();
            let status = conn.get("status").and_then(Value::as_str).unwrap_or("connecting").to_string();
            let entry = sessions.entry(id.to_string()).or_default();
            let was_new = entry.agent_type.is_empty();
            entry.agent_type = agent_type.clone();
            entry.status = status.clone();
            if was_new {
                let _ = app.emit_to(
                    WINDOW_LABEL,
                    "phantom://connection",
                    json!({ "connectionId": id, "agentType": agent_type, "status": status,
                            "conversationId": entry.conversation_id, "folder": entry.folder }),
                );
            }
        }
        // Phantom restarted or dropped a connection while we were not
        // attached to it: tell the UI, or its pill (and any pending
        // approval card) would linger forever.
        for gone in sessions.keys().filter(|id| !live.contains(*id)) {
            let _ = app.emit_to(WINDOW_LABEL, "phantom://connection", json!({ "connectionId": gone, "status": "disconnected" }));
        }
        sessions.retain(|id, _| live.contains(id));
    }

    for id in live.difference(attached) {
        let frame = ClientMsg::Attach { subscription_id: id.clone(), connection_id: id.clone(), since_seq: None };
        if let Ok(text) = serde_json::to_string(&frame) {
            let _ = write.send(Message::Text(text.into())).await;
        }
    }
    for id in attached.difference(&live) {
        let frame = ClientMsg::Detach { subscription_id: id.clone() };
        if let Ok(text) = serde_json::to_string(&frame) {
            let _ = write.send(Message::Text(text.into())).await;
        }
        let _ = app.emit_to(WINDOW_LABEL, "phantom://connection", json!({ "connectionId": id, "status": "disconnected" }));
    }
    *attached = live;
}

async fn handle_server_text(app: &AppHandle, state: &Arc<PhantomState>, text: &str) {
    // Legacy __ready__/global frames and attach-protocol frames share the
    // socket; only route on "type" (attach protocol) here — see ws.rs.
    let Ok(msg) = serde_json::from_str::<ServerMsg>(text) else { return };
    match msg {
        ServerMsg::Event { subscription_id, envelope } => {
            emit_mapped(app, state, &subscription_id, &envelope).await;
        }
        ServerMsg::Snapshot { connection_id, snapshot, .. } => {
            // A fresh attach's state-so-far. We don't replay historical
            // content into the step list (the island only shows what
            // happens from now on, like the old hook feed did), but a
            // pending permission request in the snapshot must still surface
            // — it would otherwise never fire as an `Event`.
            if let Some(pending) = snapshot.get("pendingPermission") {
                emit_permission(app, state, &connection_id, pending).await;
            }
        }
        ServerMsg::Replay { connection_id, events, .. } => {
            for envelope in events {
                emit_mapped(app, state, &connection_id, &envelope).await;
            }
        }
        ServerMsg::Detached { subscription_id, reason } => {
            log::line(format!("phantom: detached from {subscription_id} ({reason}), will re-attach on next reconcile"));
        }
        ServerMsg::Pong => {}
    }
}

async fn emit_mapped(app: &AppHandle, state: &Arc<PhantomState>, connection_id: &str, envelope: &Value) {
    let (agent_type, conversation_id, folder, model) = {
        let mut sessions = state.sessions.lock().await;
        let entry = sessions.entry(connection_id.to_string()).or_default();
        // Keep conversation/folder/model in sync from events that announce them.
        if let Some(kind) = envelope.get("type").and_then(Value::as_str) {
            if kind == "conversation_linked" {
                entry.conversation_id = envelope.get("conversationId").and_then(Value::as_i64).map(|v| v as i32);
            }
        }
        (entry.agent_type.clone(), entry.conversation_id, entry.folder.clone(), entry.model.clone())
    };
    let ctx = EventContext { agent_type: &agent_type, model: model.as_deref(), conversation_id, folder: folder.as_deref() };
    let Some(payload) = map_event(envelope, connection_id, &ctx) else { return };
    let kind = payload.get("kind").and_then(Value::as_str).unwrap_or_default().to_string();
    let data = payload.get("data").cloned().unwrap_or(Value::Null);

    if kind == "permission_request" {
        emit_permission(app, state, connection_id, &data).await;
    }
    if kind == "permission_resolved" {
        if let Some(request_id) = data.get("request_id").or_else(|| data.get("requestId")).and_then(Value::as_str) {
            let _ = app.emit_to(
                WINDOW_LABEL,
                "phantom://permission-resolved",
                json!({ "connectionId": connection_id, "requestId": request_id }),
            );
        }
    }

    // Mirror the persistent chat connection's own turn into island://chat-*,
    // on top of the ordinary phantom://event stream — see chat.rs.
    if state.chat_connection_id.lock().await.as_deref() == Some(connection_id) {
        match kind.as_str() {
            "content_delta" if data.get("parent_tool_use_id").is_none_or(Value::is_null) => {
                if let Some(text) = data.get("text").and_then(Value::as_str) {
                    // Text resuming after a tool call is a new paragraph, not
                    // a continuation of the sentence before the tool ran.
                    let text = if state.chat_text_break.swap(false, Ordering::Relaxed) && !text.is_empty() {
                        format!("\n\n{}", text.trim_start())
                    } else {
                        text.to_string()
                    };
                    let _ = app.emit_to(WINDOW_LABEL, "island://chat-delta", json!({ "text": text }));
                }
            }
            "tool_call" => {
                state.chat_text_break.store(true, Ordering::Relaxed);
            }
            "turn_complete" => {
                state.chat_text_break.store(false, Ordering::Relaxed);
                let _ = app.emit_to(WINDOW_LABEL, "island://chat-done", json!({}));
            }
            "error" => {
                let message = data.get("message").and_then(Value::as_str).unwrap_or("Phantom error");
                let _ = app.emit_to(WINDOW_LABEL, "island://chat-error", json!({ "message": message }));
            }
            "session_failure" => {
                let message = data
                    .get("record")
                    .and_then(|r| r.get("title"))
                    .and_then(Value::as_str)
                    .unwrap_or("Phantom session failure");
                let _ = app.emit_to(WINDOW_LABEL, "island://chat-error", json!({ "message": message }));
            }
            _ => {}
        }
    }
    if let Some((scope, message)) = detect_limit(&kind, &data) {
        let successor = match state.rest.lock().await.as_ref() {
            Some(rest) => rest.phantom_successor(&agent_type, model.as_deref(), conversation_id).await.ok(),
            None => None,
        };
        let _ = app.emit_to(
            WINDOW_LABEL,
            "phantom://limit",
            json!({ "connectionId": connection_id, "agentType": agent_type, "scope": scope, "message": message,
                    "successor": successor.and_then(|s| s.get("successor").cloned()) }),
        );
    }

    let _ = app.emit_to(WINDOW_LABEL, "phantom://event", payload);
}

/// Phantom's `PermissionRequest` (event and snapshot alike) is snake_case;
/// the island's `PermissionRequestPayload` is camelCase. Accepts both so a
/// future upstream rename cannot blank the approval card again.
pub fn permission_to_bridge(data: &Value) -> Value {
    let pick = |a: &str, b: &str| data.get(a).or_else(|| data.get(b)).cloned();
    let options: Vec<Value> = pick("options", "options")
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default()
        .iter()
        .map(|o| {
            json!({
                "optionId": o.get("option_id").or_else(|| o.get("optionId")).cloned().unwrap_or(Value::Null),
                "name": o.get("name").cloned().unwrap_or(Value::Null),
                "kind": o.get("kind").cloned().unwrap_or(Value::Null),
            })
        })
        .collect();
    json!({
        "requestId": pick("request_id", "requestId").unwrap_or(Value::Null),
        "toolCall": pick("tool_call", "toolCall").filter(Value::is_object).unwrap_or_else(|| json!({})),
        "options": options,
        "queued": pick("queued", "queued").map(|q| q.as_bool().unwrap_or(q.as_u64().unwrap_or(0) > 0)).unwrap_or(false),
    })
}

async fn emit_permission(app: &AppHandle, state: &Arc<PhantomState>, connection_id: &str, data: &Value) {
    let (agent_type, conversation_id, folder) = {
        let sessions = state.sessions.lock().await;
        let entry = sessions.get(connection_id).cloned().unwrap_or_default();
        (entry.agent_type, entry.conversation_id, entry.folder)
    };
    let mut out = permission_to_bridge(data);
    if let Some(obj) = out.as_object_mut() {
        obj.insert("connectionId".into(), json!(connection_id));
        obj.insert("agentType".into(), json!(agent_type));
        obj.insert("conversationId".into(), json!(conversation_id));
        obj.insert("folder".into(), json!(folder));
    }
    let _ = app.emit_to(WINDOW_LABEL, "phantom://permission-request", out);
}

#[cfg(test)]
mod tests {
    #[test]
    fn list_rows_are_mapped_to_the_bridge_session_shape() {
        let row = serde_json::json!({"id": "c1", "agent_type": "claude_code", "status": "connecting"});
        let mut known = std::collections::HashMap::new();
        known.insert(
            "c1".to_string(),
            super::SessionInfo {
                agent_type: "claude_code".into(),
                status: "connected".into(),
                conversation_id: Some(7),
                folder: Some("/home/u".into()),
                model: Some("claude-sonnet-5".into()),
            },
        );
        let s = super::session_to_bridge(&row, &known).unwrap();
        assert_eq!(s["connectionId"], "c1");
        assert_eq!(s["agentType"], "claude_code");
        assert_eq!(s["status"], "connecting");
        assert_eq!(s["conversationId"], 7);
        assert!(super::session_to_bridge(&serde_json::json!({"agent_type": "x"}), &known).is_none());
    }

    use super::*;

    #[test]
    fn permission_requests_are_camel_cased_for_the_ui() {
        let raw = json!({
            "request_id": "r1",
            "tool_call": { "title": "Bash · spectacle" },
            "options": [{ "option_id": "allow", "name": "Permitir", "kind": "allow_once" }],
        });
        let out = permission_to_bridge(&raw);
        assert_eq!(out["requestId"], "r1");
        assert_eq!(out["toolCall"]["title"], "Bash · spectacle");
        assert_eq!(out["options"][0]["optionId"], "allow");
        assert_eq!(out["queued"], false);
        assert!(permission_to_bridge(&json!({}))["toolCall"].is_object());
    }

    #[test]
    fn parses_server_env_with_quotes_and_comments() {
        let text = "# comment\nCODEG_HOST=127.0.0.1\nCODEG_PORT=3080\nCODEG_TOKEN=\"abc123\"\n";
        let cfg = parse_server_env(text).unwrap();
        assert_eq!(cfg.host, "127.0.0.1");
        assert_eq!(cfg.port, 3080);
        assert_eq!(cfg.token, "abc123");
    }

    #[test]
    fn missing_token_is_none() {
        assert!(parse_server_env("CODEG_HOST=127.0.0.1\n").is_none());
    }

    #[test]
    fn defaults_host_and_port_when_absent() {
        let cfg = parse_server_env("CODEG_TOKEN=tok\n").unwrap();
        assert_eq!(cfg.host, DEFAULT_HOST);
        assert_eq!(cfg.port, DEFAULT_PORT);
    }

    #[test]
    fn ws_protocols_match_the_web_client_encoding() {
        // Matches buildCodegWebSocketProtocols("hi") in ws-auth.ts: base64url,
        // no padding, of the UTF-8 bytes.
        let protos = ws_protocols("hi");
        assert_eq!(protos[0], "codeg-events");
        assert_eq!(protos[1], "codeg-token.aGk");
    }

    #[test]
    fn ws_protocols_empty_token_omits_the_second_entry() {
        assert_eq!(ws_protocols(""), vec!["codeg-events".to_string()]);
    }

    #[test]
    fn base64_url_has_no_padding_and_uses_url_alphabet() {
        assert_eq!(base64_url_no_pad(b"any carnal pleasure."), "YW55IGNhcm5hbCBwbGVhc3VyZS4");
        assert_eq!(base64_url_no_pad(b"\xff\xff\xff"), "____");
    }

    #[test]
    fn maps_content_delta_envelope() {
        let envelope = json!({
            "seq": 42, "connectionId": "c1", "type": "content_delta", "text": "hello", "parentToolUseId": null
        });
        let ctx = EventContext { agent_type: "claude_code", model: Some("claude-sonnet-5"), conversation_id: Some(7), folder: Some("/home/x") };
        let payload = map_event(&envelope, "c1", &ctx).unwrap();
        assert_eq!(payload["kind"], "content_delta");
        assert_eq!(payload["connectionId"], "c1");
        assert_eq!(payload["agentType"], "claude_code");
        assert_eq!(payload["conversationId"], 7);
        assert_eq!(payload["data"]["text"], "hello");
        assert!(payload["data"].get("seq").is_none(), "seq must not leak into data");
        assert!(payload["data"].get("connectionId").is_none(), "connectionId must not be duplicated into data");
    }

    #[test]
    fn detects_limit_from_session_failure_category() {
        let data = json!({ "record": { "category": "limit", "title": "Usage limit reached", "details": "resets at 3pm" } });
        let (scope, msg) = detect_limit("session_failure", &data).unwrap();
        assert_eq!(scope, "account");
        assert!(msg.contains("Usage limit"));
    }

    #[test]
    fn ignores_session_failure_outside_limit_category() {
        let data = json!({ "record": { "category": "connection", "title": "dropped" } });
        assert!(detect_limit("session_failure", &data).is_none());
    }

    #[test]
    fn detects_limit_from_error_message_keyword() {
        let data = json!({ "message": "429 Too Many Requests", "details": null });
        let (scope, _) = detect_limit("error", &data).unwrap();
        assert_eq!(scope, "model");
    }

    #[test]
    fn plain_errors_without_quota_wording_are_not_limits() {
        let data = json!({ "message": "connection reset by peer" });
        assert!(detect_limit("error", &data).is_none());
    }
}
