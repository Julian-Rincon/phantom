import { describe, expect, it } from "vitest";
import { accentForAgentType, accentForModel, accentHex, agentLabel, resolveAccent } from "./accents";

describe("accentForModel", () => {
  it("maps known model families", () => {
    expect(accentForModel("claude-opus-5")).toBe("claude");
    expect(accentForModel("gpt-4o")).toBe("openai");
    expect(accentForModel("gemini-2.5-pro")).toBe("gemini");
    expect(accentForModel("hermes-3")).toBe("hermes");
  });

  it("falls back to general for unknown or missing models", () => {
    expect(accentForModel("mystery-model")).toBe("general");
    expect(accentForModel(null)).toBe("general");
    expect(accentForModel(undefined)).toBe("general");
  });
});

describe("accentForAgentType", () => {
  it("maps known agent types", () => {
    expect(accentForAgentType("claude_code")).toBe("claude");
    expect(accentForAgentType("codex")).toBe("openai");
    expect(accentForAgentType("gemini")).toBe("gemini");
    expect(accentForAgentType("hermes")).toBe("hermes");
  });

  it("falls back to general otherwise", () => {
    expect(accentForAgentType("open_code")).toBe("general");
    expect(accentForAgentType(null)).toBe("general");
  });
});

describe("resolveAccent", () => {
  it("an explicit override always wins", () => {
    expect(resolveAccent("hermes", "claude-opus-5", "claude_code")).toBe("hermes");
  });

  it("auto prefers the model over the agent type", () => {
    expect(resolveAccent("auto", "gpt-4o", "claude_code")).toBe("openai");
  });

  it("auto falls back to agent type when the model doesn't match a family", () => {
    expect(resolveAccent("auto", "some-custom-model", "hermes")).toBe("hermes");
  });

  it("auto falls back to general when nothing matches", () => {
    expect(resolveAccent("auto", null, "open_code")).toBe("general");
  });
});

describe("accentHex", () => {
  it("returns a hex colour for every accent id", () => {
    for (const id of ["claude", "openai", "gemini", "hermes", "general"] as const) {
      expect(accentHex(id)).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

describe("agentLabel", () => {
  it("humanizes known agent types", () => {
    expect(agentLabel("claude_code")).toBe("Claude Code");
    expect(agentLabel("open_code")).toBe("OpenCode");
  });

  it("title-cases unknown agent types instead of failing", () => {
    expect(agentLabel("brand_new_agent")).toBe("Brand New Agent");
  });
});
