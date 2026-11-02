// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { BuzzLinkPreview } from "./BuzzLinkPreview";
import type { RelaySession } from "../relay/session";
import type { ThreadSnapshot, ThreadView } from "../relay/threads";
import type { ChannelMessage, ChannelReference } from "../relay/contracts";
import { mediaUrl } from "../relay/transport";

afterEach(cleanup);
const text = (tree: HTMLElement) =>
  tree.querySelector('[role="status"]')?.textContent;
const root: ChannelMessage = {
  id: "a".repeat(64),
  channelId: "channel",
  authorId: "b".repeat(64),
  content: "reconciled body",
  createdAt: 1,
  mentions: [],
  participants: [],
  attachments: [],
  reactions: [],
  replyCount: 0,
};
function setup(
  snapshot: ThreadSnapshot,
  messageId = root.id,
  profiles = new Map<string, { name?: string; picture?: string }>(),
  reference?: ChannelReference,
  resolve?: (ids: readonly string[]) => Promise<void>,
) {
  const view = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    refresh: vi.fn(async () => {}),
    loadMore: vi.fn(async () => {}),
    retarget: vi.fn<ThreadView["retarget"]>(async () => "selected"),
    dispose: vi.fn(),
  } satisfies ThreadView;
  const thread = vi.fn(() => view);
  // With a reference, the reader hasn't joined: the channel is unlisted.
  const list = {
    status: "ready",
    channels: reference ? [] : [{ id: "channel", name: "General" }],
  };
  const refer = vi.fn(() => () => {});
  const session = {
    thread,
    profiles: {
      subscribe: () => () => {},
      snapshot: () => profiles,
      ensure: vi.fn(async () => {}),
    },
    channels: {
      subscribeList: () => () => {},
      list: () => list,
      describe: () => reference ?? { state: "unknown" },
      refer,
      resolve,
    },
    // The real sizing rewrite behind a pass-through proxy, as the session applies it.
    media: (url: string, size?: "small") =>
      mediaUrl(url, (proxied) => proxied, "https://relay.test", size),
  } as unknown as RelaySession;
  const mounted = render(
    <BuzzLinkPreview
      session={session}
      channelId="channel"
      messageId={messageId}
    />,
  );
  return { tree: mounted.container, thread, refer, unmount: mounted.unmount };
}
const base: ThreadSnapshot = {
  status: "idle",
  root: undefined,
  replies: [],
  error: undefined,
  canLoadMore: false,
  limited: false,
};
it("does not paint the seed root until the snapshot reconciles edits and deletions", () => {
  // A seeded but still-loading view exposes the raw root; a cached deletion or
  // edit is a different event that only folds in once the read reaches "ready".
  const seeded = setup({
    ...base,
    status: "loading",
    root,
    canLoadMore: true,
  }).tree;
  expect(text(seeded)).toBe("Loading message…");
  expect(seeded.querySelector("strong")).toBeNull();
  const idleSeed = setup({ ...base, status: "idle", root }).tree;
  expect(text(idleSeed)).toBe("Loading message…");
  const ready = setup({ ...base, status: "ready", root }).tree;
  expect(ready.querySelector("strong")).not.toBeNull();
});
it("reports terminal unavailability instead of loading forever", () => {
  // purge() on a denied or revoked channel publishes idle + an error string,
  // never status "error"; the card must still stop.
  const denied = setup({
    ...base,
    status: "idle",
    error: "This channel is no longer available.",
  }).tree;
  expect(text(denied)).toBe("Message preview unavailable.");
  const failed = setup({
    ...base,
    status: "error",
    error: "read failed",
  }).tree;
  expect(text(failed)).toBe("Message preview unavailable.");
  const exhausted = setup({
    ...base,
    status: "ready",
    root: undefined,
  }).tree;
  expect(text(exhausted)).toBe("Message preview unavailable.");
});
it("keeps loading while a read is genuinely in flight", () => {
  const loading = setup({
    ...base,
    status: "loading",
    canLoadMore: true,
  }).tree;
  expect(text(loading)).toBe("Loading message…");
});
it("renders the exact target independently of bounded thread replies", () => {
  const target = {
    ...root,
    id: "c".repeat(64),
    content: "reply beyond bounded traversal",
    threadRootId: root.id,
  };
  const result = setup(
    {
      ...base,
      status: "ready",
      root,
      target,
      targetStatus: "ready",
    },
    target.id,
  );
  expect(result.thread).toHaveBeenCalledWith("channel", target.id, {
    exact: true,
  });
  expect(result.tree.textContent).toContain("reply beyond bounded traversal");
});
it("renders a reconciled exact target when its thread root is unavailable", () => {
  const target = {
    ...root,
    id: "c".repeat(64),
    content: "reply with unavailable root",
    threadRootId: root.id,
  };
  const result = setup(
    {
      ...base,
      status: "error",
      error: "Thread root is unavailable.",
      target,
      targetStatus: "ready",
    },
    target.id,
  );
  expect(result.tree.textContent).toContain("reply with unavailable root");
});
it("fails safely when an exact target timestamp is outside Date range", () => {
  const target = { ...root, createdAt: 8_640_000_000_001 };
  const result = setup({
    ...base,
    status: "ready",
    root,
    target,
    targetStatus: "ready",
  });
  expect(text(result.tree)).toBe("Message preview unavailable.");
});

it("labels a workflow preview as automation, with an owner fallback instead of a signer avatar", () => {
  const workflow = { ...root, workflowOwnerId: "c".repeat(64) };
  const { tree } = setup({ ...base, status: "ready", root: workflow });
  expect(tree.querySelector("strong")?.textContent).toBe(
    "Workflow · owned by cccccccccc",
  );
  expect(tree.querySelector("img")).toBeNull();
});

it("asks for the relay thumbnail of the author's picture, as message rows do", () => {
  const sha = "d".repeat(64);
  const { tree } = setup(
    { ...base, status: "ready", root },
    root.id,
    new Map([
      [
        root.authorId,
        { name: "Bea", picture: `https://relay.test/media/${sha}.png` },
      ],
    ]),
  );
  expect(tree.querySelector("img")?.getAttribute("src")).toBe(
    `https://relay.test/media/${sha}.thumb.jpg`,
  );
});

it("names an open channel the reader hasn't joined from its public reference", () => {
  const ready = { ...base, status: "ready" as const, root };
  const channel = (reference?: ChannelReference) =>
    setup(ready, root.id, new Map(), reference);
  const found = channel({
    state: "found",
    name: "buzz-feedback",
    private: false,
    hidden: false,
    archived: false,
    joined: false,
  });
  expect(found.tree.textContent).toContain("buzz-feedback");
  expect(found.tree.textContent).not.toContain("Channel unavailable");
  // A hidden channel keeps its name to itself, as channel-only links do.
  const hidden = channel({
    state: "found",
    name: "secret-hideout",
    private: false,
    hidden: true,
    archived: false,
    joined: false,
  });
  expect(hidden.tree.textContent).not.toContain("secret-hideout");
  expect(hidden.tree.textContent).toContain("Channel unavailable");
  const withheld = channel({ state: "withheld" });
  expect(withheld.tree.textContent).toContain("Private channel");
  const unknown = channel({ state: "unknown" });
  expect(unknown.tree.textContent).toContain("Channel unavailable");
  expect(unknown.refer).toHaveBeenCalledWith("channel");
  // A listed channel needs no lookup.
  const joined = channel();
  expect(joined.tree.textContent).toContain("General");
  expect(joined.refer).not.toHaveBeenCalled();
});

it("admits an unjoined open channel before reading its message", async () => {
  const ready = { ...base, status: "ready" as const, root };
  const reference: ChannelReference = { state: "unknown" };
  let admit = () => {};
  const resolve = vi.fn(
    () =>
      new Promise<void>((done) => {
        admit = done;
      }),
  );
  const pending = setup(ready, root.id, new Map(), reference, resolve);
  expect(resolve).toHaveBeenCalledWith(["channel"], expect.anything());
  expect(pending.thread).not.toHaveBeenCalled();
  expect(text(pending.tree)).toBe("Loading message…");
  admit();
  await vi.waitFor(() =>
    expect(pending.thread).toHaveBeenCalledWith("channel", root.id, {
      exact: true,
    }),
  );
  // A preview closed during the lookup never opens a read.
  const closed = setup(ready, root.id, new Map(), reference, resolve);
  closed.unmount();
  admit();
  await Promise.resolve();
  await Promise.resolve();
  expect(closed.thread).not.toHaveBeenCalled();
});
