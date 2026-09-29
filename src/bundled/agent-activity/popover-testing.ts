import { beforeEach, vi } from "vitest";

/** Browser APIs needed by the activity popover but absent from jsdom. */
export function stubPopoverBrowserApis() {
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }));
  });
}
