// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { StrictMode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { usePanelSplit } from "./usePanelSplit";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// Controlled container measurements exercise the hook's clamp and observer
// lifecycle. Pointer hit targets and actual grid geometry stay in browser tests.
test.each([undefined, 420])(
  "optional primary limit %s preserves widths and existing defaults",
  (primaryMax) => {
    let available = 960;
    let measure = () => {};
    const disconnect = vi.fn();
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
      () => available,
    );
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          measure = callback;
        }
        observe() {}
        disconnect = disconnect;
      },
    );
    function Workspace() {
      const split = usePanelSplit(undefined, 316, primaryMax);
      return (
        <div ref={split.ref} style={split.style} data-testid="workspace">
          <section>{split.handle}</section>
        </div>
      );
    }
    const view = render(
      <StrictMode>
        <Workspace />
      </StrictMode>,
    );
    const handle = screen.getByRole("separator");
    const workspace = screen.getByTestId("workspace");
    const width = () =>
      workspace.style.getPropertyValue("--secondary-panel-width");
    expect(width()).toBe(primaryMax ? "540px" : "");
    expect(handle).toHaveAttribute("aria-valuemin", primaryMax ? "540" : "316");
    fireEvent.keyDown(handle, { key: "Home" });
    expect(width()).toBe(primaryMax ? "540px" : "316px");
    fireEvent.keyDown(handle, { key: "End" });
    expect(width()).toBe("640px");
    available = 720;
    act(measure);
    expect(width()).toBe("400px");
    fireEvent.keyDown(handle, { key: "Home" });
    expect(width()).toBe("316px");
    fireEvent.doubleClick(handle);
    expect(width()).toBe(primaryMax ? `${720 / 2.1}px` : "");
    view.unmount();
    expect(disconnect).toHaveBeenCalledTimes(2);
  },
);
