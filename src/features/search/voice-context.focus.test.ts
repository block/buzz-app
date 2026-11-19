// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { trackPointerPosition } from "./voice-context";

afterEach(() => {
  document.body.innerHTML = "";
});

const focusIn = (element: HTMLElement) =>
  element.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

it("lets a resting pointer win over focus the voice box moved itself", () => {
  document.body.innerHTML = `<input id="field" /><textarea id="composer"></textarea>`;
  const field = document.getElementById("field") as HTMLElement;
  const composer = document.getElementById("composer") as HTMLElement;
  const tracker = trackPointerPosition(window);
  try {
    window.dispatchEvent(
      new MouseEvent("pointermove", { clientX: 5, clientY: 5 }),
    );
    // The box opens and focuses its field; on close, focus returns.
    focusIn(field);
    tracker.forgetFocus();
    focusIn(composer);
    const after = tracker.current();
    expect(after.focusAt ?? 0).toBeLessThan(after.pointerAt ?? 0);

    // A key the person presses afterwards makes focus count again.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    focusIn(field);
    const moved = tracker.current();
    expect(moved.focusAt ?? 0).toBeGreaterThan(moved.pointerAt ?? 0);
  } finally {
    tracker.stop();
  }
});
