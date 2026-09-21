// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../relay/session";
import type { ThreadSnapshot, ThreadView } from "../relay/threads";
import { keypair } from "../relay/testing";
import { ThreadPanel } from "./ThreadPanel";

// Only the unrelated composer is isolated; actual React and panel lifecycle run.
vi.mock("./MessageComposer", () => ({ MessageComposer: () => null }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it.each([
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  " ",
  null,
])(
  "pending-history scroll intent: key=%s (null keeps initial positioning)",
  async (key) => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    const owner = createRelaySession({
      viewer: keypair().pubkey,
      relayAuthor: keypair().pubkey,
      media: (url) => url,
      async query() {
        return [];
      },
    });
    let snapshot: ThreadSnapshot = {
      status: "loading",
      root: undefined,
      replies: [],
      error: undefined,
      canLoadMore: false,
      limited: false,
    };
    const listeners = new Set<() => void>();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const view: ThreadView = {
      snapshot: () => snapshot,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      refresh: () => pending,
      loadMore: async () => {},
      dispose: () => {},
    };
    const session = { ...owner.session, thread: () => view };
    try {
      render(
        <ThreadPanel
          session={session}
          scope="test"
          channelName="One"
          channelId="one"
          messageId={"a".repeat(64)}
          close={() => {}}
          onOpenLink={() => false}
        />,
      );
      const history = screen.getByRole("region", { name: "Thread messages" });
      // jsdom does not lay out. This tests whether production requests a scroll,
      // not real browser scrolling, which remains covered by browser journeys.
      Object.defineProperty(history, "scrollHeight", { value: 1000 });
      history.scrollTop = 123;
      if (key !== null) fireEvent.keyDown(history, { key });
      await act(async () => {
        snapshot = { ...snapshot, status: "ready" };
        for (const listener of listeners) listener();
        release();
        await pending;
      });
      expect(history.scrollTop).toBe(key === null ? 1000 : 123);
    } finally {
      release();
      cleanup();
      owner.dispose();
    }
  },
);
