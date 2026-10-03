// App state shared by the island and its views.

import type { BotEmoteName, BotStateName, IslandMode, IslandViewName } from "./layout";
import type { EyeShape } from "../phantom/engine";
import type { PermissionOption } from "./bridge";
import { accentForAgentType, accentHex, agentLabel } from "./accents";

export type AgentSource = "phantom" | "n8n";
export type PillBadge = "approval" | "finished" | "error";

export interface AgentTask {
  id: string;
  name: string;
  color: string;
  state: BotStateName;
  stepIndex: number;
  /** Steps ever appended (the list itself is capped); drives the ticker. */
  stepTotal?: number;
  steps: string[];
  source: AgentSource;
  isIntegration: boolean;
  emote?: BotEmoteName | null;
  miniEye?: EyeShape | null;
  pillBadge?: PillBadge | null;
  sessionCwd?: string | null;
  /** Set on dynamic session pills (one per live Phantom connection). */
  connectionId?: string | null;
  agentType?: string | null;
  model?: string | null;
  conversationId?: number | null;
}

export interface ApprovalInfo {
  connectionId: string;
  requestId: string;
  agentType: string;
  /** Short label for the tool call being authorised, e.g. "Bash · npm test". */
  toolCallLabel: string;
  options: PermissionOption[];
}

export interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
  /** Set once an assistant reply is complete; drives "Answered by Claude Sonnet 5". */
  agent?: string;
  model?: string;
  /** True while a streaming reply is still receiving deltas. */
  streaming?: boolean;
}

export interface LimitCandidate {
  agent: string;
  agentType: string;
  model: string;
  reason: string;
}

export interface LimitInfo {
  /** Agent/model that ran out of tokens, e.g. "Claude Sonnet 5". */
  agent: string;
  /** Human-readable reset hint, e.g. "5am" — already localized by the backend. */
  resetHint: string;
  /** Best successor to offer as the primary action. `agent` is the display
   *  label; `agentType` is the id the handoff needs. */
  successor: LimitCandidate | null;
  /** Runner-up offered behind "Choose another". */
  runnerUp: LimitCandidate | null;
  /** The conversation to retry once a successor is chosen. */
  conversationId: number | null;
}

export type PromptContext =
  | { kind: "window"; appName: string; title: string; url?: string }
  | { kind: "file"; name: string; path?: string };

export interface ResultItem {
  label: string;
  detail: string;
  url?: string;
}

export interface SearchResult {
  title: string;
  items: ResultItem[];
  note?: string;
}

const integrationTask = (
  id: string, name: string, color: string,
): AgentTask => ({
  id, name, color, state: "idle", stepIndex: 0, steps: [], source: "n8n", isIntegration: true,
});

/** The external-service pills — opt-in, max 4 shown at once. Live agent
 *  sessions (Claude Code, OpenCode, Hermes, …) are dynamic, not listed here;
 *  see `upsertSession`. */
export const INTEGRATION_AGENTS: AgentTask[] = [
  integrationTask("integration_resend", "Resend", "#22C55E"),
  integrationTask("integration_n8n", "n8n", "#F29B38"),
  integrationTask("integration_vercel", "Vercel", "#7C5CFF"),
  integrationTask("integration_github", "GitHub", "#F4505E"),
  integrationTask("integration_notion", "Notion", "#8C8C8C"),
  integrationTask("integration_calcom", "Cal.com", "#C9956A"),
  integrationTask("integration_stripe", "Stripe", "#0570DE"),
];

/** The agents Julian actually runs through Phantom. Each has a resting ghost
 *  pill that is always on the island; a live session of the same agent takes
 *  its place while it runs, and the ghost comes back when it ends. */
export const HOME_AGENT_TYPES = ["claude_code", "open_code", "hermes"] as const;

export const ghostId = (agentType: string) => `ghost_${agentType}`;

const agentGhost = (agentType: string): AgentTask => ({
  id: ghostId(agentType),
  name: agentLabel(agentType),
  color: accentHex(accentForAgentType(agentType)),
  state: "idle", stepIndex: 0, steps: ["En reposo · háblale desde el chat"],
  source: "phantom", isIntegration: false,
  agentType, connectionId: null,
});

export const TOGGLEABLE_INTEGRATION_IDS = [
  "integration_resend", "integration_n8n", "integration_vercel", "integration_github",
  "integration_notion", "integration_calcom", "integration_stripe",
];

/** What an integration poller last reported. */
export interface IntegrationInfo {
  data: Record<string, unknown>;
  error: string | null;
  loaded: boolean;
  configured: boolean;
}

export type AccentOverride = "auto" | "claude" | "openai" | "gemini" | "hermes" | "general";

export interface Settings {
  soundEnabled: boolean;
  soundVolume: number;
  autoCloseInterval: number;
  absenceInterval: number;
  activeIntegrations: string[];
  screen: "primary" | "cursor";
  autostart: boolean;
  /** Unused on Linux (no hook relay) — kept so old settings.json values don't error. */
  hooksInstalled: boolean;
  /** Default agent model label, informational only — Phantom routes itself. */
  model: string;
  /** GitHub integration falls back to `gh auth token` when on and no secret is stored. */
  useGhToken: boolean;
  accent: AccentOverride;
  language: "es" | "en";
}

export const DEFAULT_SETTINGS: Settings = {
  soundEnabled: true,
  soundVolume: 0.12,
  autoCloseInterval: 15,
  absenceInterval: 180,
  activeIntegrations: ["integration_github"],
  screen: "primary",
  autostart: true,
  hooksInstalled: false,
  model: "claude-opus-5",
  useGhToken: true,
  accent: "auto",
  language: "es",
};

type Listener = () => void;

class AppState {
  mode: IslandMode = "hidden";
  view: IslandViewName = "overview";

  tasks: AgentTask[] = [];
  focusId: string | null = null;

  stateOverride: BotStateName | null = null;

  /** Cursor in logical screen pixels, origin top-left (like AppState.mousePosition). */
  mouse = { x: 0, y: 0 };
  /** Cursor relative to the island's top-left corner. */
  mouseInIsland = { x: 0, y: 0 };

  isPinned = false;
  paused = false;

  uploadProgress = 0;
  uploadDuration = 2.4;
  fileDragOver = false;

  promptContext: PromptContext | null = null;
  droppedFile: { name: string; path: string } | null = null;
  noteMessage: string | null = null;
  searchResult: SearchResult | null = null;
  chatHistory: ChatMessage[] = [];
  pendingApproval: ApprovalInfo | null = null;
  pendingLimit: LimitInfo | null = null;

  /** Continuous mic listening (the "Live" voice mode) is on. */
  voiceActive = false;
  /** 0–1 input energy, used to drive the eye/glow reaction while listening. */
  voiceLevel = 0;
  voiceSpeaking = false;

  phantomConnected = false;

  integrations: Record<string, IntegrationInfo> = {};

  lastActivity = performance.now();

  settings: Settings = { ...DEFAULT_SETTINGS };

  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Marks the UI dirty; the island re-renders on the next frame. */
  notify() {
    for (const fn of this.listeners) fn();
  }

  get focusTask(): AgentTask | null {
    return this.tasks.find((t) => t.id === this.focusId) ?? this.tasks[0] ?? null;
  }

  get effectiveState(): BotStateName {
    return this.stateOverride ?? this.focusTask?.state ?? "idle";
  }

  get otherTasks(): AgentTask[] {
    return this.tasks.filter((t) => t.id !== this.focusId);
  }

  /** Live agent sessions only (not the integration pills). */
  get sessionTasks(): AgentTask[] {
    return this.tasks.filter((t) => !t.isIntegration);
  }

  setFocus(id: string) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    this.focusId = id;
    t.pillBadge = null;
    this.notify();
  }

  updateTask(id: string, state: BotStateName) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.state = state;
    this.notify();
  }

  appendStep(id: string, step: string) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.steps.push(step);
    if (t.steps.length > 20) t.steps.shift();
    t.stepIndex = t.steps.length - 1;
    t.stepTotal = (t.stepTotal ?? t.steps.length - 1) + 1;
    this.notify();
  }

  /** Rewrites the newest step in place (a line that is still growing). */
  replaceLastStep(id: string, step: string) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    if (t.steps.length === 0) t.steps.push(step);
    else t.steps[t.steps.length - 1] = step;
    t.stepIndex = t.steps.length - 1;
    this.notify();
  }

  setPillBadge(id: string, badge: PillBadge | null) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.pillBadge = badge;
    this.notify();
  }

  /** Shows each home agent's ghost unless a live session of it is running. */
  private syncGhosts() {
    for (const type of HOME_AGENT_TYPES) {
      const id = ghostId(type);
      const live = this.tasks.some((t) => t.connectionId && t.agentType === type);
      const idx = this.tasks.findIndex((t) => t.id === id);
      if (live && idx >= 0) {
        this.tasks.splice(idx, 1);
        if (this.focusId === id) this.focusId = null;
      }
      if (!live && idx < 0) this.tasks.push(agentGhost(type));
    }
    const rank = (t: AgentTask) => (t.isIntegration ? 2 : t.connectionId ? 0 : 1);
    const ghostOrder = HOME_AGENT_TYPES.map(ghostId) as string[];
    const intOrder = INTEGRATION_AGENTS.map((t) => t.id);
    this.tasks.sort((a, b) => {
      const r = rank(a) - rank(b);
      if (r !== 0) return r;
      if (rank(a) === 1) return ghostOrder.indexOf(a.id) - ghostOrder.indexOf(b.id);
      if (rank(a) === 2) return intOrder.indexOf(a.id) - intOrder.indexOf(b.id);
      return 0; // live sessions keep arrival order (sort is stable)
    });
    if (!this.focusId || !this.tasks.some((t) => t.id === this.focusId)) {
      this.focusId = this.tasks[0]?.id ?? null;
    }
  }

  /** Loads the opt-in integration pills (max 4), preserving any live session pills. */
  loadIntegrationTasks() {
    for (const proto of INTEGRATION_AGENTS) {
      const shouldLoad = this.settings.activeIntegrations.includes(proto.id);
      const idx = this.tasks.findIndex((t) => t.id === proto.id);
      if (shouldLoad && idx < 0) this.tasks.push({ ...proto, steps: [] });
      if (!shouldLoad && idx >= 0) this.tasks.splice(idx, 1);
    }
    this.syncGhosts();
    this.notify();
  }

  removeTask(id: string) {
    const idx = this.tasks.findIndex((t) => t.id === id);
    if (idx < 0) return;
    this.tasks.splice(idx, 1);
    if (this.focusId === id) this.focusId = null;
    this.syncGhosts();
    this.notify();
  }

  /** Creates a session pill on first `phantom://connection`/`phantom://event`
   *  for a connection id; no-ops if it already exists. Sessions sort first. */
  upsertSession(
    connectionId: string,
    agentType: string,
    color: string,
    extra: { model?: string | null; folder?: string | null; conversationId?: number | null } = {},
  ): AgentTask {
    const id = `session_${connectionId}`;
    const existing = this.tasks.find((t) => t.id === id);
    if (existing) {
      if (extra.model !== undefined) existing.model = extra.model;
      if (extra.folder !== undefined) existing.sessionCwd = extra.folder;
      if (extra.conversationId !== undefined) existing.conversationId = extra.conversationId;
      return existing;
    }
    const firstIntegration = this.tasks.findIndex((t) => t.isIntegration);
    const at = firstIntegration < 0 ? this.tasks.length : firstIntegration;
    const task: AgentTask = {
      id, name: agentLabel(agentType), color,
      state: "idle", stepIndex: 0, steps: [],
      source: "phantom", isIntegration: false,
      connectionId, agentType,
      model: extra.model ?? null, sessionCwd: extra.folder ?? null,
      conversationId: extra.conversationId ?? null,
    };
    const focusedGhost = this.focusId === ghostId(agentType);
    this.tasks.splice(at, 0, task);
    if (!this.focusId || focusedGhost) this.focusId = id;
    this.syncGhosts();
    this.notify();
    return task;
  }

  findSessionByConnection(connectionId: string): AgentTask | undefined {
    return this.tasks.find((t) => t.connectionId === connectionId);
  }

  toggleIntegration(id: string) {
    const active = this.settings.activeIntegrations;
    if (active.includes(id)) {
      this.settings.activeIntegrations = active.filter((x) => x !== id);
      if (this.focusId === id) this.focusId = this.tasks[0]?.id ?? null;
    } else {
      if (active.length >= 4) return;
      this.settings.activeIntegrations = [...active, id];
    }
    this.loadIntegrationTasks();
  }

  /** The agent the chat talks to: the focused agent if it is one of the
   *  home agents, otherwise Claude Code. */
  get chatAgentType(): string {
    const type = this.focusTask?.agentType;
    return type && (HOME_AGENT_TYPES as readonly string[]).includes(type) ? type : "claude_code";
  }

  defaultView(): IslandViewName {
    return this.tasks.length === 0 ? "empty" : "overview";
  }
}

export const State = new AppState();
