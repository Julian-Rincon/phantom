import { describe, expect, it, vi } from "vitest";
import { PhantomEngine, hexToRGB } from "./engine";

describe("PhantomEngine — state transitions", () => {
  it("starts idle with no badge", () => {
    const e = new PhantomEngine();
    expect(e.state).toBe("idle");
    expect(e.badge).toBeNull();
  });

  it("setState updates the current state and its colour target", () => {
    const e = new PhantomEngine();
    e.setState("working");
    expect(e.state).toBe("working");
    expect(e.colT).not.toEqual([0.902, 0.914, 0.933]); // no longer the idle colour
  });

  it("setState is a no-op when the state doesn't change, unless forced", () => {
    const e = new PhantomEngine();
    e.setState("working");
    const colTBefore = e.colT;
    e.tint = 0; // mutate something setState would reset, to detect a no-op
    e.setState("working");
    expect(e.tint).toBe(0); // unchanged: the second call did nothing
    e.setState("working", true);
    expect(e.colT).toBe(colTBefore); // still the same reference — force just reapplies
  });

  it("badge assignment is debounced through a brief clear-then-set tween", () => {
    vi.useFakeTimers();
    const e = new PhantomEngine();
    e.setState("working"); // working has a "dots" badge
    expect(e.badge).toBeNull(); // not applied synchronously
    vi.advanceTimersByTime(150);
    expect(e.badge).not.toBeNull();
    expect(e.badge?.kind).toBe("dots");
    vi.useRealTimers();
  });

  it("dizzy state carries no badge", () => {
    const e = new PhantomEngine();
    e.setState("dizzy");
    expect(e.cfg.badge).toBeNull();
  });
});

describe("PhantomEngine — emotions", () => {
  it("triggerEmote sets the eye override to the emote's shape immediately", () => {
    const e = new PhantomEngine();
    e.triggerEmote("love");
    expect(e.eyeOverride).toBe("heart");
    expect(e.eyeOverrideUntil).toBeGreaterThan(performance.now() / 1000);
  });

  it("triggerEmote('proud') maps to a star eye", () => {
    const e = new PhantomEngine();
    e.triggerEmote("proud");
    expect(e.eyeOverride).toBe("star");
  });

  it("setPermanentEmote('happy') locks the eye open-ended, until cleared", () => {
    const e = new PhantomEngine();
    e.setPermanentEmote("happy");
    expect(e.eyeOverride).toBe("happy");
    expect(e.eyeOverrideUntil).toBe(Number.POSITIVE_INFINITY);

    e.setPermanentEmote(null);
    expect(e.eyeOverride).toBeNull();
    expect(e.eyeOverrideUntil).toBe(0);
  });
});

describe("PhantomEngine — dizzy after three quick slaps", () => {
  it("fires onDizzy on the third slap within the window, not before", () => {
    const e = new PhantomEngine();
    let dizzyCount = 0;
    e.onDizzy = () => { dizzyCount++; };

    e.slap();
    expect(dizzyCount).toBe(0);
    expect(e.eyeOverride).toBe("line"); // annoyed flash on a non-triggering slap

    e.slap();
    expect(dizzyCount).toBe(0);

    e.slap();
    expect(dizzyCount).toBe(1);
  });

  it("slap() during the dizzy state itself is ignored", () => {
    const e = new PhantomEngine();
    e.setState("dizzy");
    let dizzyCount = 0;
    e.onDizzy = () => { dizzyCount++; };
    e.slap();
    e.slap();
    e.slap();
    expect(dizzyCount).toBe(0);
  });
});

describe("PhantomEngine — colour helpers", () => {
  it("hexToRGB converts a hex string to 0..1 components", () => {
    expect(hexToRGB("#60a5fa")).toEqual([
      0x60 / 255, 0xa5 / 255, 0xfa / 255,
    ]);
  });

  it("defaults to the general Phantom blue accent", () => {
    const e = new PhantomEngine();
    const [r, g, b] = e.accentColor;
    expect(r).toBeCloseTo(0x60 / 255, 2);
    expect(g).toBeCloseTo(0xa5 / 255, 2);
    expect(b).toBeCloseTo(0xfa / 255, 2);
  });
});

describe("PhantomEngine — morph (file-swallow) lifecycle", () => {
  it("resetMorph drops the morph value and any in-flight tween", () => {
    const e = new PhantomEngine();
    e.animateMorph(1);
    e.resetMorph();
    expect(e.morph).toBe(0);
  });
});
