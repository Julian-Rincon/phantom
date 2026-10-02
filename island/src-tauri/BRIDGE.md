# Bridge contract — Phantom Island (Linux / Tauri backend)

This is the contract between `src-tauri/` (Rust, owned by the backend agent)
and `src/**` (frontend, owned by the frontend agent). Everything below is a
Tauri `invoke()` command or a window event. If you change a shape here,
update this file in the same change — the frontend reads this file, not the
Rust source.

Status: **live document, written before implementation**. Commands marked
`[done]` are implemented and match this contract exactly; anything else is
still being built — ask before depending on it.

## Conventions

- All commands use `camelCase` field names on the wire (serde
  `rename_all = "camelCase"`), same as the original Coucou bridge.
- Errors are `Result<T, String>` — the string is a user-facing message, show
  it as-is.
- Events are emitted to the `island` window label unless noted.

## Carried over unchanged from Coucou (Windows) — frontend code should not need to change

- `boot()` → `BootInfo { settings, screen, version, hookPath }`. **`hookPath`
  is now always `""`** — the hook relay is retired on Linux (see "Removed"
  below). Don't render it.
- `save_settings(settings)`
- `set_collapsed(collapsed: bool)`
- `set_island_rect(x, y, width, height)`
- `focus_window(focused: bool)`
- `reposition()`
- `quit_app()`
- `set_paused(paused: bool)`
- `log_line(message: string)`
- `ingest_file(path: string)` → `DroppedFile { name, path, size }`
- `secret_present(key)`, `secret_set(key, value)`, `secret_clear(key)` — same
  `KNOWN_KEYS` list, now backed by the Secret Service / KWallet instead of
  Windows Credential Manager. `secret_set`/`secret_clear` return a clearer
  error string when the wallet is locked or unreachable: surface it, don't
  silently swallow.
- `refresh_integration(id)`, `open_n8n()`
- `open_settings_window()`
- `hooks_status()`, `hooks_preview()`, `hooks_apply()`,
  `approval_decision()`, `approval_ack()`, `approval_decline()` — **REMOVED**,
  see below. Calling them is a compile error on the frontend once you remove
  the hooks settings panel; there is nothing to migrate them to.
- `chat_reset()` unchanged in shape; see `island_chat_reset` note below —
  kept as an alias.
- Events: `cursor`, `settings-changed`, `screen-changed`, `tray` — unchanged
  payloads.

## Removed

- **`hook_path` field** in `BootInfo` is now always `""`. The Claude-Code
  hook relay (`hooks.rs`, `pipe.rs`, `hook/`) does not exist on Linux:
  Phantom already observes every agent session (Claude Code, OpenCode,
  Hermes) directly, so there is no `~/.claude/settings.json` to patch and no
  named pipe to relay permission requests over. Drop any "Install Claude Code
  hooks" UI in settings.
- **`chat_send`** (direct Anthropic API call) is replaced by
  `island_chat_send` below — same visible behaviour (one assistant reply
  per turn) but now streamed and routed through Phantom.
- `hooks_status/preview/apply`, `approval_decision/ack/decline` — gone, see
  above. The permission flow is now `phantom_respond_permission` plus the
  `phantom://permission-request` / `phantom://permission-resolved` events.

## New: Phantom connection

### `phantom_status()` → `PhantomStatus`
```ts
{
  connected: boolean,
  version: string | null,       // codeg server version, if known
  agents: { agentType: string, available: boolean }[],
}
```
`agentType` is one of `"claude_code" | "codex" | "open_code" | "gemini" |
"open_claw" | "cline" | "hermes" | "code_buddy" | "kimi_code" | "pi" |
"grok" | "cursor" | "deep_seek" | "qoder" | "antigravity"` or a custom
string — treat it as an opaque string, don't hardcode the enum.

### `phantom_sessions()` → `PhantomSession[]`
Current live sessions snapshot (polled once on demand — the live feed is the
events below, this is just "what's on screen right now" for first paint /
reconnect).
```ts
{
  connectionId: string,
  agentType: string,
  status: "connecting" | "connected" | "prompting" | "disconnected" | "error",
  conversationId: number | null,
  model: string | null,
  folder: string | null,
}[]
```

### `phantom_respond_permission(connectionId, requestId, optionId)`
Allow/Deny (and any other option the agent offered) for a pending
`phantom://permission-request` card. `optionId` must be one of the
`options[].optionId` values the event carried — there's no bare
allow/deny string anymore, that was a Claude-Code-hooks-only concept.

### `phantom_scorecard()` → passthrough of `POST /api/model_scorecard`
```ts
{
  generatedAt: string,          // ISO datetime
  models: {
    agentType: string, model: string, label: string | null,
    available: boolean | null, conversations: number, turns: number,
    avgTurnMs: number | null, p50TurnMs: number | null,
    outputTokensPerS: number | null, outputTokensPerTurn: number | null,
    cacheHitPct: number | null,
  }[],
  bestFor: { label: string, agentType: string, model: string, reason: string }[],
}
```
(Field list best-effort from `codeg/src-tauri/src/models/model_scorecard.rs`
— treat unknown extra fields as pass-through-and-ignore, this is a thin
proxy, not a re-typed DTO.)

### `phantom_successor(agentType, model, conversationId)` / `phantom_handoff(conversationId, targetAgentType, targetModel)`
Thin passthroughs of `/api/phantom_successor` and `/api/phantom_handoff`.
Same request/response shape as those endpoints (camelCase on the wire
either way). Use `phantom_successor` to ask "what should replace this
agent", `phantom_handoff` to actually do it.

### Event: `phantom://limit`
Emitted when a `SessionFailure` or `Error` event on any attached connection
looks like a spent quota (mirrors `codeg`'s `acp::model_limits` heuristic,
reduced fidelity — exact regex parity is not guaranteed). Payload:
```ts
{
  connectionId: string,
  agentType: string,
  scope: "account" | "model",
  message: string,
  successor: PhantomSuccessorCandidate | null,  // from phantom_successor, pre-fetched
}
```

## New: session/event feed (replaces Claude-Code hooks)

No more `hook` events. Instead, `phantom.rs` attaches to every live Phantom
connection and emits one island event per mapped `AcpEvent`, under the
`phantom://event` channel, always with this envelope:
```ts
{
  connectionId: string,
  agentType: string,            // added field, not in the raw AcpEvent
  model: string | null,         // added field — best-known current model, may lag
  conversationId: number | null,// added field — once ConversationLinked has fired
  folder: string | null,        // added field — working dir, from phantom_sessions
  kind: string,                 // the AcpEvent tag, snake_case, e.g. "content_delta"
  data: object,                 // the AcpEvent's own fields, verbatim (camelCase)
}
```
This intentionally does **not** try to look like the old `hook_event_name`
shape — hooks.ts/bridge.ts/state.ts need a new reducer branch keyed on
`kind`, not a reuse of the old one. Useful `kind` values for the pill/step
UI: `content_delta`, `thinking`, `tool_call`, `tool_call_update`,
`permission_request` (see below — also mirrored to its own channel),
`turn_complete`, `conversation_status_changed`, `session_config_options`,
`error`, `session_failure`.

### Event: `phantom://permission-request`
```ts
{ connectionId, requestId, toolCall, options: {optionId, name, kind}[], queued, agentType, conversationId, folder }
```
### Event: `phantom://permission-resolved`
```ts
{ connectionId, requestId }
```
(Fired when a `ToolCallUpdate`/permission-queue event clears the request —
use it to dismiss a card the user didn't act on, e.g. another client
answered it.)

### Event: `phantom://connection`
```ts
{ connectionId, agentType, status: "connecting"|"connected"|"prompting"|"disconnected"|"error", conversationId, folder }
```
Fired on connect/disconnect lifecycle (when `phantom_sessions()` would
return a different list) — use it to add/remove pills without re-polling.

## New: chat ("talk to Phantom Island")

- `island_chat_send(text: string, attachments: string[])` → fire-and-forget;
  reply streams via events below. `attachments` are absolute paths (from
  `ingest_file`/drag-drop).
- `island_chat_reset()` — ends the persisted conversation; the next
  `island_chat_send` starts a fresh one. (`chat_reset` is kept as an alias
  calling the same Rust function, so old frontend code doesn't break if it
  ships before this rename lands — prefer the new name going forward.)
- Event `island://chat-delta` → `{ text: string }` (append).
- Event `island://chat-done` → `{ }` (turn finished; a delta after this on
  the same turn should not happen).
- Event `island://chat-error` → `{ message: string }`.

Backing detail (not bridge surface, for context): one persistent "Phantom
Island" ACP conversation via `acp_connect` (agent `claude_code`, folder
`$HOME`) + `acp_prompt`, with the conversation id persisted in Settings
until reset. The routing guide already steers delegation — the island does
not choose a model itself.

### `island_file_ask(path: string, question: string)`
Convenience wrapper: ingests the file (if not already in the inbox) and
calls `island_chat_send` with the question plus, for text files ≤200 KB,
the inlined content. Same reply events as above.

## New: voice (local speech service, 127.0.0.1:3091)

- `voice_health()` → `boolean`
- `voice_stt(bytes: number[], mime: string)` → `{ text: string }`
- `voice_tts(text: string, lang: string)` → `{ wavBase64: string }`

All three are thin reqwest proxies with `Authorization: Bearer <CODEG_TOKEN>`
added server-side (the frontend never sees the token). If the speech
service isn't running, `voice_health()` returns `false` and the others
reject with a plain-English error — hide voice UI on `false` rather than
polling in a loop.

## Unchanged bridge surface worth double-checking

- `open_url(url)` — now shells out to `xdg-open` instead of
  `rundll32 url.dll`. Same signature, same http(s)-only guard.
- `open_in_vscode(path)` — tries `code` on `$PATH` first, falls back to
  `xdg-open` on the folder (there is no Explorer to fall back to).

## Integrations

Unchanged bridge surface (`refresh_integration`, `secret_*`, `open_n8n`).
One addition: the GitHub integration card gets a settings toggle "use `gh`
CLI token" — when on and no `github-token` secret is stored,
`phantom_status`/`refresh_integration("integration_github")` falls back to
`gh auth token` (only ever read, never written, and only when the user
opted in). No new bridge command for this — it's internal to
`refresh_integration`.
