// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LinkLabel } from "../../bundled/links/InlineLink";
import type { ChannelMessage, Profile } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import type { ThreadSnapshot, ThreadView } from "../relay/threads";
import { MessageLink } from "./MessageLink";

afterEach(cleanup);
// Lookups start after the commit that mounted their links.
const started = () => act(async () => {});

const alice = "b".repeat(64);
const id = (n: number) => n.toString(16).padStart(64, "a");
const href = (messageId: string, thread?: string) =>
  `buzz://message?${new URLSearchParams({ channel: "design", id: messageId, ...(thread ? { thread } : {}) })}`;
const message = (messageId: string, patch?: Partial<ChannelMessage>) =>
  ({
    id: messageId,
    channelId: "design",
    authorId: alice,
    content: "Linked body",
    createdAt: 1,
    mentions: [],
    participants: [],
    attachments: [],
    reactions: [],
    replyCount: 0,
    ...patch,
  }) satisfies ChannelMessage;
const loading: ThreadSnapshot = {
  status: "loading",
  root: undefined,
  replies: [],
  error: undefined,
  canLoadMore: true,
  limited: false,
  targetStatus: "loading",
};
const ready = (target: ChannelMessage): Partial<ThreadSnapshot> => ({
  status: "ready",
  canLoadMore: false,
  target,
  targetStatus: "ready",
});

/** Exact readers the test settles by hand; `open` counts undisposed ones. */
function fixture({
  channels = [{ id: "design", name: "design" }] as {
    id: string;
    name: string;
    channelType?: string;
  }[],
  profiles = new Map<string, Profile>([[alice, { name: "Alice" }]]),
  capacity = Number.POSITIVE_INFINITY,
} = {}) {
  const views: {
    messageId: string;
    publish(patch: Partial<ThreadSnapshot>): Promise<void>;
    disposed: boolean;
  }[] = [];
  const thread = vi.fn((_channelId: string, messageId: string): ThreadView => {
    if (views.filter((view) => !view.disposed).length >= capacity)
      throw new Error("Relay view capacity unavailable");
    let snapshot = loading;
    const listeners = new Set<() => void>();
    const entry = {
      messageId,
      disposed: false,
      async publish(patch: Partial<ThreadSnapshot>) {
        snapshot = { ...snapshot, ...patch };
        await act(async () => {
          for (const listener of listeners) listener();
        });
      },
    };
    views.push(entry);
    return {
      snapshot: () => snapshot,
      subscribe(listener) {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
      refresh: async () => {},
      loadMore: async () => {},
      retarget: async () => "selected",
      dispose: () => {
        entry.disposed = true;
      },
    };
  });
  const profileListeners = new Set<() => void>();
  const list = { status: "ready", channels };
  const ensure = vi.fn(async () => {});
  const session = {
    unread: {},
    thread,
    profiles: {
      snapshot: () => profiles,
      subscribe(listener: () => void) {
        profileListeners.add(listener);
        return () => void profileListeners.delete(listener);
      },
      ensure,
    },
    channels: { list: () => list, subscribeList: () => () => {} },
    media: () => undefined,
  } as unknown as RelaySession;
  return {
    session,
    thread,
    views,
    ensure,
    open: () => views.filter((view) => !view.disposed),
    async setProfiles(next: Map<string, Profile>) {
      profiles = next;
      await act(async () => {
        for (const listener of profileListeners) listener();
      });
    },
  };
}
const renderers = [
  {
    id: "link",
    title: "Links",
    key: "links/link",
    pluginId: "links",
    revision: "one",
    matches: () => true,
    component: ({ url }: { url: string }) => <LinkLabel href={url} />,
  },
];
const links = { snapshot: () => renderers, subscribe: () => () => {} };
const link = (
  session: RelaySession,
  url: string,
  props?: Partial<Parameters<typeof MessageLink>[0]>,
) => (
  <MessageLink
    url={url}
    directoryLabel="design"
    registry={links}
    onOpenLink={() => true}
    session={session}
    {...props}
  />
);

it("names the linked message's author and channel once its exact reader settles", async () => {
  const app = fixture();
  render(link(app.session, href(id(1))));
  await started();
  // Loading keeps the existing channel label and icon.
  const anchor = screen.getByRole("link", { name: "design" });
  expect(anchor.querySelector('[data-link-kind="message"] svg')).not.toBeNull();
  expect(app.thread).toHaveBeenCalledWith("design", id(1), { exact: true });
  await app.views[0]?.publish(ready(message(id(1))));
  expect(screen.getByRole("link", { name: "Alice in #design" })).toBe(anchor);
  expect(anchor.textContent).toBe("Alice in #design");
  expect(anchor.querySelector('[data-link-kind="message"] svg')).not.toBeNull();
  expect(anchor.getAttribute("href")).toBe(href(id(1)));
  // Display only: selection copy still reads the raw destination.
  expect(anchor.dataset.linkLabel).toBe("");
  // The lookup gives its reader back as soon as it has the author.
  expect(app.open()).toHaveLength(0);
  expect(app.ensure).toHaveBeenCalledWith([alice], "background");
});

it("names a reply's author with the thread icon and a workflow by its owner", async () => {
  const app = fixture();
  render(
    <>
      {link(app.session, href(id(1), id(9)))}
      {link(app.session, href(id(2)))}
    </>,
  );
  await started();
  await app.views[0]?.publish(ready(message(id(1), { threadRootId: id(9) })));
  await app.views[1]?.publish(
    ready(message(id(2), { authorId: "c".repeat(64), workflowOwnerId: alice })),
  );
  const reply = screen.getByRole("link", { name: "Alice in #design" });
  expect(reply.querySelector('[data-link-kind="thread"] svg')).not.toBeNull();
  expect(
    screen.getByRole("link", { name: "Workflow · owned by Alice in #design" }),
  ).toBeTruthy();
});

it("keeps the channel label while the author has no name, and names them once loaded", async () => {
  const app = fixture({
    profiles: new Map([
      [alice, { name: alice.slice(0, 10), nameIsFallback: true }],
    ]),
  });
  render(link(app.session, href(id(1))));
  await started();
  await app.views[0]?.publish(ready(message(id(1))));
  expect(screen.getByRole("link", { name: "design" }).textContent).toBe(
    "design",
  );
  await app.setProfiles(new Map([[alice, { name: "Alice" }]]));
  expect(screen.getByRole("link", { name: "Alice in #design" })).toBeTruthy();
});

it("keeps the channel label when the message is unavailable or no reader is free", async () => {
  const unavailable = fixture();
  const view = render(link(unavailable.session, href(id(1))));
  await started();
  await unavailable.views[0]?.publish({
    status: "idle",
    targetStatus: "unavailable",
    error: "Message unavailable",
  });
  expect(screen.getByRole("link", { name: "design" })).toBeTruthy();
  expect(unavailable.open()).toHaveLength(0);
  view.unmount();
  const full = fixture({ capacity: 0 });
  render(link(full.session, href(id(1))));
  await started();
  await started();
  // A failed lookup waits for a later mount instead of retrying in a loop.
  expect(full.thread).toHaveBeenCalledOnce();
  expect(screen.getByRole("link", { name: "design" })).toBeTruthy();
});

it("reads nothing for authored labels, drafts, unlisted channels, DMs or Solo chats", async () => {
  const app = fixture();
  render(
    <>
      {link(app.session, href(id(1)), { label: "See this" })}
      {link(app.session, href(id(2)), { interactive: false })}
    </>,
  );
  await started();
  expect(screen.getByRole("link", { name: "See this" })).toBeTruthy();
  expect(document.body.textContent).toContain("design");
  expect(app.thread).not.toHaveBeenCalled();
  cleanup();
  for (const channels of [
    [],
    [{ id: "design", name: "design", channelType: "dm" }],
    [{ id: "design", name: "design", channelType: "solo" }],
  ]) {
    const other = fixture({ channels });
    render(link(other.session, href(id(3))));
    await started();
    expect(screen.getByRole("link", { name: "design" })).toBeTruthy();
    expect(other.thread).not.toHaveBeenCalled();
    cleanup();
  }
});

it("runs a few lookups at once, cancels unmounted ones and remembers found authors", async () => {
  const app = fixture();
  const ids = [1, 2, 3, 4, 5, 6].map(id);
  const all = ids.map((messageId) => (
    <span key={messageId}>{link(app.session, href(messageId))}</span>
  ));
  const tree = (again: boolean) => (
    <>
      {all}
      {again && <span>{link(app.session, href(ids[1] ?? ""))}</span>}
    </>
  );
  const view = render(tree(false));
  await started();
  expect(app.open().map((entry) => entry.messageId)).toEqual(ids.slice(0, 4));
  await app.views[0]?.publish(ready(message(ids[0] ?? "")));
  expect(app.open().map((entry) => entry.messageId)).toEqual(ids.slice(1, 5));
  // Two links to one message share its lookup.
  view.rerender(tree(true));
  await started();
  expect(app.thread).toHaveBeenCalledTimes(5);
  // Links that unmount together cancel their lookups without starting others.
  view.unmount();
  await started();
  expect(app.open()).toHaveLength(0);
  expect(app.thread).toHaveBeenCalledTimes(5);
  // A remount shows a found author without reading it again.
  render(link(app.session, href(ids[0] ?? "")));
  await started();
  expect(screen.getByRole("link", { name: "Alice in #design" })).toBeTruthy();
  expect(app.thread).toHaveBeenCalledTimes(5);
});
