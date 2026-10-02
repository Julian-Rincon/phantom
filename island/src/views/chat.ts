// Chat view — Phantom chat (streaming) with an optional "Live" voice mode.

import { h, svg, clear } from "./dom";
import { ICONS } from "./icons";
import { Sound } from "../core/sound";
import { State, type ChatMessage } from "../core/state";
import { t } from "../core/i18n";
import { sendChat, resetChat, askAboutFile } from "../island/chat";
import { startVoice, stopVoice } from "../voice/controller";
import type { ViewHost } from "./views";

function bubble(message: ChatMessage): HTMLElement {
  if (message.role === "user") {
    return h(
      "div",
      { class: "chat-row user" },
      h("div", { class: "bubble", text: message.content }),
    );
  }
  const reply = h("div", { class: "reply", text: message.content });
  const wrap = h("div", { class: "chat-row" }, reply);
  if (!message.streaming && message.agent) {
    wrap.append(h("div", { class: "answered-by", text: t("chat.answeredBy", { agent: message.agent }) }));
  }
  return wrap;
}

function typingDots(): HTMLElement {
  return h(
    "div",
    { class: "chat-row" },
    h("div", { class: "typing" }, h("i"), h("i"), h("i")),
  );
}

/** The coloured chip showing what the question is about (a dropped file). */
function contextChip(label: string): HTMLElement {
  const chip = h("div", { class: "chip" }, h("i", { class: "chip-dot" }), h("span", { text: label }));
  requestAnimationFrame(() => chip.classList.add("settled"));
  return chip;
}

export function buildPrompt(onHeightChange: () => void): ViewHost {
  const chipRow = h("div", { class: "chip-row" });
  const log = h("div", { class: "chat-log" });
  const input = h("input", {
    type: "text",
    class: "chat-input",
    placeholder: t("chat.placeholder.empty"),
    spellcheck: "false",
  }) as HTMLInputElement;
  const send = h("button", { class: "send-btn", title: t("chat.send") }, svg(ICONS.arrowUp, 11));
  const mic = h("button", { class: "mic-btn", title: t("chat.voice.start") }, svg(ICONS.mic, 13));
  const newChat = h("button", { class: "new-chat-btn", title: t("chat.newChat") }, svg(ICONS.plus, 11));
  const bar = h("div", { class: "chat-bar" }, mic, input, send);

  const el = h(
    "div",
    { class: "view" },
    h(
      "div",
      { class: "card wash chat-card" },
      h("div", { class: "chat-body" }, h("div", { class: "chat-top" }, chipRow, h("div", { class: "grow" }), newChat), log, bar),
    ),
  );
  (el.querySelector(".card") as HTMLElement).style.setProperty("--wash", "rgba(99,102,241,0.5)");

  function submit() {
    const query = input.value.trim();
    if (!query || State.stateOverride === "thinking") return;
    input.value = "";
    Sound.play("send");
    // The dropped file seeds only the opening question of a fresh conversation
    // — after that it is just more chat, like the Windows version's one-shot
    // context attach.
    const file = State.droppedFile;
    if (file && State.chatHistory.length === 0) askAboutFile(file.path, query);
    else sendChat(query);
    onHeightChange();
  }

  async function toggleVoice() {
    if (State.voiceActive) {
      stopVoice();
      mic.classList.remove("on");
      Sound.play("blip");
      return;
    }
    try {
      await startVoice((text) => {
        input.value = text;
        submit();
      });
      mic.classList.add("on");
      Sound.play("open");
    } catch (err) {
      console.error("[phantom-island] mic permission denied", err);
    }
  }

  send.addEventListener("click", submit);
  mic.addEventListener("click", () => void toggleVoice());
  newChat.addEventListener("click", () => {
    resetChat();
    onHeightChange();
  });
  input.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") {
      e.preventDefault();
      submit();
    }
    e.stopPropagation(); // Escape closes the island, not the chat
  });

  return {
    el,
    sync() {
      const file = State.droppedFile;
      const wantChip = file?.name ?? "";
      if (chipRow.dataset.label !== wantChip) {
        chipRow.dataset.label = wantChip;
        clear(chipRow);
        if (wantChip) chipRow.append(contextChip(wantChip));
      }

      const thinking = State.stateOverride === "thinking" && !State.chatHistory.some((m) => m.streaming);
      const contentKey = `${State.chatHistory.map((m) => `${m.id}:${m.content.length}`).join(",")}|${thinking}`;
      if (log.dataset.content !== contentKey) {
        log.dataset.content = contentKey;
        clear(log);
        for (const m of State.chatHistory) log.append(bubble(m));
        if (thinking) log.append(typingDots());
        log.scrollTop = log.scrollHeight;
      }

      input.placeholder = State.chatHistory.length === 0 ? t("chat.placeholder.empty") : t("chat.placeholder.continue");
      mic.classList.toggle("on", State.voiceActive);
      mic.title = State.voiceActive ? t("chat.voice.stop") : t("chat.voice.start");
      mic.classList.toggle("listening", State.voiceActive && !State.voiceSpeaking);
      mic.classList.toggle("speaking", State.voiceSpeaking);
    },
    focus() {
      input.focus();
      input.select();
    },
  };
}
