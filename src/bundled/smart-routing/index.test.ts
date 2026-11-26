// @vitest-environment jsdom
import { Context, Service } from "@deepseek-ai/cordis";
import { render, screen } from "@testing-library/react";
import { createElement, type ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DecisionRequest } from "../../features/decisions/service";
import type { MentionPlacer } from "../../features/agents/mention-placement";
import type { RelayEvent } from "../../features/relay/events";
import { threadReference } from "../../features/relay/thread-reference";
import { bundledPlugins } from "..";
import * as plugin from ".";
import manifest from "./manifest.json";
import { ELSEWHERE_NOTE, WHERE_KEYS } from "./where";

const hex = (c: string) => c.repeat(64);
const OWNER = hex("a");
const ART = hex("c");
const MBOT = hex("b");
const PAT = hex("f");
const CH = "chan-1";
const EARLIER = hex("1");

type WhereAnswer = {
  place?: "working" | "shared";
  ask_elsewhere?: number;
  ask_top?: number;
  ask_thread?: number;
  moved_on?: number;
  target?: string;
};

function start() {
  let live:
    | ((batch: { events: unknown[]; channelId?: string }) => void)
    | undefined;
  const history = [
    {
      id: EARLIER,
      kind: 9,
      pubkey: PAT,
      created_at: 100,
      tags: [["h", CH]],
      content: "the build broke on main",
    },
    {
      id: hex("2"),
      kind: 9,
      pubkey: ART,
      created_at: 101,
      tags: [["h", CH]],
      content: "looking",
    },
  ];
  const profileMap = new Map([
    [OWNER, { name: "baxen" }],
    [PAT, { name: "Pat" }],
  ]);
  const session = {
    viewer: OWNER,
    subscribeLive(listener: typeof live) {
      live = listener;
      return () => (live = undefined);
    },
    channels: {
      window: () => undefined,
      list: () => ({
        channels: [
          {
            id: CH,
            name: "work",
            channelType: "stream",
            members: [OWNER, MBOT, ART, PAT],
          },
        ],
      }),
    },
    read: vi.fn(
      async (_filters?: unknown, _opts?: { signal?: AbortSignal }) => history,
    ),
    profiles: {
      snapshot: () => profileMap,
      subscribe: () => () => {},
    },
    ownerMentions: {
      confirmedOwnerSends: (_place: unknown, ids: readonly string[]) => ids,
    },
  };
  const agent = (pubkey: string, name: string) => ({
    key: pubkey,
    pubkey,
    name,
    place: "here",
    relay: "wss://relay.example",
  });
  const agents = [agent(MBOT, "mbot"), agent(ART, "ART")];
  const calls: DecisionRequest[] = [];
  /** Mentions the plugin delivered, as the host took them. */
  const delivered: { key: string; event: RelayEvent; note?: string }[] = [];
  const state = {
    down: false,
    /** How long Jev takes to answer. */
    delayMs: 0,
    where: {} as WhereAnswer,
    who: { ART: 0.84, mbot: 0.1 } as Record<string, number>,
    deliverResult: { status: "delivered" } as
      | { status: "delivered" }
      | { status: "dropped"; reason: string },
  };
  /** Placers registered now; each is removed with the scope that added it. */
  const placers = new Set<MentionPlacer>();
  const deliverMention = async (
    key: string,
    event: RelayEvent,
    options: { note?: string } = {},
  ) => {
    delivered.push({ key, event, ...options });
    return state.deliverResult;
  };
  class Agents extends Service {
    constructor(ctx: Context) {
      super(ctx, "agents");
    }
    snapshot = () => ({ agents, running: agents });
    deliverMention = deliverMention;
    addTool = vi.fn();
    registerMentionPlacement(placer: MentionPlacer) {
      this.ctx.effect(() => {
        placers.add(placer);
        return () => void placers.delete(placer);
      });
    }
  }
  const root = new Context();
  root.provide("relay", {
    snapshot: () => ({
      status: "ready",
      session,
      viewer: OWNER,
      origin: "wss://relay.example",
    }),
    subscribe: () => () => {},
  } as never);
  const agentsService = new Agents(root);
  root.provide("decisions", {
    async decide(request: DecisionRequest) {
      calls.push(request);
      if (state.delayMs)
        await new Promise((resolve) => setTimeout(resolve, state.delayMs));
      if (state.down)
        return { outcome: "failed", backend: "jev", reason: "service_error" };
      const w = {
        ask_elsewhere: 0.02,
        ask_top: 0.02,
        ask_thread: 0.02,
        moved_on: 0.05,
        place: "shared",
        target: "new",
        ...state.where,
      };
      const answers = Object.fromEntries(
        Object.entries(request.questions).map(([key, q]) => {
          if (key === "place")
            return [
              key,
              {
                type: "choice",
                choice: w.place,
                confidence: 0.9,
                probabilities: {
                  working: w.place === "working" ? 0.9 : 0.1,
                  shared: w.place === "working" ? 0.1 : 0.9,
                },
              },
            ];
          if (q.type === "choice")
            return [
              key,
              {
                type: "choice",
                choice: w.target,
                confidence: 0.8,
                probabilities: {},
              },
            ];
          return [
            key,
            {
              type: "yes_no",
              probability:
                key in w ? w[key as keyof typeof w] : (state.who[key] ?? 0),
            },
          ];
        }),
      );
      return { outcome: "answered", backend: "jev", model: "jev", answers };
    },
  } as never);
  const actions: {
    id: string;
    matches: (message: { id: string }) => boolean;
    marker?: ComponentType<{ message: { id: string }; session: unknown }>;
  }[] = [];
  root.provide("conversation", {
    registerMessageAction: (action: (typeof actions)[number]) =>
      void actions.push(action),
  } as never);
  const cards: { id: string; component: ComponentType }[] = [];
  root.provide("settingsCards", {
    register: (card: { id: string; component: ComponentType }) =>
      void cards.push(card),
  } as never);
  // As the plugin runtime loads a module.
  const fiber = root.plugin({
    name: manifest.id,
    inject: plugin.inject,
    apply: (ctx: Context) => plugin.apply(ctx),
  });
  /** Registers a decisions provider, as the decisions service says it. */
  let withdraw: (() => void) | undefined;
  const provider = {
    add() {
      withdraw = root.provide("decisionsAnswerable", { version: 1 });
    },
    async remove() {
      withdraw?.();
      withdraw = undefined;
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
  const send = async (event: Record<string, unknown>) => {
    live?.({
      events: [
        {
          kind: 9,
          pubkey: OWNER,
          created_at: Math.floor(Date.now() / 1000),
          content: "",
          ...event,
        },
      ],
      channelId: CH,
    });
    await vi.waitFor(() => expect(calls.length + skipped()).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  let skipCount = 0;
  const skipped = () => skipCount;
  const place = (
    event: Record<string, unknown>,
    signal = new AbortController().signal,
  ) => {
    const placer = [...placers][0];
    if (!placer) throw new Error("No placer registered");
    return placer.place(
      {
        agent: ART,
        channel: CH,
        event: { kind: 9, pubkey: OWNER, created_at: 200, ...event } as never,
      },
      signal,
    );
  };
  /** Where the `index`th delivered mention lands, as the host places it: a
   * thread reply in its thread, a top-level one where the hook says, else a
   * thread on it. */
  const landed = async (index: number) => {
    const d = delivered[index];
    if (!d) throw new Error("Nothing delivered");
    const thread = threadReference(d.event);
    if (thread) return { root: thread.rootId };
    const placer = [...placers][0];
    const answer = placer
      ? ((await placer.place(
          { agent: d.key, channel: CH, event: d.event } as never,
          new AbortController().signal,
        )) as { topLevel?: true; root?: string } | undefined)
      : undefined;
    if (answer?.topLevel) return { topLevel: true };
    return { root: answer?.root ?? d.event.id };
  };
  return {
    send,
    place,
    landed,
    /** The `smart_routing_log` tool the plugin added. */
    tool: () => {
      const added = agentsService?.addTool.mock.calls.at(-1)?.[0] as
        | { call(...args: unknown[]): Promise<string> }
        | undefined;
      if (!added) throw new Error("No log tool");
      return added;
    },
    calls,
    delivered,
    state,
    skip: () => skipCount++,
    fiber,
    provider,
    placers,
    cards,
    actions,
    session,
    live: () => live,
  };
}
/** A plugin started with a decisions provider already registered. */
async function setup() {
  const f = start();
  f.provider.add();
  await f.fiber.await();
  return f;
}

const top = (id: string, content: string, tags: string[][] = []) => ({
  id: hex(id),
  content,
  tags: [["h", CH], ...tags],
});
const whoKeys = (request: DecisionRequest | undefined) =>
  Object.keys(request?.questions ?? {}).filter(
    (key) => !(WHERE_KEYS as readonly string[]).includes(key),
  );

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("smart routing", () => {
  it("in a thread: who only, no where questions, delivered as a mention that stays in that thread", async () => {
    const f = await setup();
    await f.send(
      top("3", "and add a test", [
        ["e", EARLIER, "", "root"],
        ["e", EARLIER, "", "reply"],
      ]),
    );
    await vi.waitFor(() => expect(f.delivered).toHaveLength(1));
    expect(WHERE_KEYS.some((key) => key in (f.calls[0]?.questions ?? {}))).toBe(
      false,
    );
    // The owner's own message, as if they had tagged the agent.
    expect(f.delivered[0]).toMatchObject({ key: ART, event: { id: hex("3") } });
    expect(f.delivered[0]?.note).toContain("Jev picked you (84%)");
    await expect(f.landed(0)).resolves.toEqual({ root: EARLIER });
  });

  it("a tagged reply in a thread is never placed and asks Jev nothing", async () => {
    const f = await setup();
    await expect(
      f.place(
        top("3", "@ART and this", [
          ["e", EARLIER, "", "reply"],
          ["p", ART],
        ]),
      ),
    ).resolves.toBeUndefined();
    expect(f.calls).toHaveLength(0);
  });

  it("top level, untagged: one request for who + where, woken at the top level of a working conversation", async () => {
    const f = await setup();
    f.state.where = { place: "working" };
    await f.send(top("4", "is it done?"));
    await vi.waitFor(() => expect(f.delivered).toHaveLength(1));
    expect(f.calls).toHaveLength(1);
    expect(whoKeys(f.calls[0])).toEqual(["mbot", "ART"]);
    // The host asks the hook, which answers from that decision: no second
    // Jev call.
    await expect(f.landed(0)).resolves.toEqual({ topLevel: true });
    expect(f.calls).toHaveLength(1);
  });

  it("a shared space threads on the message; a moved-on follow-up goes to the earlier message's thread", async () => {
    const f = await setup();
    await f.send(top("5", "who owns the flaky suite?"));
    await vi.waitFor(() => expect(f.delivered).toHaveLength(1));
    await expect(f.landed(0)).resolves.toEqual({ root: hex("5") });
    f.state.where = { place: "working", moved_on: 0.95, target: "m1" };
    await f.send(top("6", "back to Pat's note: did the build pass?"));
    await vi.waitFor(() => expect(f.delivered).toHaveLength(2));
    await expect(f.landed(1)).resolves.toEqual({ root: EARLIER });
    // Under the stricter moved-on line, it stays at the top level.
    f.state.where = { place: "working", moved_on: 0.85, target: "m1" };
    await f.send(top("7", "back to it"));
    await vi.waitFor(() => expect(f.delivered).toHaveLength(3));
    await expect(f.landed(2)).resolves.toEqual({ topLevel: true });
    expect(f.calls).toHaveLength(3);
  });

  it("tagged at the top level: where only, placed through the hook, and agents tagged together share one decision", async () => {
    const f = await setup();
    f.state.where = { place: "working" };
    const event = top("8", "@ART @mbot status?", [
      ["p", ART],
      ["p", MBOT],
    ]);
    const [first, second] = await Promise.all([f.place(event), f.place(event)]);
    expect(first).toEqual({ topLevel: true });
    expect(second).toEqual({ topLevel: true });
    expect(f.calls).toHaveLength(1);
    expect(whoKeys(f.calls[0])).toEqual([]);
    expect(JSON.parse(f.calls[0]?.state ?? "{}").new_message.tags).toEqual([
      "mbot",
      "ART",
    ]);
    expect(f.delivered).toHaveLength(0);
    // The untagged flow leaves tagged messages to the hook.
    await f.send(event).catch(() => {});
    expect(f.calls).toHaveLength(1);
  });

  it("an ask for another place keeps the place and adds the note", async () => {
    const f = await setup();
    f.state.where = { place: "shared", ask_elsewhere: 0.92 };
    await expect(
      f.place(top("9", "@ART post it in #release-notes", [["p", ART]])),
    ).resolves.toEqual({
      root: hex("9"),
      note: ELSEWHERE_NOTE,
    });
  });

  it("Jev down: nothing delivered for an untagged message, no placement for a tagged one", async () => {
    const f = await setup();
    f.state.down = true;
    await expect(
      f.place(top("a", "@ART is it done?", [["p", ART]])),
    ).resolves.toBeUndefined();
    await f.send(top("b", "is it done?"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(f.calls).toHaveLength(2);
    expect(f.delivered).toHaveLength(0);
  });

  it("stops waiting for Jev at 800ms when placing a tagged message, keeps today's place, and counts the timeout", async () => {
    const f = await setup();
    f.state.where = { place: "working" };
    f.state.delayMs = 900;
    const started = Date.now();
    await expect(
      f.place(top("e", "@ART is it done?", [["p", ART]])),
    ).resolves.toBeUndefined();
    const waited = Date.now() - started;
    expect(waited).toBeGreaterThanOrEqual(790);
    expect(waited).toBeLessThan(1000);
    const tool = f.tool();
    const log = JSON.parse(await tool.call({}, {}, {}));
    expect(log.timeouts).toMatchObject({
      placeMs: 800,
      place: { asked: 1, timedOut: 1 },
    });
    expect(log.entries[0]).toMatchObject({
      flow: "where",
      status: "failed",
      reason: "Jev timeout",
    });
  });

  it("shares the 800ms placement deadline across context loading and Jev, falling back to cached context", async () => {
    const f = await setup();
    f.state.where = { place: "working" };
    f.session.channels.window = () =>
      ({
        status: "loading",
        hasMore: true,
        rows: [
          {
            id: EARLIER,
            authorId: PAT,
            createdAt: 100,
            content: "cached timeline note",
          },
        ],
      }) as never;
    const readSignals: AbortSignal[] = [];
    f.session.read.mockImplementation(
      (_filters: unknown, opts?: { signal?: AbortSignal }) => {
        if (opts?.signal) readSignals.push(opts.signal);
        return new Promise(() => {});
      },
    );

    const fastStart = Date.now();
    await expect(
      f.place(top("f", "@ART is it done?", [["p", ART]])),
    ).resolves.toEqual({ topLevel: true });
    expect(Date.now() - fastStart).toBeLessThan(800);
    expect(readSignals[0]?.aborted).toBe(true);
    expect(f.calls[0]?.state).toContain("cached timeline note");

    // Slow relay + slow Jev still stops at the shared 800ms deadline.
    f.state.delayMs = 600;
    const slowStart = Date.now();
    await expect(
      f.place(top("1", "@ART still waiting?", [["p", ART]])),
    ).resolves.toBeUndefined();
    const slowWaited = Date.now() - slowStart;
    expect(slowWaited).toBeGreaterThanOrEqual(790);
    expect(slowWaited).toBeLessThan(1000);
    const log = JSON.parse(await f.tool().call({}, {}, {}));
    expect(log.entries[0]).toMatchObject({
      flow: "where",
      status: "failed",
      reason: "Jev timeout",
    });
  });

  it("honors the placement hook abort signal without recording a placement, while letting a surviving co-tagged caller finish", async () => {
    const f = await setup();
    f.state.where = { place: "working" };
    let readSignal: AbortSignal | undefined;
    f.session.read.mockImplementationOnce(
      (_filters: unknown, opts?: { signal?: AbortSignal }) => {
        readSignal = opts?.signal;
        return new Promise(() => {});
      },
    );

    const aborted = new AbortController();
    const pending = f.place(
      top("2", "@ART check", [["p", ART]]),
      aborted.signal,
    );
    setTimeout(() => aborted.abort(), 40);
    const started = Date.now();
    await expect(pending).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(500);
    expect(readSignal?.aborted).toBe(true);
    expect(f.calls).toHaveLength(0);
    await vi.waitFor(async () => {
      const log = JSON.parse(await f.tool().call({}, {}, {}));
      expect(log.entries[0]).toMatchObject({
        flow: "where",
        status: "failed",
        reason: "placement cancelled",
      });
    });

    // Two agents tagged together: aborting one caller does not cancel the other.
    f.state.delayMs = 80;
    const event = top("3", "@ART @mbot status?", [
      ["p", ART],
      ["p", MBOT],
    ]);
    const first = new AbortController();
    const second = new AbortController();
    setTimeout(() => first.abort(), 20);
    const [a, b] = await Promise.all([
      f.place(event, first.signal),
      f.place(event, second.signal),
    ]);
    expect(a).toBeUndefined();
    expect(b).toEqual({ topLevel: true });
  });

  it("a Jev-picked agent and a tagged agent end up in the same place for the same message", async () => {
    for (const where of [
      { place: "working" },
      { place: "shared" },
      { place: "working", moved_on: 0.95, target: "m1" },
      { place: "shared", ask_top: 0.9 },
      { place: "working", ask_thread: 0.9 },
    ] as const) {
      const f = await setup();
      f.state.where = where;
      await f.send(top("c", "the message"));
      await vi.waitFor(() => expect(f.delivered).toHaveLength(1));
      const picked = await f.landed(0);
      // A fresh plugin, so the tagged flow decides on its own.
      const g = await setup();
      g.state.where = where;
      const { note: _note, ...tagged } =
        ((await g.place(top("c", "the message", [["p", ART]]))) as
          | { note?: string }
          | undefined) ?? {};
      expect(tagged, JSON.stringify(where)).toEqual(picked);
    }
  });

  it("ships off by default", () => {
    const bundled = bundledPlugins.find(
      (entry) => entry.manifest.id === manifest.id,
    );
    if (!bundled) throw new Error("Smart routing is not bundled");
    expect(bundled.enabledByDefault).toBe(false);
    expect("requires" in manifest).toBe(false);
  });

  it("with no provider it starts, does nothing and says why; a provider turns routing on, and removing it turns it off", async () => {
    const f = start();
    await f.fiber.await();
    // Active, not failed or waiting: the plugin runtime's ACTIVE state.
    expect(f.fiber.state).toBe(2);
    expect(f.placers.size).toBe(0);
    expect(f.live()).toBeUndefined();
    const card = f.cards.find((entry) => entry.id === "status");
    if (!card) throw new Error("No settings card");
    render(createElement(card.component));
    expect(screen.getByText("Needs a decisions provider")).toBeTruthy();

    // A provider registered later: the hook and the watch come up.
    f.provider.add();
    await vi.waitFor(() => expect(f.placers.size).toBe(1));
    expect(f.live()).toBeDefined();
    expect(await screen.findByText("Routing your messages")).toBeTruthy();
    f.state.where = { place: "working" };
    await f.send(top("d", "is it done?"));
    await vi.waitFor(() => expect(f.delivered).toHaveLength(1));

    // The last provider goes: both are removed, and messages go where they
    // always have.
    await f.provider.remove();
    expect(f.placers.size).toBe(0);
    expect(f.live()).toBeUndefined();
    expect(await screen.findByText("Needs a decisions provider")).toBeTruthy();
    expect(f.calls).toHaveLength(1);
    expect(f.delivered).toHaveLength(1);
  });

  it("shows a quiet marker only for picked messages (with undelivered status), while keeping inspection on every routed message", async () => {
    const f = await setup();
    const action = f.actions.find((entry) => entry.id === "smart-routing");
    if (!action?.marker) throw new Error("No marker registered");
    const Marker = action.marker;

    // Picked and delivered: marker renders with no hover title.
    f.state.where = { place: "working" };
    await f.send(top("1", "check this"));
    await vi.waitFor(() => expect(f.delivered).toHaveLength(1));
    expect(action.matches({ id: hex("1") })).toBe(true);
    const picked = render(
      createElement(Marker, { message: { id: hex("1") }, session: f.session }),
    );
    const pickedMark = screen.getByRole("img", { name: "Routed to ART" });
    expect(pickedMark.getAttribute("title")).toBeNull();
    picked.unmount();

    // Picked but undelivered: marker flags delivery failure.
    f.state.deliverResult = { status: "dropped", reason: "offline" };
    await f.send(top("2", "try again"));
    await vi.waitFor(() => expect(f.delivered).toHaveLength(2));
    const failed = render(
      createElement(Marker, { message: { id: hex("2") }, session: f.session }),
    );
    expect(
      screen.getByRole("img", { name: "Routed to ART, not delivered" }),
    ).toBeTruthy();
    failed.unmount();

    // Tagged placement and below-threshold none stay silent in the timeline
    // but remain inspectable via the message action.
    await f.place(top("3", "@ART hi", [["p", ART]]));
    expect(action.matches({ id: hex("3") })).toBe(true);
    const placed = render(
      createElement(Marker, { message: { id: hex("3") }, session: f.session }),
    );
    expect(placed.container.firstChild).toBeNull();
    placed.unmount();

    f.state.who = { ART: 0.2, mbot: 0.1 };
    await f.send(top("4", "just thinking aloud"));
    await vi.waitFor(() => expect(action.matches({ id: hex("4") })).toBe(true));
    const none = render(
      createElement(Marker, { message: { id: hex("4") }, session: f.session }),
    );
    expect(none.container.firstChild).toBeNull();
    none.unmount();
  });
});
