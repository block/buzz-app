// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import type { ChannelMessage, Profile } from "../relay/contracts";
import type { ProfileQueries } from "../relay/profile-directory";
import { createRelaySession } from "../relay/session";
import type { ThreadSnapshot, ThreadView } from "../relay/threads";
import { ThreadPanel } from "./ThreadPanel";

const bodyRender = vi.fn();
vi.mock("./MessageMarkdown", () => ({
  MessageMarkdown: ({ row }: { row: ChannelMessage }) => {
    bodyRender(row.content);
    return <span>{row.content}</span>;
  },
}));
vi.mock("./MessageComposer", () => ({ MessageComposer: () => null }));

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", TestResizeObserver);

afterAll(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const row = (id: string, authorId: string, content: string): ChannelMessage =>
  Object.freeze({
    id,
    channelId: "a",
    authorId,
    createdAt: id === "root" ? 1 : 2,
    content,
    mentions: Object.freeze([]),
    attachments: Object.freeze([]),
    reactions: Object.freeze([]),
    replyCount: 0,
    participants: Object.freeze([]),
  });

function mutableThread(initial: ThreadSnapshot) {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  const view: ThreadView = {
    snapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async refresh() {},
    async loadMore() {},
    dispose() {},
  };
  return {
    view,
    publish(next: ThreadSnapshot) {
      snapshot = next;
      for (const listener of listeners) listener();
    },
  };
}

function mutableProfiles(initial: ReadonlyMap<string, Profile>) {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  const queries: ProfileQueries = {
    snapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async ensure() {},
  };
  return {
    queries,
    publish(next: ReadonlyMap<string, Profile>) {
      snapshot = next;
      for (const listener of listeners) listener();
    },
  };
}

it("does not rerender retained message bodies for status or equivalent profile updates", async () => {
  const root = row("root", "alice", "Root body");
  const reply = row("reply", "bob", "Reply body");
  const replies = Object.freeze([reply]);
  const thread = mutableThread(
    Object.freeze({
      status: "ready",
      root,
      replies,
      error: undefined,
      canLoadMore: false,
      limited: false,
    }),
  );
  const alice: Profile = Object.freeze({ name: "Alice" });
  const bob: Profile = Object.freeze({ name: "Bob" });
  const profiles = mutableProfiles(
    new Map([
      ["alice", alice],
      ["bob", bob],
    ]),
  );
  const owner = createRelaySession(null);
  const session = {
    ...owner.session,
    profiles: profiles.queries,
    thread: () => thread.view,
  };

  render(
    <StrictMode>
      <ThreadPanel
        session={session}
        scope="identity-test"
        channelName="A"
        channelId="a"
        messageId="root"
        close={() => {}}
        onOpenLink={() => false}
      />
    </StrictMode>,
  );
  expect(await screen.findByText("Alice")).toBeInTheDocument();
  expect(screen.getByText("Bob")).toBeInTheDocument();
  bodyRender.mockClear();

  thread.publish(
    Object.freeze({
      ...thread.view.snapshot(),
      status: "loading",
    }),
  );
  expect(await screen.findByText("Loading thread…")).toBeInTheDocument();
  expect(bodyRender).not.toHaveBeenCalled();

  profiles.publish(
    new Map([
      ["alice", alice],
      ["bob", bob],
      ["other", { name: "Other" }],
    ]),
  );
  expect(bodyRender).not.toHaveBeenCalled();

  const edited = row("reply", "bob", "Edited reply body");
  thread.publish(
    Object.freeze({
      ...thread.view.snapshot(),
      status: "ready",
      replies: Object.freeze([edited]),
    }),
  );
  expect(await screen.findByText("Edited reply body")).toBeInTheDocument();
  expect(bodyRender).toHaveBeenCalledWith("Edited reply body");
  bodyRender.mockClear();

  profiles.publish(
    new Map([
      ["alice", alice],
      ["bob", { name: "Robert" }],
    ]),
  );
  expect(await screen.findByText("Robert")).toBeInTheDocument();
  expect(bodyRender).toHaveBeenCalled();
  owner.dispose();
});
