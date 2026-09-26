// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { ChannelTimeline } from "./ChannelTimeline";
import { createRelaySession } from "../relay/session";
import type { ChannelWindow } from "../relay/contracts";
import { keypair, message, scriptedTransport } from "../relay/testing";
import { writeView } from "../../shared/view-state";

// Real React lifecycle; only the virtualizer's imperative layout boundary is
// modeled here. Browser journeys retain the actual same-message/4px contract.
const scroll = vi.hoisted(() => ({ toIndex: vi.fn(), toOffset: vi.fn() }));
vi.mock("virtua", async () => {
  const { forwardRef, useImperativeHandle } = await import("react");
  return {
    Virtualizer: forwardRef(function Virtualizer(
      { children }: { children: ReactNode },
      ref,
    ) {
      useImperativeHandle(ref, () => ({
        cache: undefined,
        scrollToIndex: scroll.toIndex,
        scrollTo: scroll.toOffset,
      }));
      return <ol style={{ height: 2000 }}>{children}</ol>;
    }),
  };
});
const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
const owners: { dispose(): void }[] = [];
beforeEach(() => {
  scroll.toIndex.mockClear();
  scroll.toOffset.mockClear();
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(2000);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
  frames.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});
async function frame() {
  await act(async () => {
    for (const [id, callback] of [...frames]) {
      frames.delete(id);
      callback(0);
    }
  });
}
function mount(bottom = false) {
  const viewer = keypair(),
    relay = keypair();
  const target = message(viewer, "c", "Saved reading anchor", 1);
  const owner = createRelaySession(
    scriptedTransport(viewer.pubkey, relay.pubkey).transport,
  );
  owners.push(owner);
  writeView("scope", "scroll:c", {
    offset: 900,
    bottom,
    anchor: { id: target.id, y: 42 },
  });
  const window: ChannelWindow = {
    channelId: "c",
    status: "ready",
    freshness: "cached",
    hasMore: false,
    loadingOlder: false,
    error: undefined,
    rows: [
      {
        id: target.id,
        channelId: "c",
        authorId: viewer.pubkey,
        content: target.content,
        createdAt: 1,
        mentions: [],
        participants: [],
        attachments: [],
        reactions: [],
        replyCount: 0,
      },
    ],
  };
  const tree = (snapshot: ChannelWindow, revealMessageId?: string) => (
    <StrictMode>
      <ChannelTimeline
        channelId="c"
        scope="scope"
        queries={owner.session}
        window={snapshot}
        revealMessageId={revealMessageId}
        onOpenLink={() => false}
      />
    </StrictMode>
  );
  const result = render(tree(window));
  return {
    reveal() {
      const first = window.rows[0];
      if (!first) throw new Error("Missing fixture row");
      const sent = { ...first, id: "sent", content: "New message" };
      result.rerender(
        tree({ ...window, rows: [...window.rows, sent] }, sent.id),
      );
    },
    promote() {
      result.rerender(
        tree({ ...window, freshness: "verified", rows: [...window.rows] }),
      );
    },
    async measured() {
      await act(async () => {
        screen.getByRole("list").style.height = "2120px";
        await Promise.resolve(); // deliver the real MutationObserver before rAF
      });
    },
  };
}
for (const measurement of ["before", "after"] as const) {
  it(`retains the saved anchor when measurement arrives ${measurement} row promotion`, async () => {
    const h = mount();
    await frame();
    expect(scroll.toIndex).toHaveBeenLastCalledWith(0, {
      align: "start",
      offset: -42,
    });
    scroll.toIndex.mockClear();
    if (measurement === "before") await h.measured();
    h.promote();
    await frame();
    if (measurement === "after") {
      scroll.toIndex.mockClear();
      await h.measured();
      await frame();
    }
    expect(scroll.toIndex).toHaveBeenLastCalledWith(0, {
      align: "start",
      offset: -42,
    });
  });
  it(`reader input cancels restoration with measurement ${measurement} row promotion`, async () => {
    const h = mount();
    await frame();
    scroll.toIndex.mockClear();
    if (measurement === "before") await h.measured();
    fireEvent.wheel(
      screen.getByRole("region", { name: "Channel message history" }),
    );
    h.promote();
    await frame();
    if (measurement === "after") {
      await h.measured();
      await frame();
    }
    expect(scroll.toIndex).not.toHaveBeenCalled();
  });
}

it.each([false, true])(
  "local reveal retires restoration without canceling existing bottom follow=%s",
  async (bottom) => {
    const h = mount(bottom);
    await frame();
    scroll.toIndex.mockClear();
    h.reveal();
    await frame();
    expect(scroll.toIndex).toHaveBeenLastCalledWith(1, { align: "end" });
    const calls = scroll.toIndex.mock.calls.length;
    await h.measured();
    await frame();
    expect(scroll.toIndex).toHaveBeenLastCalledWith(1, { align: "end" });
    expect(scroll.toIndex.mock.calls.length).toBe(calls + (bottom ? 1 : 0));
  },
);
