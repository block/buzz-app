import { beforeEach, vi } from "vitest";

/** Browser APIs absent from jsdom; geometry and motion are covered in Playwright. */
export function stubAvatarBrowserApis() {
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

const noSources: readonly never[] = [];
/** The avatar picker's view of an Agents service with no avatar sources. */
export const noAvatarSources = {
  subscribe: () => () => {},
  avatarSources: () => noSources,
};
