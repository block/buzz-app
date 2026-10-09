import { expect, it, vi } from "vitest";
import { createAgentControl, type AgentControl } from "./control";
import { controlFixture } from "./control-testing";
import type { Communities } from "../communities/service";
import type { RelaySession } from "../relay/session";
import type { ChannelKit } from "../channel-templates/capability";
import type { KitEntry, Team } from "../channel-templates/model";
import {
  bindTeamTextSync,
  deliverTeamTexts,
  readTeamTexts,
  teamSyncError,
  teamTextConflict,
  type TeamText,
} from "./team-instructions";

const a = "a".repeat(64);
const b = "b".repeat(64);
const other = (text: string, agents = [a]): TeamText => ({
  team: { type: "team", id: "other", name: "Reviewers", agents },
  text,
});
const team = { id: "mine", agents: [a] };

it("names the other team when a shared member would get different text", () => {
  expect(teamTextConflict([other("THEIRS")], team, "OURS")).toContain(
    '"Reviewers"',
  );
});

it.each([
  ["the saved team has no text", [other("THEIRS")], team, ""],
  ["the other team has no text", [other("")], team, "OURS"],
  ["the text matches after trimming", [other("OURS")], team, " OURS\n"],
  ["no member is shared", [other("THEIRS", [b])], team, "OURS"],
  [
    "the other entry is this team",
    [other("THEIRS")],
    { ...team, id: "other" },
    "OURS",
  ],
])("allows the save when %s", (_, others, saved, text) => {
  expect(teamTextConflict(others, saved, text)).toBeUndefined();
});

it("can't certify a save when an overlapping team is unreadable", () => {
  expect(
    teamTextConflict([{ ...other(""), text: undefined }], team, "OURS"),
  ).toContain("can't be read");
});

const entry = (value: Team, deleted = false): KitEntry => ({
  eventId: `${value.id}-head`,
  createdAt: 1,
  record: {
    version: value.portable ? 2 : 1,
    community: "https://relay.example",
    deleted,
    value,
  },
});
const portable = {
  version: 1 as const,
  owner: "c".repeat(64),
  revision: "r",
  digest: "d".repeat(64),
  bytes: 1,
  chunks: 1,
};

it("reads each team's current text by precedence", async () => {
  const heads: Record<string, { text: string; head: string } | Error> = {
    head: { text: " HEAD \n", head: "h" },
    empty: { text: "", head: "h" },
    broken: new Error("chunk missing"),
  };
  const kit = {
    refresh: vi.fn(async () => {}),
    snapshot: () => ({
      status: "ready",
      entries: [
        entry({ type: "team", id: "head", name: "", agents: [a], portable }),
        entry({ type: "team", id: "empty", name: "", agents: [a], portable }),
        entry({ type: "team", id: "legacy", name: "", agents: [a], portable }),
        entry({ type: "team", id: "plain", name: "", agents: [a] }),
        entry({ type: "team", id: "broken", name: "", agents: [a], portable }),
        entry({ type: "team", id: "gone", name: "", agents: [a] }, true),
      ],
    }),
    readText: vi.fn(async (id: string) => {
      const head = heads[id];
      if (head instanceof Error) throw head;
      return head;
    }),
    loadTeam: vi.fn(async (value: Team) => value.id),
  } as unknown as ChannelKit;
  const control = {
    previewTeam: vi.fn(async () => ({ team: { instructions: "BUNDLE" } })),
  } as unknown as AgentControl;
  const texts = await readTeamTexts(kit, control);
  expect(
    Object.fromEntries(texts.map(({ team, text }) => [team.id, text])),
  ).toEqual({
    head: "HEAD",
    empty: "",
    legacy: "BUNDLE",
    plain: "",
    broken: undefined,
    gone: "",
  });
  // Only the team proven to have no head reads bundle text; a deleted team
  // releases its members without loading anything.
  expect(vi.mocked(kit.loadTeam).mock.calls.map(([t]) => t.id)).toEqual([
    "legacy",
  ]);
  expect(vi.mocked(kit.readText)).not.toHaveBeenCalledWith("gone");
  expect(texts.find(({ team }) => team.id === "gone")?.team.agents).toEqual([]);
});

it("syncs team text once per session after teams and agents load", async () => {
  const viewer = "c".repeat(64);
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const channelList = { status: "loading" as string };
  const kitState = {
    status: "loading" as string,
    entries: [
      {
        eventId: "e",
        createdAt: 1,
        record: {
          version: 1,
          community: "https://relay.example",
          deleted: false,
          value: { type: "team", id: "plain", name: "Plain", agents: [a] },
        },
      },
    ],
  };
  const session = {
    viewer,
    scope: `https://relay.example:${viewer}`,
    channelKit: {
      subscribe,
      snapshot: () => kitState,
      ensure: vi.fn(),
      refresh: vi.fn(async () => {}),
      readText: vi.fn(async () => undefined),
    },
    channels: { subscribeList: subscribe, list: () => channelList },
  } as unknown as RelaySession;
  const controlState = { status: "loading" as string };
  const syncTeamInstructions = vi.fn(async () => ({}));
  const control = {
    subscribe,
    snapshot: () => controlState,
    syncTeamInstructions,
  } as unknown as AgentControl;
  const communities = {
    relay: { subscribe, snapshot: () => ({ status: "ready", session }) },
  } as unknown as Communities;
  const stop = bindTeamTextSync(control, communities);
  // The catalog read waits for channel discovery, then starts even when no
  // channel view is open (e.g. the app opened on Settings).
  expect(session.channelKit.ensure).not.toHaveBeenCalled();
  channelList.status = "ready";
  notify();
  expect(session.channelKit.ensure).toHaveBeenCalled();
  kitState.status = "ready";
  notify();
  expect(syncTeamInstructions).not.toHaveBeenCalled();
  controlState.status = "ready";
  notify();
  notify();
  await vi.waitFor(() =>
    expect(syncTeamInstructions).toHaveBeenCalledExactlyOnceWith(
      "https://relay.example",
      { plain: "" },
    ),
  );
  stop();
});

/** A ready session whose catalog holds `teams`, with each team's text in
 * `texts`, and an agent control that owns agent `a` ("Scout"). */
function harness(teams: Team[], texts: Record<string, string>) {
  const viewer = "c".repeat(64);
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const kit = {
    subscribe,
    snapshot: () => ({ status: "ready", entries: teams.map((t) => entry(t)) }),
    ensure: vi.fn(),
    refresh: vi.fn(async () => {}),
    readText: vi.fn(async (id: string) => ({ text: texts[id], head: "h" })),
  } as unknown as ChannelKit;
  const session = {
    viewer,
    scope: `https://relay.example:${viewer}`,
    channelKit: kit,
    channels: { subscribeList: subscribe, list: () => ({ status: "ready" }) },
  } as unknown as RelaySession;
  const controlState = {
    status: "ready",
    busy: false,
    data: {
      agents: [
        {
          id: "scout",
          pubkey: a,
          name: "Scout",
          // Native agents store the canonical websocket URL.
          relayUrl: "wss://relay.example",
        },
      ],
    },
  };
  const syncTeamInstructions = vi.fn(
    async (_relay: string, _texts: Record<string, string>) => ({}),
  );
  const control = {
    subscribe,
    snapshot: () => controlState,
    syncTeamInstructions,
  } as unknown as AgentControl;
  const communities = {
    relay: { subscribe, snapshot: () => ({ status: "ready", session }) },
  } as unknown as Communities;
  return {
    kit,
    session,
    control,
    controlState,
    communities,
    syncTeamInstructions,
    notify,
  };
}
const shared = (id: string, name = id): Team => ({
  type: "team",
  id,
  name,
  agents: [a],
});

it("an older delivery that reads first never lands after a newer save's", async () => {
  const texts = { one: "OLD" };
  const h = harness([shared("one")], texts);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  vi.mocked(h.kit.readText).mockImplementationOnce(async (id) => {
    const read = { text: texts[id as "one"], head: "h" };
    await gate;
    return read;
  });
  // App-start sync reads OLD, then stalls; a save changes the text and
  // delivers while the first pass is still waiting.
  const startup = deliverTeamTexts(h.kit, h.control, h.session);
  await vi.waitFor(() => expect(h.kit.readText).toHaveBeenCalled());
  texts.one = "NEW";
  const save = deliverTeamTexts(h.kit, h.control, h.session);
  // Give the save's pass every chance to read and deliver before the
  // stalled one resumes.
  await new Promise((resolve) => setTimeout(resolve, 20));
  release();
  await Promise.all([startup, save]);
  expect(h.syncTeamInstructions.mock.calls.map(([, t]) => t.one)).toEqual([
    "OLD",
    "NEW",
  ]);
});

it("waits out a busy agent operation and then delivers in the same session", async () => {
  const h = harness([shared("one")], { one: "TEXT" });
  h.controlState.busy = true;
  const stop = bindTeamTextSync(h.control, h.communities);
  h.notify();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(h.syncTeamInstructions).not.toHaveBeenCalled();
  h.controlState.busy = false;
  h.notify();
  await vi.waitFor(() =>
    expect(h.syncTeamInstructions).toHaveBeenCalledExactlyOnceWith(
      "https://relay.example",
      { one: "TEXT" },
    ),
  );
  h.notify();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(h.syncTeamInstructions).toHaveBeenCalledOnce();
  stop();
});

/** The harness's session and catalog with the real agent control over a
 * host whose sync fails as `sync` decides; a rejected sync leaves the real
 * control in `error`, as native does. */
function realControl(sync: (call: number) => string | undefined) {
  const h = harness([shared("one")], { one: "TEXT" });
  const { data, agent } = controlFixture();
  Object.assign(agent, {
    pubkey: a,
    name: "Scout",
    relayUrl: "wss://relay.example",
  });
  let calls = 0;
  const syncTeamInstructions = vi.fn(async () => {
    const failure = sync(++calls);
    if (failure) throw failure;
    return structuredClone(data);
  });
  const control = createAgentControl({
    snapshot: async () => structuredClone(data),
    syncTeamInstructions,
  } as unknown as Parameters<typeof createAgentControl>[0]);
  return { ...h, control, syncTeamInstructions };
}

it("recovers the real control after a rejected app-start delivery and delivers in the same session", async () => {
  vi.useFakeTimers();
  try {
    const h = realControl((call) => (call === 1 ? "host failed" : undefined));
    await h.control.refresh();
    const stop = bindTeamTextSync(h.control, h.communities);
    await vi.waitFor(() =>
      expect(h.syncTeamInstructions).toHaveBeenCalledOnce(),
    );
    expect(h.control.snapshot().status).toBe("error");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.syncTeamInstructions).toHaveBeenCalledTimes(2);
    expect(h.control.snapshot().status).toBe("ready");
    expect(teamSyncError(h.kit)).toBeUndefined();
    stop();
  } finally {
    vi.useRealTimers();
  }
});

it("shows the error once a real control's deliveries keep failing", async () => {
  vi.useFakeTimers();
  try {
    const h = realControl(() => "host failed");
    await h.control.refresh();
    const stop = bindTeamTextSync(h.control, h.communities);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.syncTeamInstructions).toHaveBeenCalledTimes(4);
    expect(teamSyncError(h.kit)).toMatch(/weren't updated: host failed/);
    stop();
  } finally {
    vi.useRealTimers();
  }
});

it("counts a failed catalog re-read as a failed attempt", async () => {
  vi.useFakeTimers();
  try {
    const h = realControl((call) => (call === 1 ? "host failed" : undefined));
    vi.mocked(h.kit.refresh).mockImplementation(async () => {
      if (vi.mocked(h.kit.refresh).mock.calls.length > 1)
        throw new Error("relay unreachable");
    });
    await h.control.refresh();
    const stop = bindTeamTextSync(h.control, h.communities);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.syncTeamInstructions).toHaveBeenCalledOnce();
    expect(teamSyncError(h.kit)).toMatch(/relay unreachable/);
    stop();
  } finally {
    vi.useRealTimers();
  }
});

it("does nothing after cleanup, even when a failure settles late", async () => {
  vi.useFakeTimers();
  try {
    const h = harness([shared("one")], { one: "TEXT" });
    let fail!: (reason: Error) => void;
    h.syncTeamInstructions.mockImplementationOnce(
      () => new Promise((_, reject) => (fail = reject)),
    );
    const stop = bindTeamTextSync(h.control, h.communities);
    await vi.waitFor(() =>
      expect(h.syncTeamInstructions).toHaveBeenCalledOnce(),
    );
    stop();
    fail(new Error("late"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.syncTeamInstructions).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

it("refuses delivery while two devices left one agent on two differently instructed teams, until one team is edited", async () => {
  // Each device saved its own team after its own check passed, so the relay
  // now lists Scout on both teams with different text.
  const texts = { one: "FIRST", two: "SECOND" };
  const h = harness(
    [shared("one", "Writers"), shared("two", "Editors")],
    texts,
  );
  await expect(deliverTeamTexts(h.kit, h.control, h.session)).rejects.toThrow(
    'Scout is on teams "Writers" and "Editors", which have different instructions',
  );
  expect(h.syncTeamInstructions).not.toHaveBeenCalled();
  texts.two = "FIRST";
  await deliverTeamTexts(h.kit, h.control, h.session);
  expect(h.syncTeamInstructions).toHaveBeenCalledExactlyOnceWith(
    "https://relay.example",
    { one: "FIRST", two: "FIRST" },
  );
});
