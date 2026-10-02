// Phantom accent colours — the eye/rim glow colour, keyed by the active agent
// or model. Mirrors the dark shades of `PHANTOM_ACCENTS` in
// codeg/src/lib/phantom-ui.ts so the island and the Phantom desktop app read
// as the same product family.

export type AccentId = "claude" | "openai" | "gemini" | "hermes" | "general";

/** Dark-mode shade only — the island never renders on a light surface. */
export const ACCENTS: Record<AccentId, string> = {
  claude: "#e08a68",
  openai: "#2dd4bf",
  gemini: "#a78bfa",
  hermes: "#22d3ee",
  general: "#60a5fa",
};

const MODEL_PATTERNS: [RegExp, AccentId][] = [
  [/claude|anthropic|opus|sonnet|haiku/i, "claude"],
  [/gpt|openai|o[134]\b|codex/i, "openai"],
  [/gemini|bard/i, "gemini"],
  [/hermes/i, "hermes"],
];

/** Maps a model id / agent name / session source to an accent id. */
export function accentForModel(modelOrAgent: string | null | undefined): AccentId {
  if (!modelOrAgent) return "general";
  for (const [re, id] of MODEL_PATTERNS) {
    if (re.test(modelOrAgent)) return id;
  }
  return "general";
}

export function accentHex(id: AccentId): string {
  return ACCENTS[id];
}

/** Resolves the effective accent: the settings override wins, otherwise the
 *  model (falling back to the agent type) decides. */
export function resolveAccent(
  override: AccentId | "auto",
  model: string | null | undefined,
  agentType: string | null | undefined,
): AccentId {
  if (override !== "auto") return override;
  const byModel = accentForModel(model);
  if (byModel !== "general") return byModel;
  return accentForAgentType(agentType);
}

const AGENT_LABELS: Record<string, string> = {
  claude_code: "Claude Code",
  codex: "Codex",
  open_code: "OpenCode",
  gemini: "Gemini CLI",
  open_claw: "OpenClaw",
  cline: "Cline",
  hermes: "Hermes",
  code_buddy: "CodeBuddy",
  kimi_code: "Kimi Code",
  pi: "Pi",
  grok: "Grok",
  cursor: "Cursor",
  deep_seek: "DeepSeek",
  qoder: "Qoder",
  antigravity: "Antigravity",
};

/** Human label for a Phantom `agentType` — falls back to a title-cased id for
 *  anything not in the known list (new agents show up readably, not as "?"). */
export function agentLabel(agentType: string | null | undefined): string {
  if (!agentType) return "Agente";
  return (
    AGENT_LABELS[agentType] ??
    agentType.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

/** Phantom `agentType` ("claude_code", "codex", "open_code", "gemini", "hermes", …)
 *  → accent, for pills that don't carry a model id yet. */
export function accentForAgentType(agentType: string | null | undefined): AccentId {
  if (!agentType) return "general";
  const s = agentType.toLowerCase();
  if (s.includes("claude")) return "claude";
  if (s.includes("hermes")) return "hermes";
  if (s.includes("codex") || s.includes("openai") || s.includes("open_claw") || s.includes("cline")) return "openai";
  if (s.includes("gemini")) return "gemini";
  return "general";
}
