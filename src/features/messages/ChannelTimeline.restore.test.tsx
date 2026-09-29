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
import { readView, writeView } from "../../shared/view-state";

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
    saved: { offset: 900, bottom, anchor: { id: target.id, y: 42 } },
    unmount: result.unmount,
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
it("retains the saved anchor correction when cached rows are promoted before its frame", async () => {
  const h = mount();
  await frame();
  expect(scroll.toIndex).toHaveBeenLastCalledWith(0, {
    align: "start",
    offset: -42,
  });
  scroll.toIndex.mockClear();
  await h.measured();
  h.promote();
  await frame();
  expect(scroll.toIndex).toHaveBeenLastCalledWith(0, {
    align: "start",
    offset: -42,
  });
});
it("reader input cancels the queued correction even when cached rows are then promoted", async () => {
  const h = mount();
  await frame();
  scroll.toIndex.mockClear();
  await h.measured();
  fireEvent.wheel(
    screen.getByRole("region", { name: "Channel message history" }),
  );
  h.promote();
  await frame();
  expect(scroll.toIndex).not.toHaveBeenCalled();
});

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

it.each([false, true])(
  "a scroll before any visible virtual row mounts retains restoration unless reader input=%s",
  async (readerInput) => {
    const h = mount();
    await frame();
    const feed = screen.getByRole("region", {
      name: "Channel message history",
    });
    // The virtualizer has accepted the offset, but its mounted range is still
    // offscreen. No paragraph or row is available to replace the saved anchor.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        return new DOMRect(0, this.closest("ol") ? -200 : 0, 800, 100);
      },
    );
    feed.scrollTop = 900;
    if (readerInput) fireEvent.wheel(feed);
    fireEvent.scroll(feed);
    h.unmount();
    expect(readView("scope", "scroll:c", null)).toEqual(
      readerInput ? { offset: 900, bottom: false } : h.saved,
    );
  },
);

it("never mounts tagged coordination in a channel or reveals it through an exact target", async () => {
  const viewer = keypair(),
    relay = keypair(),
    agent = keypair();
  const owner = createRelaySession(
    scriptedTransport(viewer.pubkey, relay.pubkey).transport,
  );
  owners.push(owner);
  const hidden = {
    id: "a".repeat(64),
    channelId: "c",
    authorId: agent.pubkey,
    content: "Private coordination body",
    createdAt: 1,
    mentions: [],
    participants: [],
    attachments: [],
    reactions: [],
    replyCount: 0,
    audience: "agents" as const,
    agentEnvelope: true as const,
  };
  const visible = {
    ...hidden,
    id: "b".repeat(64),
    content: "Human-facing answer",
    audience: "everyone" as const,
  };
  const snapshot: ChannelWindow = {
    channelId: "c",
    status: "ready",
    freshness: "verified",
    hasMore: false,
    loadingOlder: false,
    error: undefined,
    rows: [hidden, visible],
  };
  const complete = vi.fn(() => true);
  const navigation = {
    signal: new AbortController().signal,
    target: { kind: "conversation", messageId: hidden.id },
    complete,
  } as unknown as import("../navigation/service").PageNavigation;
  const view = render(
    <ChannelTimeline
      queries={owner.session}
      scope="visibility"
      channelId="c"
      viewer={viewer.pubkey}
      window={snapshot}
      onOpenLink={() => false}
      navigation={navigation}
    />,
  );
  await frame();
  expect(
    view.container.querySelector(`[data-message-id="${hidden.id}"]`),
  ).toBeNull();
  expect(screen.queryByText(hidden.content)).toBeNull();
  expect(screen.getByText(visible.content)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Coordination/ })).toBeNull();
  expect(complete).toHaveBeenCalledWith({
    status: "failed",
    reason: "unavailable",
  });
});
