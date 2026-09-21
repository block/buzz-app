// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ChannelMessage, Profile } from "../../features/relay/contracts";
import type { VisibleEvent } from "../../features/relay/projection";
import type {
  EventViewSnapshot,
  RelaySession,
} from "../../features/relay/session";
import { keypair, message, signed } from "../../features/relay/testing";
import { foldMessages } from "../../features/relay/fold";
import { sessionsData } from "../../../tests/fixtures/channel-sessions-data";
import { RecentChannelThreads } from "./RecentChannelThreads";
import {
  PROFILE_LIMIT,
  REPLY_LIMIT,
  rootIdentities,
  sessionReplies,
} from "./session-evidence";

afterEach(cleanup);
const human = "a".repeat(64),
  agent = "b".repeat(64),
  other = "c".repeat(64);
const id = (n: number) => n.toString(16).padStart(64, "0");
const root = (
  n: number,
  patch: Partial<ChannelMessage> = {},
): ChannelMessage => ({
  id: id(n),
  channelId: "channel",
  authorId: human,
  createdAt: n,
  content: `Thread ${n}`,
  mentions: [],
  participants: [],
  attachments: [],
  reactions: [],
  replyCount: 0,
  ...patch,
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}
function harness(
  rows: ChannelMessage[],
  initial: [string, Profile][] = [
    [human, { name: "Alex" }],
    [agent, { name: "Alex", isAgent: true }],
  ],
) {
  let window = {
    channelId: "channel",
    rows,
    status: "ready" as const,
    hasMore: false,
    loadingOlder: false,
    error: undefined,
  };
  let profiles: ReadonlyMap<string, Profile> = new Map(initial);
  let library = {
    status: "ready" as const,
    definitions: [],
    identities: [] as { pubkey: string; name: string }[],
  };
  const wl = new Set<() => void>(),
    pl = new Set<() => void>(),
    ll = new Set<() => void>();
  const subscribe = (listeners: Set<() => void>) => (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const ensure = vi.fn(
    async (_keys: readonly string[], _priority?: string) => {},
  );
  const views: {
    snapshot: () => EventViewSnapshot;
    subscribe: (listener: () => void) => () => void;
    refresh: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    emit: (value: Partial<EventViewSnapshot>) => void;
    listeners: Set<() => void>;
  }[] = [];
  const observe = vi.fn((_filters: Parameters<RelaySession["observe"]>[0]) => {
    let snapshot: EventViewSnapshot = { status: "idle", events: [] };
    const listeners = new Set<() => void>();
    const emit = (value: Partial<EventViewSnapshot>) => {
      snapshot = { ...snapshot, ...value };
      for (const listener of listeners) listener();
    };
    const view = {
      snapshot: () => snapshot,
      subscribe: subscribe(listeners),
      emit,
      listeners,
      refresh: vi.fn(async () => {
        emit({ status: "ready" });
      }),
      dispose: vi.fn(() => listeners.clear()),
    };
    views.push(view);
    return view;
  });
  const libraryRefresh = vi.fn();
  const session = {
    channels: {
      window: () => window,
      ensure: vi.fn(),
      subscribeWindow: (_id: string, listener: () => void) =>
        subscribe(wl)(listener),
      refresh: vi.fn(),
    },
    profiles: { snapshot: () => profiles, subscribe: subscribe(pl), ensure },
    agentLibrary: {
      snapshot: () => library,
      subscribe: subscribe(ll),
      refresh: libraryRefresh,
    },
    observe,
    thread: vi.fn(),
  } as unknown as RelaySession;
  const props = {
    session,
    scope: "test",
    channelId: "channel",
    channelName: "Channel",
    openThread: () => true,
  };
  const mount = (strict = false) =>
    render(<RecentChannelThreads {...props} />, { reactStrictMode: strict });
  return {
    session,
    props,
    mount,
    observe,
    views,
    ensure,
    wl,
    pl,
    ll,
    libraryRefresh,
    rows(next: ChannelMessage[]) {
      act(() => {
        window = { ...window, rows: next };
        for (const listener of wl) listener();
      });
    },
    profiles(next: [string, Profile][]) {
      act(() => {
        profiles = new Map(next);
        for (const listener of pl) listener();
      });
    },
    library(keys: string[]) {
      act(() => {
        library = {
          ...library,
          identities: keys.map((pubkey) => ({ pubkey, name: "Alex" })),
        };
        for (const listener of ll) listener();
      });
    },
    emit(value: Partial<EventViewSnapshot>) {
      act(() => views.at(-1)?.emit(value));
    },
  };
}
const row = (n: number) =>
  screen.queryByRole("button", {
    name: new RegExp(`^Thread ${n}(?:0|1|9) repl`),
  });
async function settled() {
  await waitFor(() =>
    expect(
      screen.queryByText("Checking threads for agents…"),
    ).not.toBeInTheDocument(),
  );
}

it("uses exact root author/recipient/participant evidence, including no replies, never prose, namesakes or envelope", async () => {
  const h = harness([
    root(1, { authorId: agent }),
    root(2, { mentions: [agent] }),
    root(3, { participants: [agent] }),
    root(4, { content: "Thread 4 @Alex", mentions: [human], replyCount: 1 }),
    root(5, { agentEnvelope: true }),
    root(6, { mentions: [agent], edited: true }),
    root(7, { mentions: [agent], delivery: "unknown" }),
  ]);
  h.mount();
  await settled();
  expect(row(1)).toBeVisible();
  expect(row(2)).toBeVisible();
  expect(row(3)).toBeVisible();
  expect(screen.queryByText("Thread 4 @Alex")).not.toBeInTheDocument();
  for (const n of [5, 6, 7]) expect(row(n)).toBeNull();
  expect(h.observe).toHaveBeenCalledTimes(1);
  expect(h.observe.mock.calls[0]?.[0]).toEqual([
    {
      kinds: [9, 40002],
      "#h": ["channel"],
      "#e": [1, 2, 3, 4, 5, 6].map(id),
      limit: 200,
    },
  ]);
  expect(h.session.thread).not.toHaveBeenCalled();
  expect(h.libraryRefresh).not.toHaveBeenCalled();
  h.rows([root(2, { content: "Thread 2", mentions: [], edited: true })]);
  await settled();
  expect(row(2)).toBeNull();
  expect(rootIdentities(root(2, { mentions: [agent], edited: true }))).toEqual([
    human,
  ]);
});

it("matches only supported shared canonical same-channel replies, including a human's later exact mention before agent response", () => {
  const key = keypair();
  const reply = (
    tags: string[][] = [["e", id(1), "", "reply"]],
    channel = "channel",
  ) => message(key, channel, "@Alex", 100, [["p", agent], ...tags]);
  const direct = reply();
  const events: VisibleEvent[] = [
    direct,
    { ...reply(), kind: 40002 },
    reply([["e", id(1)]]),
    reply([["e", id(1), "", "mention"]]),
    reply([["e", id(1), "", "root"]]),
    reply(undefined, "wrong"),
    { ...reply(), delivery: "unknown" },
    { ...reply(), delivery: "sending" },
    { ...reply(), delivery: "failed" },
    { ...reply(), kind: 7 },
    reply([["e", id(2), "", "reply"]]),
    reply([
      ["e", id(1), "", "root"],
      ["e", id(2), "", "reply"],
    ]),
  ];
  expect(sessionReplies(events, "channel", new Set([id(1)]))).toEqual(
    [0, 1, 11].map(() => ({ rootId: id(1), identities: [key.pubkey, agent] })),
  );
  expect(
    sessionReplies(
      Array.from({ length: 201 }, () => direct),
      "channel",
      new Set([id(1)]),
    ),
  ).toHaveLength(REPLY_LIMIT);
});

it("derives live eligibility without sticky evidence or read churn on profiles, counts, edits and library changes", async () => {
  const h = harness([root(1), root(2)]);
  h.mount();
  await settled();
  const key = keypair();
  const event = message(key, "channel", "Later mention", 100, [
    ["e", id(1), "", "reply"],
    ["p", agent],
  ]);
  h.emit({ events: [event] });
  await settled();
  expect(row(1)).toBeVisible();
  expect(row(2)).toBeNull();
  h.rows([root(2), root(1, { replyCount: 9 })]);
  h.profiles([
    [human, { name: "Human" }],
    [agent, { name: "Renamed", isAgent: true }],
  ]);
  expect(h.observe).toHaveBeenCalledTimes(1);
  expect(row(1)).toBeVisible();
  h.profiles([
    [human, { name: "Human" }],
    [agent, { name: "Renamed" }],
  ]);
  expect(row(1)).toBeNull();
  h.library([agent]);
  expect(row(1)).toBeVisible();
  h.library([]);
  expect(row(1)).toBeNull();
  h.emit({ events: [{ ...event, delivery: "unknown" }] });
  h.library([agent]);
  expect(row(1)).toBeNull();
  h.emit({ events: [{ ...event, delivery: "accepted" }] });
  expect(row(1)).toBeVisible();
  h.emit({
    events: [
      {
        ...event,
        pubkey: agent,
        tags: [
          ["h", "channel"],
          ["e", id(1), "", "reply"],
        ],
      },
    ],
  });
  expect(row(1)).toBeVisible();
  h.emit({ events: [] });
  expect(row(1)).toBeNull();
  expect(h.observe).toHaveBeenCalledTimes(1);
  expect(h.libraryRefresh).not.toHaveBeenCalled();
});

it("omits unresolved profiles, holds loading, exposes failure retry once, and doesn't retry on publications", async () => {
  const h = harness([root(1, { mentions: [other] })]);
  const gate = deferred();
  h.ensure.mockImplementationOnce(() =>
    gate.promise.then(() => {
      throw new Error("offline");
    }),
  );
  h.mount();
  expect(
    await screen.findByText("Checking threads for agents…"),
  ).toBeInTheDocument();
  expect(row(1)).toBeNull();
  await act(async () => gate.resolve());
  await settled();
  expect(
    screen.getByText("Some threads could not be checked."),
  ).toBeInTheDocument();
  expect(screen.queryByText(/No agent sessions/)).toBeNull();
  const calls = h.ensure.mock.calls.length;
  h.rows([root(1, { mentions: [other], replyCount: 9 })]);
  h.emit({ events: [] });
  h.profiles([[human, { name: "Changed" }]]);
  expect(h.ensure).toHaveBeenCalledTimes(calls);
  const retryGate = deferred();
  h.ensure.mockImplementationOnce(() => retryGate.promise);
  fireEvent.click(screen.getByRole("button", { name: "Retry session check" }));
  expect(h.ensure).toHaveBeenCalledTimes(calls + 1);
  h.profiles([
    [human, { name: "Human" }],
    [other, { name: "Agent", isAgent: true }],
  ]);
  await act(async () => retryGate.resolve());
  await settled();
  expect(row(1)).toBeVisible();
  expect(h.observe).toHaveBeenCalledTimes(1);
  expect(h.views[0]?.refresh).toHaveBeenCalledTimes(2);
});

it("bounds root filters and profile requests across one opening and retry, with visible partial coverage", async () => {
  const identities = Array.from({ length: 1100 }, (_, i) => id(i + 1000));
  const rows = Array.from({ length: 201 }, (_, i) =>
    root(i + 1, { mentions: identities.slice(i * 6, i * 6 + 6) }),
  );
  const h = harness(rows);
  h.mount();
  await settled();
  expect(h.observe.mock.calls[0]?.[0][0]?.["#e"]).toHaveLength(200);
  expect(h.observe.mock.calls[0]?.[0][0]?.["#e"]).not.toContain(id(1));
  expect(
    screen.getByText("Checking the newest 200 loaded roots only."),
  ).toBeVisible();
  expect(new Set(h.ensure.mock.calls.flatMap(([keys]) => keys)).size).toBe(
    PROFILE_LIMIT,
  );
  h.rows([root(9999, { mentions: ["d".repeat(64)] }), ...rows]);
  await settled();
  fireEvent.click(screen.getByRole("button", { name: "Retry session check" }));
  await settled();
  expect(new Set(h.ensure.mock.calls.flatMap(([keys]) => keys)).size).toBe(
    PROFILE_LIMIT,
  );
  expect(h.views[0]?.dispose).toHaveBeenCalledOnce();
});

it("does no empty batch; owns one live subscription in StrictMode and fences late work at reset and unmount", async () => {
  const h = harness([]);
  const view = h.mount(true);
  await settled();
  expect(h.observe).not.toHaveBeenCalled();
  const gate = deferred();
  h.ensure.mockImplementationOnce(() => gate.promise);
  h.rows([root(1, { mentions: [other] })]);
  expect(await screen.findByText("Checking threads for agents…")).toBeVisible();
  h.emit({ status: "idle", events: [] });
  h.profiles([]);
  h.rows([]);
  await act(async () => gate.resolve());
  await settled();
  expect(row(1)).toBeNull();
  expect(
    h.views.every((reader) => reader.dispose.mock.calls.length === 1),
  ).toBe(true);
  const next = deferred();
  h.ensure.mockImplementationOnce(() => next.promise);
  h.rows([root(2, { mentions: [other] })]);
  view.unmount();
  await act(async () => next.resolve());
  expect(h.wl.size).toBe(0);
  expect(h.pl.size).toBe(0);
  expect(h.ll.size).toBe(0);
  expect(
    h.views.every(
      (reader) =>
        reader.listeners.size === 0 && reader.dispose.mock.calls.length === 1,
    ),
  ).toBe(true);
});

it("retries a failed batch or failed observer allocation without a per-root reader", async () => {
  const h = harness([root(1)]);
  h.observe.mockImplementationOnce(() => {
    throw new Error("capacity");
  });
  h.mount();
  await settled();
  expect(screen.getByText("Some threads could not be checked.")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Retry session check" }));
  await settled();
  expect(h.observe).toHaveBeenCalledTimes(2);
  h.emit({ status: "error", error: "offline" });
  fireEvent.click(screen.getByRole("button", { name: "Retry session check" }));
  await settled();
  expect(h.observe).toHaveBeenCalledTimes(2);
  expect(h.views[0]?.refresh).toHaveBeenCalledTimes(2);
  expect(screen.queryByText("Some threads could not be checked.")).toBeNull();
});

it("actual profile owner leaves absent agent evidence unknown until one explicit retry", async () => {
  const data = sessionsData();
  data.missingAgentProfile(true);
  const view = render(
    <RecentChannelThreads
      session={data.session}
      scope="test"
      channelId="general"
      channelName="General"
      openThread={() => true}
    />,
  );
  try {
    await screen.findByText("Some threads could not be checked.");
    expect(
      screen.queryByRole("button", { name: /Review the release checklist/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Explore the onboarding flow/ }),
    ).not.toBeInTheDocument();
    const before = data.report.queries.length;
    act(() => data.renameChannel("Renamed"));
    expect(data.report.queries).toHaveLength(before);
    data.missingAgentProfile(false);
    fireEvent.click(
      screen.getByRole("button", { name: "Retry session check" }),
    );
    await screen.findByRole("button", { name: /Explore the onboarding flow/ });
    await settled();
    expect(
      screen.getByRole("button", { name: /Review the release checklist/ }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /Human-only planning thread/ }),
    ).not.toBeInTheDocument();
    expect(
      data.report.queries
        .slice(before)
        .flat()
        .filter((filter) => filter["#e"]),
    ).toHaveLength(1);
    expect(
      data.report.queries
        .slice(before)
        .flat()
        .filter((filter) => filter.kinds?.includes(0)),
    ).toHaveLength(1);
  } finally {
    view.unmount();
    data.dispose();
  }
});

it.each(["cache", "dispose"] as const)(
  "actual %s owner fences late profile results without restoring eligibility",
  async (operation) => {
    const data = sessionsData();
    const gate = data.holdProfiles();
    const view = render(
      <RecentChannelThreads
        session={data.session}
        scope="test"
        channelId="general"
        channelName="General"
        openThread={() => true}
      />,
    );
    try {
      await act(async () => {
        await gate.started;
      });
      expect(screen.getByText("Checking threads for agents…")).toBeVisible();
      if (operation === "cache")
        await act(async () => {
          await data.owner.clearCache();
        });
      else {
        view.unmount();
        data.dispose();
      }
    } finally {
      await act(async () => gate.release());
    }
    expect(data.session.profiles.snapshot().size).toBe(0);
    expect(
      screen.queryByRole("button", { name: /Review the release checklist/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Explore the onboarding flow/ }),
    ).not.toBeInTheDocument();
    if (operation === "cache") {
      view.unmount();
      data.dispose();
    }
  },
);

it("replacement session retires the prior observer and pending profile completion", async () => {
  const old = harness([root(1, { mentions: [other] })]);
  const gate = deferred();
  old.ensure.mockImplementationOnce(() => gate.promise);
  const view = old.mount();
  await screen.findByText("Checking threads for agents…");
  const next = harness([root(2, { authorId: agent })]);
  view.rerender(<RecentChannelThreads {...next.props} />);
  await settled();
  expect(row(2)).toBeVisible();
  expect(row(1)).toBeNull();
  await act(async () => gate.resolve());
  expect(row(1)).toBeNull();
  expect(row(2)).toBeVisible();
  expect(old.views[0]?.dispose).toHaveBeenCalledOnce();
  expect(old.pl.size).toBe(0);
  expect(next.pl.size).toBe(1);
});

it("a signed same-text root edit removes mention-only classification using the actual fold", async () => {
  const author = keypair(),
    authority = keypair();
  const event = message(author, "channel", "Thread 1", 100, [["p", agent]]);
  const original = foldMessages("channel", authority.pubkey, [event]);
  const h = harness(original, [
    [author.pubkey, { name: "Human" }],
    [agent, { name: "Agent", isAgent: true }],
  ]);
  h.mount();
  await settled();
  expect(row(1)).toBeVisible();
  const edit = signed(author, {
    kind: 40003,
    created_at: 101,
    content: event.content,
    tags: [
      ["h", "channel"],
      ["e", event.id],
    ],
  });
  h.rows(foldMessages("channel", authority.pubkey, [event, edit]));
  expect(row(1)).toBeNull();
  expect(h.observe).toHaveBeenCalledTimes(1);
});
