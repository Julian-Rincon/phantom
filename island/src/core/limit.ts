// Pure logic for the out-of-tokens failover card. Kept separate from the view
// so the button/label/action wiring can be unit tested without the DOM.

import type { LimitInfo } from "./state";
import { t } from "./i18n";

export type LimitActionKind = "continue" | "chooseOther" | "wait";

export interface LimitAction {
  kind: LimitActionKind;
  label: string;
  /** Present only for "continue" / "chooseOther" — who to hand off to. */
  target?: { agentType: string; model: string };
}

export interface LimitCard {
  title: string;
  /** e.g. "se restablece 5am" — empty string when no hint was given. */
  resetLine: string;
  actions: LimitAction[];
}

/** Builds the card's text + button list from a `phantom://limit` payload. */
export function buildLimitCard(info: LimitInfo): LimitCard {
  const actions: LimitAction[] = [];

  if (info.successor) {
    actions.push({
      kind: "continue",
      label: t("limit.continueWith", { agent: info.successor.agent }),
      target: { agentType: info.successor.agentType, model: info.successor.model },
    });
  }
  if (info.runnerUp) {
    actions.push({
      kind: "chooseOther",
      label: t("limit.chooseOther"),
      target: { agentType: info.runnerUp.agentType, model: info.runnerUp.model },
    });
  }
  actions.push({ kind: "wait", label: t("limit.wait") });

  return {
    title: t("limit.title", { agent: info.agent }),
    resetLine: info.resetHint ? t("limit.resetHint", { time: info.resetHint }) : "",
    actions,
  };
}

/** The reason line shown under whichever offer is primary, already localized
 *  Spanish text from the measured-data payload — passed through verbatim. */
export function primaryReason(info: LimitInfo): string | null {
  return info.successor?.reason ?? null;
}
