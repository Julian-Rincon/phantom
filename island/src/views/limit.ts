// Out-of-tokens failover card — shown on `phantom://limit`. Port of the
// spec's three actions: "Continuar con <agente>", "Elegir otro", "Esperar".

import { h, clear } from "./dom";
import { Bridge } from "../core/bridge";
import { State } from "../core/state";
import { buildLimitCard, primaryReason } from "../core/limit";
import type { ViewHost } from "./views";

export function buildLimit(): ViewHost {
  const title = h("div", { class: "title" });
  const resetLine = h("div", { class: "sub" });
  const reasonLine = h("div", { class: "detail" });
  const row = h("div", { class: "actions" });
  const el = h(
    "div",
    { class: "view" },
    h(
      "div",
      { class: "card wash" },
      h("div", { class: "stack", style: "padding:0 18px 0 116px" }, title, resetLine, reasonLine, row),
    ),
  );
  (el.querySelector(".card") as HTMLElement).style.setProperty("--wash", "rgba(245,165,36,0.42)");

  let builtFor = "";

  return {
    el,
    sync() {
      const info = State.pendingLimit;
      if (!info) return;
      const key = `${info.agent}|${info.successor?.model}|${info.runnerUp?.model}`;
      title.textContent = buildLimitCard(info).title;
      resetLine.textContent = buildLimitCard(info).resetLine;
      reasonLine.textContent = primaryReason(info) ?? "";
      if (key === builtFor) return;
      builtFor = key;
      clear(row);
      const card = buildLimitCard(info);
      for (const action of card.actions) {
        const btn = h("button", {
          class: `btn ${action.kind === "wait" ? "secondary" : "primary"}`,
          text: action.label,
        });
        btn.addEventListener("click", () => {
          if (action.kind === "wait") {
            State.pendingLimit = null;
            State.notify();
            return;
          }
          if (action.target && info.conversationId != null) {
            void Bridge.phantomHandoff(info.conversationId, action.target.agentType, action.target.model);
          }
          State.pendingLimit = null;
          State.notify();
        });
        row.append(btn);
      }
    },
  };
}
