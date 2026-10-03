import { describe, expect, it } from "vitest";
import { buildLimitCard, primaryReason } from "./limit";
import type { LimitInfo } from "./state";
import { setLang } from "./i18n";

const base: LimitInfo = {
  agent: "Claude Opus 5",
  resetHint: "5am",
  successor: { agent: "Claude Sonnet 5", agentType: "claude_code", model: "claude-sonnet-5", reason: "más rápido y disponible ahora" },
  runnerUp: { agent: "OpenCode", agentType: "open_code", model: "gpt-4o", reason: "segunda mejor opción medida" },
  conversationId: 42,
};

describe("buildLimitCard", () => {
  it("offers continue, choose-another and wait when both candidates exist", () => {
    setLang("es");
    const card = buildLimitCard(base);
    expect(card.actions.map((a) => a.kind)).toEqual(["continue", "chooseOther", "wait"]);
    expect(card.title).toContain("Claude Opus 5");
    expect(card.resetLine).toContain("5am");
  });

  it("hands off by agent id, not by the label it shows", () => {
    const card = buildLimitCard(base);
    expect(card.actions[0].target).toEqual({ agentType: "claude_code", model: "claude-sonnet-5" });
    expect(card.actions[1].target).toEqual({ agentType: "open_code", model: "gpt-4o" });
  });

  it("drops the continue action when there is no successor", () => {
    const card = buildLimitCard({ ...base, successor: null });
    expect(card.actions.map((a) => a.kind)).toEqual(["chooseOther", "wait"]);
  });

  it("drops chooseOther when there is no runner-up", () => {
    const card = buildLimitCard({ ...base, runnerUp: null });
    expect(card.actions.map((a) => a.kind)).toEqual(["continue", "wait"]);
  });

  it("always keeps the wait action, even with no candidates", () => {
    const card = buildLimitCard({ ...base, successor: null, runnerUp: null });
    expect(card.actions.map((a) => a.kind)).toEqual(["wait"]);
  });

  it("omits the reset line when no hint was given", () => {
    const card = buildLimitCard({ ...base, resetHint: "" });
    expect(card.resetLine).toBe("");
  });
});

describe("primaryReason", () => {
  it("returns the successor's measured reason", () => {
    expect(primaryReason(base)).toBe("más rápido y disponible ahora");
  });

  it("is null without a successor", () => {
    expect(primaryReason({ ...base, successor: null })).toBeNull();
  });
});
