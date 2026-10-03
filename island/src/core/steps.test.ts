import { describe, expect, it } from "vitest";
import { State } from "./state";

describe("session steps", () => {
  it("keeps counting past the 20-step cap so the ticker still sees new rows", () => {
    State.tasks = [];
    const task = State.upsertSession("c-steps", "claude_code", "#fff");
    for (let i = 0; i < 25; i++) State.appendStep(task.id, `step ${i}`);
    expect(task.steps).toHaveLength(20);
    expect(task.steps.at(-1)).toBe("step 24");
    expect(task.stepTotal).toBe(25);
  });

  it("rewrites the growing text line in place", () => {
    const task = State.upsertSession("c-text", "claude_code", "#fff");
    State.appendStep(task.id, "Hola");
    State.replaceLastStep(task.id, "Hola, ya");
    expect(task.steps.at(-1)).toBe("Hola, ya");
    expect(task.stepTotal).toBe(1);
  });
});
