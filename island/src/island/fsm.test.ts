import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IslandStateMachine } from "./fsm";

describe("IslandStateMachine without mouse-left events (XWayland)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("hides on its own after the greeting even if the pointer never reports leaving", () => {
    const fsm = new IslandStateMachine();
    fsm.launch();
    fsm.greetComplete();
    vi.advanceTimersByTime(fsm.greetAutoCollapseDelay * 1000);
    expect(fsm.state).toBe("petit");
    vi.advanceTimersByTime(fsm.petitToHiddenDelay * 1000);
    expect(fsm.state).toBe("hidden");
  });

  it("keeps an expanded, pinned alert open", () => {
    const fsm = new IslandStateMachine();
    fsm.pinned = true;
    fsm.forceHome();
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(fsm.state).toBe("home");
  });

  it("hovering cancels the pending hide", () => {
    const fsm = new IslandStateMachine();
    fsm.reveal();
    fsm.mouseEntered();
    vi.advanceTimersByTime(fsm.petitToHiddenDelay * 2000);
    expect(fsm.state).toBe("petit");
  });
});
