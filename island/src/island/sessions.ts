// Phantom session/event feed → island state. Replaces the old Claude-Code
// hooks relay (hooks.ts/hook events) per src-tauri/BRIDGE.md: every attached
// agent-client-protocol connection (Claude Code, Codex, OpenCode, Gemini CLI,
// Hermes, …) now emits a `phantom://event` envelope, plus dedicated
// `phantom://permission-request` / `-resolved` / `phantom://connection` /
// `phantom://limit` channels.

import { Bridge, onEvent, type ConnectionPayload, type LimitEventPayload, type PhantomSuccessorCandidate,
  type PermissionRequestPayload, type PermissionResolvedPayload, type PhantomEventPayload } from "../core/bridge";
import { Sound } from "../core/sound";
import { State, type LimitCandidate } from "../core/state";
import { accentForAgentType, accentHex, agentLabel } from "../core/accents";
import type { Island } from "./island";

function lastPathComponent(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, "");
  const idx = Math.max(cleaned.lastIndexOf("\\"), cleaned.lastIndexOf("/"));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

/** Short, readable label for a `tool_call`/`tool_call_update` event's data. */
function toolCallLabel(data: Record<string, unknown>): string {
  const title = typeof data.title === "string" ? data.title : null;
  const name = typeof data.toolName === "string" ? data.toolName : (typeof data.kind === "string" ? data.kind : "Tool");
  const locations = Array.isArray(data.locations) ? data.locations : [];
  const path = locations.length > 0 && typeof (locations[0] as Record<string, unknown>)?.path === "string"
    ? String((locations[0] as Record<string, unknown>).path)
    : null;
  if (title) return title.slice(0, 60);
  if (path) return `${name} · ${lastPathComponent(path)}`;
  return name;
}

/** The text line currently growing per session, reset by each tool call. */
const textLines = new Map<string, string>();

function sessionId(connectionId: string): string {
  return `session_${connectionId}`;
}

function ensureSession(ev: PhantomEventPayload | ConnectionPayload) {
  const color = accentHex(accentForAgentType(ev.agentType));
  return State.upsertSession(ev.connectionId, ev.agentType, color, {
    model: "model" in ev ? ev.model : undefined,
    folder: ev.folder,
    conversationId: ev.conversationId,
  });
}

function handlePhantomEvent(island: Island, ev: PhantomEventPayload) {
  if (State.paused) return;
  const task = ensureSession(ev);
  const id = task.id;
  const focused = State.focusId === id;

  const surface = (view: Parameters<Island["alert"]>[0], isAlert: boolean) => {
    if (State.mode === "expanded") {
      if (isAlert) island.setView(view);
    } else if (isAlert) {
      island.alert(view);
    } else if (State.mode === "hidden") {
      island.reveal();
    }
  };

  switch (ev.kind) {
    case "thinking":
      State.updateTask(id, "thinking");
      break;

    case "content_delta": {
      State.updateTask(id, "working");
      // Deltas are a few characters each: grow one "what it is saying" line
      // per stretch of text instead of a step per fragment. Subagent chunks
      // (parent_tool_use_id) are not the session's own voice.
      const text = typeof ev.data.text === "string" && !ev.data.parent_tool_use_id ? ev.data.text : null;
      if (text) {
        const line = ((textLines.get(id) ?? "") + text).replace(/\s+/g, " ");
        const fresh = !textLines.has(id);
        textLines.set(id, line);
        const shown = line.trim().slice(-60);
        if (shown) {
          if (fresh) State.appendStep(id, shown);
          else State.replaceLastStep(id, shown);
        }
      }
      surface("overview", false);
      break;
    }

    case "tool_call":
    case "tool_call_update":
      textLines.delete(id);
      State.updateTask(id, "working");
      State.appendStep(id, toolCallLabel(ev.data));
      surface("overview", false);
      break;

    case "turn_complete":
      textLines.delete(id);
      State.updateTask(id, "finished");
      Sound.play("finish");
      if (focused) surface("finished", true);
      else State.setPillBadge(id, "finished");
      window.setTimeout(() => {
        State.updateTask(id, "idle");
        State.setPillBadge(id, null);
      }, 5200);
      break;

    case "error":
    case "session_failure":
      State.updateTask(id, "error");
      Sound.play("error");
      if (focused) surface("error", true);
      else State.setPillBadge(id, "error");
      break;

    // Connection status (connecting/connected/prompting/…) and conversation
    // status (in_progress/pending_review/completed/cancelled) are separate
    // events upstream; only "a turn is running" maps to working here — the
    // end of a turn is `turn_complete`.
    case "status_changed":
      if (ev.data.status === "prompting") State.updateTask(id, "working");
      break;

    case "conversation_status_changed":
      if (ev.data.status === "in_progress") State.updateTask(id, "working");
      break;

    default:
      break;
  }
  State.notify();
}

function handlePermissionRequest(island: Island, payload: PermissionRequestPayload) {
  if (State.paused) {
    // Paused = decline politely; the option id is agent-defined, the kind is not.
    const reject = payload.options.find((o) => o.kind.startsWith("reject"));
    if (reject) void Bridge.phantomRespondPermission(payload.connectionId, payload.requestId, reject.optionId);
    return;
  }
  // One card, one request — a second one is handled by the backend's own
  // `queued` flag; here we simply don't yank the card out from under the user.
  // A pending card whose session is gone is stale, not "in front of the user".
  const pending = State.pendingApproval;
  if (pending && pending.requestId !== payload.requestId && State.findSessionByConnection(pending.connectionId)) return;

  const id = sessionId(payload.connectionId);
  State.upsertSession(payload.connectionId, payload.agentType, accentHex(accentForAgentType(payload.agentType)), {
    folder: payload.folder, conversationId: payload.conversationId,
  });

  const toolTitle = typeof payload.toolCall?.title === "string" ? payload.toolCall.title : agentLabel(payload.agentType);
  State.pendingApproval = {
    connectionId: payload.connectionId,
    requestId: payload.requestId,
    agentType: payload.agentType,
    toolCallLabel: toolTitle as string,
    options: payload.options,
  };
  State.updateTask(id, "approval");
  State.isPinned = true;
  Sound.play("approval");

  // Always bring the asking session forward with its Allow/Deny card: a
  // badge on a pill nobody is looking at reads as "nothing to click". The
  // card stays until the request is answered here, in Phantom or on Telegram
  // (`phantom://permission-resolved`) — the agent keeps waiting meanwhile.
  State.focusId = id;
  State.setPillBadge(id, "approval");
  island.alert("approval");
  State.notify();
}

function handlePermissionResolved(island: Island, payload: PermissionResolvedPayload) {
  if (State.pendingApproval?.requestId !== payload.requestId) return;
  const id = sessionId(State.pendingApproval.connectionId);
  State.pendingApproval = null;
  State.isPinned = false;
  island.dropPin();
  State.updateTask(id, "working");
  State.setPillBadge(id, null);
  if (State.view === "approval") island.setView(State.defaultView());
  State.notify();
}

function handleConnection(island: Island, payload: ConnectionPayload) {
  if (payload.status === "disconnected") {
    // A request from a dead connection can never be answered: drop its card
    // so it does not block the next session's approval.
    if (State.pendingApproval?.connectionId === payload.connectionId) {
      State.pendingApproval = null;
      State.isPinned = false;
      island.dropPin();
      if (State.view === "approval") island.setView(State.defaultView());
    }
    State.removeTask(sessionId(payload.connectionId));
    return;
  }
  ensureSession(payload);
  if (payload.status === "connecting") island.reveal();
  State.notify();
}

function toCandidate(c: PhantomSuccessorCandidate | null | undefined): LimitCandidate | null {
  if (!c?.agentType) return null;
  return {
    agent: c.label || `${agentLabel(c.agentType)} · ${c.model}`,
    agentType: c.agentType,
    model: c.model,
    reason: c.reason,
  };
}

function handleLimit(island: Island, payload: LimitEventPayload) {
  const agentName = agentLabel(payload.agentType);
  State.pendingLimit = {
    agent: agentName,
    // The backend message carries its own reset hint inline; we don't parse
    // it further here — if BRIDGE.md later adds a structured field, prefer it.
    resetHint: "",
    successor: toCandidate(payload.successor),
    runnerUp: toCandidate(payload.runnerUp),
    conversationId: State.findSessionByConnection(payload.connectionId)?.conversationId ?? null,
  };
  const id = sessionId(payload.connectionId);
  State.updateTask(id, "ratelimit");
  Sound.play("rate");
  island.alert("limit");
  State.notify();
}

export function registerSessionHandlers(island: Island) {
  void onEvent<PhantomEventPayload>("phantom://event", (p) => handlePhantomEvent(island, p));
  void onEvent<PermissionRequestPayload>("phantom://permission-request", (p) => handlePermissionRequest(island, p));
  void onEvent<PermissionResolvedPayload>("phantom://permission-resolved", (p) => handlePermissionResolved(island, p));
  void onEvent<ConnectionPayload>("phantom://connection", (p) => handleConnection(island, p));
  void onEvent<LimitEventPayload>("phantom://limit", (p) => handleLimit(island, p));
}

/** Pulls the current session snapshot once at boot (the events above are the
 *  live feed; this is just "what's already running" for first paint). */
export async function loadInitialSessions() {
  const sessions = await Bridge.phantomSessions();
  for (const s of sessions ?? []) {
    State.upsertSession(s.connectionId, s.agentType, accentHex(accentForAgentType(s.agentType)), {
      model: s.model, folder: s.folder, conversationId: s.conversationId,
    });
  }
  State.notify();
}
