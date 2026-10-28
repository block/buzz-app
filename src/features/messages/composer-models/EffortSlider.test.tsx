// @vitest-environment jsdom
import { render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { EffortSlider } from "./EffortSlider";

afterEach(() => {
  delete document.documentElement.dataset.keyboardInput;
  vi.unstubAllGlobals();
});

it("mirrors document keyboard input onto the slider for its snap rule", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const root = document.documentElement;
  root.dataset.keyboardInput = "";
  const view = render(
    <EffortSlider
      name="Ada"
      avatarSrc={undefined}
      model={() => "Model"}
      efforts={[
        { id: "low", label: "Low" },
        { id: "high", label: "High" },
      ]}
      resting="low"
      value={undefined}
      disabled={false}
      pick={() => {}}
    />,
  );
  const slider = view.container.firstElementChild as HTMLElement;
  // The document observer delivers its records asynchronously.
  const snapping = (expected: boolean) =>
    waitFor(() =>
      expect(slider.hasAttribute("data-keyboard-snap")).toBe(expected),
    );
  await snapping(true);
  delete root.dataset.keyboardInput;
  await snapping(false);
  root.dataset.keyboardInput = "";
  await snapping(true);
  view.unmount();
});
