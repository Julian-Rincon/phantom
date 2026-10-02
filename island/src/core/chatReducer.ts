// Pure reducer over `ChatMessage[]` for the streaming chat view. Kept free of
// Bridge/State/DOM so it is trivial to unit test: feed it actions, assert the
// resulting array. `island/chat.ts` (the real event wiring) is a thin shell
// around this.

import type { ChatMessage } from "./state";

export type ChatAction =
  | { type: "user"; id: number; content: string }
  | { type: "delta"; id: number; textDelta: string }
  | { type: "done"; id: number; agent?: string; model?: string }
  | { type: "error"; id: number }
  | { type: "reset" };

export function chatReducer(messages: ChatMessage[], action: ChatAction): ChatMessage[] {
  switch (action.type) {
    case "reset":
      return [];

    case "user":
      return [...messages, { id: action.id, role: "user", content: action.content }];

    case "delta": {
      const idx = messages.findIndex((m) => m.id === action.id);
      if (idx === -1) {
        return [
          ...messages,
          { id: action.id, role: "assistant", content: action.textDelta, streaming: true },
        ];
      }
      const next = messages.slice();
      const m = next[idx];
      next[idx] = { ...m, content: m.content + action.textDelta, streaming: true };
      return next;
    }

    case "done": {
      const idx = messages.findIndex((m) => m.id === action.id);
      if (idx === -1) return messages;
      const next = messages.slice();
      const m = next[idx];
      next[idx] = { ...m, streaming: false, agent: action.agent, model: action.model };
      return next;
    }

    case "error": {
      const idx = messages.findIndex((m) => m.id === action.id);
      if (idx === -1) return messages;
      const next = messages.slice();
      next[idx] = { ...next[idx], streaming: false };
      return next;
    }

    default:
      return messages;
  }
}
