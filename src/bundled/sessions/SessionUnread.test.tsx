// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../../features/relay/session";
import type { RelayEvent } from "../../features/relay/events";
import type { UnreadSnapshot } from "../../features/relay/unread";
import {
  readJournal,
  type ReadJournal,
} from "../../features/relay/read-state-storage";
import {
  keypair,
  message,
  metadata,
  profile,
  roster,
} from "../../features/relay/testing";
import { SessionUnread } from "./SessionUnread";
import { SessionsDirectory } from "./SessionsDirectory";
import { PersonalSessions } from "./PersonalSessions";
import { RecentChannelThreads } from "./RecentChannelThreads";
import { createRetainedSessions } from "./retained-sessions";
import { sessionsData } from "../../../tests/fixtures/channel-sessions-data";

const dispose: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const stop of dispose.splice(0)) stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function rig() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-21T14:00:00Z"));
  const now = Date.now() / 1000;
  const viewer = keypair(),
    authority = keypair(),
    agent = keypair(),
    peer = keypair();
  let incoming = (_events: readonly RelayEvent[]) => {};
  let journal: ReadJournal | undefined;
  const query = vi.fn(async () => [] as RelayEvent[]);
  const sign = vi.fn(async () => {
    throw new Error("Test must not publish");
  });
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: authority.pubkey,
      query,
      media: () => undefined,
      readState: {
        decode: async () => [],
        sign,
        publish: vi.fn(async () => {}),
      },
      subscribe(callbacks) {
        incoming = callbacks.receive;
        callbacks.state({ status: "connected", routes: [] });
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    {
      warm: false,
      readStateStorage: {
        async update(change) {
          journal = readJournal(change(journal), viewer.pubkey);
          return journal;
        },
        close() {},
      },
      readPublisherLock: async (_signal, work) => work(),
    },
  );
  const retained = createRetainedSessions();
  dispose.push(() => {
    retained.dispose();
    owner.dispose();
  });
  const emit = (events: readonly RelayEvent[]) => incoming(events);
  emit([
    roster(authority, "room", [viewer.pubkey], now),
    metadata(authority, "room", "Room", now),
    profile(agent, { name: "Namesake", is_agent: true }, now),
    profile(peer, { name: "Namesake" }, now),
  ]);
  const root = message(agent, "room", "Same title", now, [
    ["p", viewer.pubkey],
    ["buzz-session", "1", "chip"],
  ]);
  const other = message(viewer, "room", "Same title", now - 1, [
    ["p", agent.pubkey],
  ]);
  const reply = message(peer, "room", "Other thread reply", now + 1, [
    ["e", other.id, "", "reply"],
  ]);
  emit([
    root,
    other,
    reply,
    message(viewer, "room", "Own reply", now + 2, [
      ["e", root.id, "", "reply"],
    ]),
  ]);
  return {
    ...owner,
    retained,
    root,
    other,
    reply,
    emit,
    viewer,
    authority,
    agent,
    now,
    query,
    sign,
    journal: () => journal,
  };
}

it("combines exact root and reply evidence in both callers without reading, reordering or querying", async () => {
  const h = rig();
  const unread = h.session.unread;
  const rows = [h.root, h.other].map((row) => ({
    rootId: row.id,
    title: row.content,
    replyCount: 1,
    lastMessageAt: row.created_at,
  }));
  const open = vi.fn(() => true);
  render(
    <>
      <SessionsDirectory
        rows={rows}
        now={h.now}
        openThread={open}
        renderStatus={(rootId) => (
          <SessionUnread unread={unread} channelId="room" rootId={rootId} />
        )}
      />
      <PersonalSessions
        session={h.session}
        owner={h.retained}
        channelId="room"
        channelName="Room"
        scope="test"
        directorySelected={true}
        openThread={open}
        openDirectory={vi.fn()}
      />
    </>,
    { reactStrictMode: true },
  );
  const directory = screen.getByRole("region", {
    name: "Sessions",
  });
  const personal = screen.getByRole("region", {
    name: "Your sessions in Room",
  });
  const element = (id: string) => {
    const found = document.getElementById(id);
    if (!found) throw new Error(`Missing row ${id}`);
    return found;
  };
  const row = (rootId: string) => element(`session-row-${rootId}`);
  const child = (rootId: string) => element(`personal-session-room-${rootId}`);
  expect(within(directory).getAllByRole("img")).toHaveLength(2);
  expect(within(personal).getAllByRole("img")).toHaveLength(2);
  expect(
    unread.snapshot({ kind: "thread", channelId: "room", rootId: h.root.id })
      .observedCount,
  ).toBe(0);
  expect(
    unread.snapshot({
      kind: "message",
      channelId: "room",
      messageId: h.root.id,
    }).observedCount,
  ).toBe(1);
  const order = within(directory).getAllByRole("button");
  fireEvent.click(row(h.root.id));
  expect(open).toHaveBeenCalledWith(h.root.id);
  expect(within(row(h.root.id)).getAllByRole("img")).toHaveLength(1);
  expect(h.query).not.toHaveBeenCalled();
  expect(h.sign).not.toHaveBeenCalled();
  expect(h.journal()).toBeUndefined();
  const reading = unread.reading("room");
  await act(async () => {
    await reading.observe([h.reply.id]);
  });
  reading.dispose();
  expect(within(row(h.other.id)).queryByRole("img")).toBeNull();
  expect(within(child(h.other.id)).queryByRole("img")).toBeNull();
  expect(within(row(h.root.id)).getByRole("img")).toBeVisible();
  expect(within(child(h.root.id)).getByRole("img")).toBeVisible();
  expect(within(directory).getAllByRole("button")).toEqual(order);
  expect(h.journal()?.state.frontiers[`msg:${h.root.id}`]).toBeUndefined();
  expect(h.journal()?.state.frontiers.room).toBeUndefined();
  // A peer reply alongside the already-unread quiet root still produces one dot.
  const sameThread = message(h.agent, "room", "Agent reply", h.now + 3, [
    ["e", h.root.id, "", "reply"],
  ]);
  act(() => h.emit([sameThread]));
  expect(within(row(h.root.id)).getAllByRole("img")).toHaveLength(1);
  expect(within(child(h.root.id)).getAllByRole("img")).toHaveLength(1);
  expect(within(directory).getAllByRole("button")).toEqual(order);

  await act(async () => {
    await unread.markUnreadLocal({
      kind: "thread",
      channelId: "room",
      rootId: h.other.id,
    });
  });
  expect(within(row(h.other.id)).getByRole("img")).toHaveAccessibleName(
    "Marked unread on this device only",
  );
  await act(async () => {
    await unread.markThrough(
      { kind: "thread", channelId: "room", rootId: h.other.id },
      h.reply.id,
    );
  });
  expect(within(row(h.other.id)).queryByRole("img")).toBeNull();
  expect(within(directory).getAllByRole("button")).toEqual(order);
  expect(h.query).not.toHaveBeenCalled();
});

it("unknown roots, own messages and another channel cannot borrow a positive signal", () => {
  const h = rig();
  const ownOnly = message(h.viewer, "room", "Only mine", h.now + 3);
  act(() => h.emit([ownOnly]));
  render(
    <>
      <div data-testid="own-only">
        <SessionUnread
          unread={h.session.unread}
          channelId="room"
          rootId={ownOnly.id}
        />
      </div>
      <div data-testid="own">
        <SessionUnread
          unread={h.session.unread}
          channelId="room"
          rootId={h.other.id}
        />
      </div>
      <div data-testid="pending">
        <SessionUnread
          unread={h.session.unread}
          channelId="room"
          rootId={"f".repeat(64)}
        />
      </div>
      <div data-testid="channel">
        <SessionUnread
          unread={h.session.unread}
          channelId="other"
          rootId={h.root.id}
        />
      </div>
    </>,
  );
  // The own root itself is read; only its peer reply supplies the positive.
  expect(
    h.session.unread.snapshot({
      kind: "message",
      channelId: "room",
      messageId: h.other.id,
    }).observedCount,
  ).toBe(0);
  expect(within(screen.getByTestId("own")).getByRole("img")).toBeVisible();
  expect(screen.getByTestId("own-only")).toBeEmptyDOMElement();
  expect(screen.getByTestId("pending")).toBeEmptyDOMElement();
  expect(screen.getByTestId("channel")).toBeEmptyDOMElement();
});

it("StrictMode unsubscribes once per lease on retarget/disable; access and cache clear remove evidence", async () => {
  const a = rig(),
    b = rig();
  const stops: ReturnType<typeof vi.fn>[] = [];
  const track = (unread: typeof a.session.unread) => ({
    ...unread,
    subscribe: vi.fn(
      (
        target: Parameters<typeof unread.subscribe>[0],
        listener: () => void,
      ) => {
        const stop = vi.fn(unread.subscribe(target, listener));
        stops.push(stop);
        return stop;
      },
    ),
  });
  const aUnread = track(a.session.unread),
    bUnread = track(b.session.unread);
  const aSubscribe = aUnread.subscribe,
    bSubscribe = bUnread.subscribe;
  const show = (h: typeof a) => (
    <SessionUnread
      unread={h === a ? aUnread : bUnread}
      channelId="room"
      rootId={h.root.id}
    />
  );
  const view = render(show(a), { reactStrictMode: true });
  expect(aSubscribe).toHaveBeenCalledTimes(4);
  view.rerender(show(a));
  expect(aSubscribe).toHaveBeenCalledTimes(4);
  view.rerender(show(b));
  expect(stops.slice(0, 4).every((stop) => stop.mock.calls.length === 1)).toBe(
    true,
  );
  act(() => a.emit([roster(a.authority, "room", [], a.now + 1)]));
  expect(screen.getByRole("img")).toBeVisible();
  act(() => b.emit([roster(b.authority, "room", [], b.now + 1)]));
  expect(screen.queryByRole("img")).toBeNull();
  act(() =>
    b.emit([roster(b.authority, "room", [b.viewer.pubkey], b.now + 2), b.root]),
  );
  expect(screen.getByRole("img")).toBeVisible();
  await act(async () => {
    await b.clearCache();
  });
  expect(screen.queryByRole("img")).toBeNull();
  view.rerender(<div />);
  expect(stops.every((stop) => stop.mock.calls.length === 1)).toBe(true);
  act(() => b.emit([b.root]));
  expect(screen.queryByRole("img")).toBeNull();
  expect(bSubscribe).toHaveBeenCalledTimes(2);
});

it.each([
  [null, "unknown", "none", null],
  [0, "observed", "none", null],
  [
    1,
    "stale",
    "none",
    "Observed unread messages; may be out of date. Not an exact total.",
  ],
  [null, "unknown", "local-only", "Marked unread on this device only"],
  [null, "unknown", "remote", "Marked unread"],
] as const)(
  "keeps count %s / freshness %s / intent %s honest",
  (count, freshness, manual, label) => {
    const target = {
      kind: "thread" as const,
      channelId: "room",
      rootId: "a".repeat(64),
    };
    const snapshot: UnreadSnapshot = {
      target,
      observedCount: count,
      attentionCount: null,
      coverage: count === null ? "unknown" : "observed",
      freshness,
      manual,
    };
    const unread = { snapshot: () => snapshot, subscribe: () => () => {} };
    render(
      <SessionUnread unread={unread} channelId="room" rootId={target.rootId} />,
      { reactStrictMode: true },
    );
    if (label) {
      expect(screen.getAllByRole("img")).toHaveLength(1);
      expect(screen.getByRole("img")).toHaveAccessibleName(label);
      expect(screen.getByRole("img")).toHaveAttribute("title", label);
    } else expect(screen.queryByRole("img")).toBeNull();
  },
);

it.each([
  ["observed", 0, "stale", "Observed unread messages. Not an exact total."],
  ["observed", null, "stale", "Observed unread messages. Not an exact total."],
  [
    "stale",
    0,
    "observed",
    "Observed unread messages; may be out of date. Not an exact total.",
  ],
] as const)(
  "qualifies positive root freshness %s independently of thread count %s / freshness %s",
  (rootFreshness, threadCount, threadFreshness, label) => {
    const rootId = "a".repeat(64);
    const root: UnreadSnapshot = {
      target: { kind: "message", channelId: "room", messageId: rootId },
      observedCount: 1,
      attentionCount: null,
      coverage: "observed",
      freshness: rootFreshness,
      manual: "none",
    };
    const thread: UnreadSnapshot = {
      target: { kind: "thread", channelId: "room", rootId },
      observedCount: threadCount,
      attentionCount: null,
      coverage: threadCount === null ? "unknown" : "observed",
      freshness: threadFreshness,
      manual: "none",
    };
    const unread = {
      snapshot: (target: UnreadSnapshot["target"]) =>
        target.kind === "message" ? root : thread,
      subscribe: () => () => {},
    };
    render(<SessionUnread unread={unread} channelId="room" rootId={rootId} />, {
      reactStrictMode: true,
    });
    expect(screen.getAllByRole("img")).toHaveLength(1);
    expect(screen.getByRole("img")).toHaveAccessibleName(label);
    expect(screen.getByRole("img")).toHaveAttribute("title", label);
  },
);

it("the actual directory caller binds the same root/channel to passive unread status", async () => {
  const data = sessionsData({ rowCount: 2 });
  dispose.push(data.dispose);
  data.session.channels.ensureList();
  await waitFor(() =>
    expect(data.session.channels.list().status).toBe("ready"),
  );
  data.session.channels.ensure("general");
  await waitFor(() =>
    expect(data.session.channels.window("general").status).toBe("ready"),
  );
  render(
    <RecentChannelThreads
      session={data.session}
      channelId="general"
      channelName="General"
      scope="test"
      openThread={() => true}
    />,
    { reactStrictMode: true },
  );
  const row = await screen.findByRole("button", {
    name: /Review the release checklist/,
  });
  expect(
    await within(row).findByRole("img", { name: /Observed unread messages/ }),
  ).toBeVisible();
  expect(data.report.readingLeases).toBe(0);
  expect(data.report.published).toEqual([]);
});
