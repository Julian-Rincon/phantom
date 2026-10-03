// Thin wrapper over the Tauri commands/events. Every call is a no-op when the
// page is opened in a plain browser, so the island can be iterated on with
// `npm run dev` alone.
//
// Contract: island/src-tauri/BRIDGE.md (owned by the backend agent). This file
// mirrors it command-for-command and event-for-event — if a shape here looks
// odd, check BRIDGE.md before "fixing" it.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { Settings } from "./state";

export const IS_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!IS_TAURI) return null;
  try {
    return await invoke<T>(cmd, args);
  } catch (err) {
    console.error(`[phantom-island] ${cmd} failed`, err);
    return null;
  }
}

/** Same as `call`, but surfaces the error so the UI can show what went wrong. */
async function callOrThrow<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!IS_TAURI) throw new Error("Esta acción solo funciona dentro de la app Phantom Island");
  return invoke<T>(cmd, args);
}

export interface BootInfo {
  settings: Settings;
  /** Logical screen rect of the monitor the island lives on. */
  screen: { x: number; y: number; width: number; height: number; scale: number };
  version: string;
  /** Always "" on Linux — the Claude-Code hook relay doesn't exist here. */
  hookPath: string;
}

export const Bridge = {
  // ── Carried over unchanged from the Windows bridge ──────────────────────────
  boot: () => call<BootInfo>("boot"),
  saveSettings: (settings: Settings) => call<void>("save_settings", { settings }),
  /** Shrink the window down to the invisible wake strip (hidden) or back to full. */
  setCollapsed: (collapsed: boolean) => call<void>("set_collapsed", { collapsed }),
  /**
   * Pushes the island shape in window coordinates. Rust flips click-through from
   * its own cursor poll, so the flag is never a frame behind a click.
   */
  setIslandRect: (x: number, y: number, width: number, height: number) =>
    call<void>("set_island_rect", { x, y, width, height }),
  /** Give the window keyboard focus (chat field) and take it away again. */
  focusWindow: (focused: boolean) => call<void>("focus_window", { focused }),
  reposition: () => call<void>("reposition"),
  /** Shells out to `xdg-open`; http(s)-only guard on the Rust side. */
  openUrl: (url: string) => call<void>("open_url", { url }),
  /** Tries `code` on PATH, falls back to `xdg-open` on the folder. */
  openInVSCode: (path: string | null) => call<boolean>("open_in_vscode", { path }),
  quit: () => call<void>("quit_app"),
  openSettingsWindow: () => call<void>("open_settings_window"),
  log: (message: string) => call<void>("log_line", { message }),
  /** Copies a dropped file into the inbox. */
  ingestFile: (path: string) => callOrThrow<DroppedFile>("ingest_file", { path }),
  /** Only ever tells you whether a key exists — never its value. */
  secretPresent: (key: string) => call<boolean>("secret_present", { key }),
  secretSet: (key: string, value: string) => callOrThrow<void>("secret_set", { key, value }),
  secretClear: (key: string) => callOrThrow<void>("secret_clear", { key }),
  refreshIntegration: (id: string) => call<void>("refresh_integration", { id }),
  /** Opens the configured n8n instance in the browser. */
  openN8n: () => call<void>("open_n8n"),
  /** Tray → Pause. Stops the integration pollers, not just the island. */
  setPaused: (paused: boolean) => call<void>("set_paused", { paused }),

  // ── Phantom connection ───────────────────────────────────────────────────────
  phantomStatus: () => call<PhantomStatus>("phantom_status"),
  phantomSessions: () => call<PhantomSession[]>("phantom_sessions"),
  phantomRespondPermission: (connectionId: string, requestId: string, optionId: string) =>
    call<void>("phantom_respond_permission", { connectionId, requestId, optionId }),
  phantomScorecard: () => call<PhantomScorecard>("phantom_scorecard"),
  phantomSuccessor: (agentType: string, model: string, conversationId: number | null) =>
    call<PhantomSuccessorCandidate | null>("phantom_successor", { agentType, model, conversationId }),
  phantomHandoff: (conversationId: number, targetAgentType: string, targetModel: string) =>
    call<void>("phantom_handoff", { conversationId, targetAgentType, targetModel }),

  // ── Chat ("talk to Phantom Island") ─────────────────────────────────────────
  /** Fire-and-forget; the reply streams back over the chat-delta/chat-done events. */
  islandChatSend: (text: string, attachments: string[] = [], agentType = "claude_code") =>
    callOrThrow<void>("island_chat_send", { text, attachments, agentType }),
  /** Ends the persisted conversation; the next send starts a fresh one. */
  islandChatReset: () => call<void>("island_chat_reset"),
  /** Ingests the file (if needed) and sends a question about it, same reply events. */
  islandFileAsk: (path: string, question: string, agentType = "claude_code") =>
    callOrThrow<void>("island_file_ask", { path, question, agentType }),

  // ── Voice (local speech service) ────────────────────────────────────────────
  voiceHealth: () => call<boolean>("voice_health"),
  /** One captured utterance → transcript. */
  voiceStt: (bytes: number[], mime: string) =>
    callOrThrow<{ text: string; language?: string; duration_ms?: number }>("voice_stt", { bytes, mime }),
  /** One sentence → spoken audio (base64 WAV), played by the caller so barge-in can cut it off. */
  voiceTts: (text: string, lang: string) => callOrThrow<{ wavBase64: string }>("voice_tts", { text, lang }),
};

export interface PhantomStatus {
  connected: boolean;
  version: string | null;
  agents: { agentType: string; available: boolean }[];
}

export type PhantomConnectionStatus = "connecting" | "connected" | "prompting" | "disconnected" | "error";

export interface PhantomSession {
  connectionId: string;
  agentType: string;
  status: PhantomConnectionStatus;
  conversationId: number | null;
  model: string | null;
  folder: string | null;
}

export interface PhantomSuccessorCandidate {
  agentType: string;
  model: string;
  /** Display label from the scorecard, e.g. "opencode/Space Bunny Free". */
  label?: string;
  reason: string;
}

export interface PhantomScorecard {
  generatedAt: string;
  models: {
    agentType: string;
    model: string;
    label: string | null;
    available: boolean | null;
    conversations: number;
    turns: number;
    avgTurnMs: number | null;
    p50TurnMs: number | null;
    outputTokensPerS: number | null;
    outputTokensPerTurn: number | null;
    cacheHitPct: number | null;
  }[];
  bestFor: { label: string; agentType: string; model: string; reason: string }[];
}

export interface IntegrationUpdate {
  id: string;
  data: Record<string, unknown>;
  error: string | null;
  event: { success: boolean; label: string; detail: string | null } | null;
}

export interface DroppedFile {
  name: string;
  path: string;
  size: number;
}

// ── Event payloads ───────────────────────────────────────────────────────────

/** Envelope for every mapped agent-client-protocol event (`phantom://event`). */
export interface PhantomEventPayload {
  connectionId: string;
  agentType: string;
  model: string | null;
  conversationId: number | null;
  folder: string | null;
  /** The AcpEvent tag, snake_case — e.g. "content_delta", "tool_call", "turn_complete". */
  kind: string;
  data: Record<string, unknown>;
}

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

export interface PermissionRequestPayload {
  connectionId: string;
  requestId: string;
  toolCall: Record<string, unknown>;
  options: PermissionOption[];
  queued: boolean;
  agentType: string;
  conversationId: number | null;
  folder: string | null;
}

export interface PermissionResolvedPayload {
  connectionId: string;
  requestId: string;
}

export interface ConnectionPayload {
  connectionId: string;
  agentType: string;
  status: PhantomConnectionStatus;
  conversationId: number | null;
  folder: string | null;
}

/** Payload of `phantom://limit`. */
export interface LimitEventPayload {
  connectionId: string;
  agentType: string;
  scope: "account" | "model";
  message: string;
  successor: PhantomSuccessorCandidate | null;
  runnerUp?: PhantomSuccessorCandidate | null;
}

export interface ChatDeltaPayload {
  text: string;
}

export type ChatDonePayload = Record<string, never>;

export interface ChatErrorPayload {
  message: string;
}

export type BridgeEvent =
  | { name: "cursor"; payload: { x: number; y: number } }
  | { name: "tray"; payload: string }
  | { name: "screen-changed"; payload: null }
  | { name: "settings-changed"; payload: Settings }
  | { name: "phantom://event"; payload: PhantomEventPayload }
  | { name: "phantom://permission-request"; payload: PermissionRequestPayload }
  | { name: "phantom://permission-resolved"; payload: PermissionResolvedPayload }
  | { name: "phantom://connection"; payload: ConnectionPayload }
  | { name: "phantom://limit"; payload: LimitEventPayload }
  | { name: "island://chat-delta"; payload: ChatDeltaPayload }
  | { name: "island://chat-done"; payload: ChatDonePayload }
  | { name: "island://chat-error"; payload: ChatErrorPayload };

export interface DragDropPayload {
  type: "enter" | "over" | "drop" | "leave";
  paths?: string[];
}

/** Files dragged onto the island. Only reaches us when the window takes the mouse. */
export async function onDragDrop(handler: (e: DragDropPayload) => void) {
  if (!IS_TAURI) return () => {};
  return getCurrentWebview().onDragDropEvent((event) => {
    handler(event.payload as DragDropPayload);
  });
}

export async function onEvent<T>(name: string, handler: (payload: T) => void) {
  if (!IS_TAURI) return () => {};
  return listen<T>(name, (e) => handler(e.payload));
}
