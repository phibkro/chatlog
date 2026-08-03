/* oxlint-disable vitest/expect-expect -- Foldkit Scene.expect performs the assertions. */
import { describe, test } from "bun:test";
import { Scene } from "foldkit";

import { memoryLabFixture } from "./fixture";
import { LoadedMemoryLab, SelectedJudgment, init, update, view } from "./main";

if (globalThis.CSS === undefined)
  Object.defineProperty(globalThis, "CSS", {
    value: { escape: (value: string) => value },
  });

const readyModel = () => update(init()[0], LoadedMemoryLab({ lab: memoryLabFixture() }))[0];

describe("Memory Lab scene", () => {
  test("presents a one-task accessible review surface", () => {
    Scene.scene(
      { update, view },
      Scene.with(readyModel()),
      Scene.expect(Scene.role("heading", { name: "Memory Lab" })).toExist(),
      Scene.expect(Scene.label("Your name")).toExist(),
      Scene.expect(Scene.role("progressbar", { name: "Memory review progress" })).toExist(),
      Scene.expect(Scene.role("heading", { name: "Scenario" })).toExist(),
      Scene.expect(Scene.text("AI proposal")).toExist(),
      Scene.expect(Scene.role("radio", { name: "Correct" })).toExist(),
      Scene.expect(Scene.role("radio", { name: "Incorrect" })).toExist(),
      Scene.expect(Scene.role("radio", { name: "Unsure" })).toExist(),
      Scene.expect(Scene.role("radio", { name: "Positive" })).toExist(),
      Scene.expect(Scene.role("radio", { name: "Negative" })).toExist(),
      Scene.expect(Scene.role("radio", { name: "Neutral" })).toExist(),
      Scene.expect(Scene.label("Note (optional)")).toExist(),
      Scene.expect(Scene.role("button", { name: "Finish review" })).toBeDisabled(),
    );
  });

  test("renders untrusted evidence as inert text", () => {
    Scene.scene(
      { update, view },
      Scene.with(readyModel()),
      Scene.expect(Scene.text("<img src=x alt=owned> is inert historical text.")).toExist(),
      Scene.expect(Scene.role("img", { name: "owned" })).toBeAbsent(),
    );
  });

  test("incorrect judgment reveals optional correction instead of requiring expert labels", () => {
    const correction = update(readyModel(), SelectedJudgment({ value: "incorrect" }))[0];
    Scene.scene(
      { update, view },
      Scene.with(correction),
      Scene.expect(Scene.role("radio", { name: "Incorrect", checked: true })).toExist(),
      Scene.expect(Scene.label("Correction or feedback (optional)")).toExist(),
    );
  });

  test("unsure needs neither an outcome nor text", () => {
    const unsure = update(readyModel(), SelectedJudgment({ value: "unsure" }))[0];
    Scene.scene(
      { update, view },
      Scene.with(unsure),
      Scene.expect(Scene.role("radio", { name: "Unsure", checked: true })).toExist(),
      Scene.expect(Scene.role("radio", { name: "Positive" })).toBeDisabled(),
      Scene.expect(Scene.label("Missing context (optional)")).toExist(),
    );
  });
});
