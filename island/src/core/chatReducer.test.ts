import { describe, expect, it } from "vitest";
import { chatReducer } from "./chatReducer";
import type { ChatMessage } from "./state";

describe("chatReducer", () => {
  it("appends a user message", () => {
    const next = chatReducer([], { type: "user", id: 1, content: "hola" });
    expect(next).toEqual([{ id: 1, role: "user", content: "hola" }]);
  });

  it("creates a streaming assistant message on the first delta", () => {
    const next = chatReducer([], { type: "delta", id: 2, textDelta: "Ho" });
    expect(next).toEqual([{ id: 2, role: "assistant", content: "Ho", streaming: true }]);
  });

  it("accumulates successive deltas onto the same message", () => {
    let msgs: ChatMessage[] = [];
    msgs = chatReducer(msgs, { type: "delta", id: 2, textDelta: "Ho" });
    msgs = chatReducer(msgs, { type: "delta", id: 2, textDelta: "la!" });
    expect(msgs).toEqual([{ id: 2, role: "assistant", content: "Hola!", streaming: true }]);
  });

  it("leaves other messages untouched when appending a delta", () => {
    let msgs: ChatMessage[] = [{ id: 1, role: "user", content: "hola" }];
    msgs = chatReducer(msgs, { type: "delta", id: 2, textDelta: "Hey" });
    expect(msgs[0]).toEqual({ id: 1, role: "user", content: "hola" });
  });

  it("marks a message done and attaches the answering agent/model", () => {
    let msgs: ChatMessage[] = [];
    msgs = chatReducer(msgs, { type: "delta", id: 2, textDelta: "Hola!" });
    msgs = chatReducer(msgs, { type: "done", id: 2, agent: "Claude", model: "claude-sonnet-5" });
    expect(msgs).toEqual([
      { id: 2, role: "assistant", content: "Hola!", streaming: false, agent: "Claude", model: "claude-sonnet-5" },
    ]);
  });

  it("done on an unknown id is a no-op", () => {
    const msgs: ChatMessage[] = [{ id: 1, role: "user", content: "hola" }];
    expect(chatReducer(msgs, { type: "done", id: 999 })).toBe(msgs);
  });

  it("error clears the streaming flag without touching content", () => {
    let msgs: ChatMessage[] = [];
    msgs = chatReducer(msgs, { type: "delta", id: 2, textDelta: "Algo" });
    msgs = chatReducer(msgs, { type: "error", id: 2 });
    expect(msgs).toEqual([{ id: 2, role: "assistant", content: "Algo", streaming: false }]);
  });

  it("reset clears the whole history", () => {
    const msgs: ChatMessage[] = [{ id: 1, role: "user", content: "hola" }];
    expect(chatReducer(msgs, { type: "reset" })).toEqual([]);
  });
});
