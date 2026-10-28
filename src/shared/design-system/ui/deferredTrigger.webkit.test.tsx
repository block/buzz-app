// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

it("decides a target-less focus as macOS WebKit's always-mounted hint does", async () => {
  // Base UI and the deferred trigger read the platform when they load.
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  vi.stubGlobal("CSS", { supports: () => true });
  vi.resetModules();
  const { Tooltip: BaseTooltip } = await import("@base-ui/react/tooltip");
  const { Tooltip } = await import("./Tooltip");
  render(
    <>
      <BaseTooltip.Root>
        <BaseTooltip.Trigger render={<button type="button">Base</button>} />
        <BaseTooltip.Portal>
          <BaseTooltip.Positioner>
            <BaseTooltip.Popup>Base hint</BaseTooltip.Popup>
          </BaseTooltip.Positioner>
        </BaseTooltip.Portal>
      </BaseTooltip.Root>
      <Tooltip content="Deferred hint">
        <button type="button">Deferred</button>
      </Tooltip>
      <button type="button">Elsewhere</button>
    </>,
  );
  const settle = () =>
    act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  const focusAlone = async (name: string) => {
    const button = screen.getByRole("button", { name });
    act(() => button.focus());
    await settle();
    const shown = !!screen.queryByText(`${name} hint`);
    act(() => button.blur());
    await settle();
    return shown;
  };
  // A press elsewhere, then focus moved by script: neither shows its hint.
  fireEvent.pointerDown(screen.getByRole("button", { name: "Elsewhere" }));
  expect(await focusAlone("Base")).toBe(false);
  expect(await focusAlone("Deferred")).toBe(false);
  // After keyboard input, the same focus shows both.
  fireEvent.keyDown(window, { key: "Shift" });
  expect(await focusAlone("Base")).toBe(true);
  expect(await focusAlone("Deferred")).toBe(true);
});
