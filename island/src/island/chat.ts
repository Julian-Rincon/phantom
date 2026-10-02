// Phantom chat controller — owns the streaming reducer and the voice
// sentence-by-sentence TTS hookup. The DOM view (`views/chat.ts`) is a thin
// shell around `sendChat`/`resetChat`/subscribing to `State.chatHistory`.

import { Bridge, onEvent, type ChatDeltaPayload, type ChatDonePayload, type ChatErrorPayload } from "../core/bridge";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import { chatReducer } from "../core/chatReducer";
import { SentenceChunker } from "../voice/sentence-chunker";
import { speakSentence, stopSpeaking } from "../voice/controller";

let nextId = 1;
let activeId: number | null = null;
let chunker: SentenceChunker | null = null;

function applyingVoice(): boolean {
  return State.voiceActive;
}

/** A send that never reached Phantom: same UI as a streamed `chat-error`. */
function failTurn(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  if (activeId != null) {
    State.chatHistory = chatReducer(State.chatHistory, { type: "error", id: activeId });
  }
  State.stateOverride = null;
  State.noteMessage = message;
  State.view = "note";
  Sound.play("error");
  activeId = null;
  chunker = null;
  State.notify();
}

export function registerChatHandlers() {
  void onEvent<ChatDeltaPayload>("island://chat-delta", (p) => {
    if (activeId == null) return;
    State.chatHistory = chatReducer(State.chatHistory, { type: "delta", id: activeId, textDelta: p.text });
    if (applyingVoice() && chunker) {
      const full = State.chatHistory.find((m) => m.id === activeId)?.content ?? "";
      for (const sentence of chunker.push(full)) void speakSentence(sentence);
    }
    State.notify();
  });

  void onEvent<ChatDonePayload>("island://chat-done", () => {
    if (activeId == null) return;
    const id = activeId;
    if (applyingVoice() && chunker) {
      const tail = chunker.flush();
      if (tail) void speakSentence(tail);
    }
    State.chatHistory = chatReducer(State.chatHistory, { type: "done", id });
    State.stateOverride = null;
    Sound.play("finish");
    activeId = null;
    chunker = null;
    State.notify();
  });

  void onEvent<ChatErrorPayload>("island://chat-error", (p) => failTurn(p.message));
}

/** Starts a new turn: pushes the user bubble, opens the streaming assistant
 *  bubble, and sends the request. `attachments` are absolute paths. */
export function sendChat(text: string, attachments: string[] = []) {
  const userId = nextId++;
  State.chatHistory = chatReducer(State.chatHistory, { type: "user", id: userId, content: text });
  activeId = nextId++;
  chunker = new SentenceChunker({ codeBlockNote: "Bloque de código." });
  State.stateOverride = "thinking";
  State.notify();
  Bridge.islandChatSend(text, attachments, State.chatAgentType).catch(failTurn);
}

export function askAboutFile(path: string, question: string) {
  const userId = nextId++;
  State.chatHistory = chatReducer(State.chatHistory, { type: "user", id: userId, content: question });
  activeId = nextId++;
  chunker = new SentenceChunker({ codeBlockNote: "Bloque de código." });
  State.stateOverride = "thinking";
  State.notify();
  Bridge.islandFileAsk(path, question, State.chatAgentType).catch(failTurn);
}

export function resetChat() {
  void Bridge.islandChatReset();
  State.chatHistory = [];
  activeId = null;
  chunker = null;
  stopSpeaking();
  State.notify();
}
