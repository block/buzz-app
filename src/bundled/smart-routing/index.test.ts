// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DecisionRequest } from "../../features/decisions/service";
import { unmetRequirement } from "../../plugins/requirements";
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

function setup() {
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
    read: vi.fn(async () => history),
    profiles: {
      snapshot: () =>
        new Map([
          [OWNER, { name: "baxen" }],
          [PAT, { name: "Pat" }],
        ]),
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
  const wakes: { key: string; wake: Record<string, unknown> }[] = [];
  const state = {
    down: false,
    where: {} as WhereAnswer,
    who: { ART: 0.84, mbot: 0.1 } as Record<string, number>,
  };
  let placer:
    | { place: (input: unknown, signal: AbortSignal) => Promise<unknown> }
    | undefined;
  const ctx = {
    relay: {
      snapshot: () => ({
        status: "ready",
        session,
        viewer: OWNER,
        origin: "wss://relay.example",
      }),
      subscribe: () => () => {},
    },
    agents: {
      snapshot: () => ({ agents, running: agents }),
      async wake(key: string, wake: Record<string, unknown>) {
        wakes.push({ key, wake });
        return { status: "delivered" };
      },
      registerMentionPlacement: (value: typeof placer) => (placer = value),
      addTool: vi.fn(),
    },
    decisions: {
      async decide(request: DecisionRequest) {
        calls.push(request);
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
    },
    conversation: { registerMessageAction: vi.fn() },
    effect: (run: () => () => void) => run(),
  };
  plugin.apply(ctx as never);
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
  const place = (event: Record<string, unknown>) => {
    if (!placer) throw new Error("No placer registered");
    return placer.place(
      {
        agent: ART,
        channel: CH,
        event: { kind: 9, pubkey: OWNER, created_at: 200, ...event },
      },
      new AbortController().signal,
    );
  };
  return { send, place, calls, wakes, state, skip: () => skipCount++ };
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
  it("in a thread: who only, no where questions, woken in that thread", async () => {
    const f = setup();
    await f.send(
      top("3", "and add a test", [
        ["e", EARLIER, "", "root"],
        ["e", EARLIER, "", "reply"],
      ]),
    );
    await vi.waitFor(() => expect(f.wakes).toHaveLength(1));
    expect(WHERE_KEYS.some((key) => key in (f.calls[0]?.questions ?? {}))).toBe(
      false,
    );
    expect(f.wakes[0]).toMatchObject({
      key: ART,
      wake: { channel: CH, root: EARLIER },
    });
    expect(f.wakes[0]?.wake.topLevel).toBeUndefined();
  });

  it("a tagged reply in a thread is never placed and asks Jev nothing", async () => {
    const f = setup();
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
    const f = setup();
    f.state.where = { place: "working" };
    await f.send(top("4", "is it done?"));
    await vi.waitFor(() => expect(f.wakes).toHaveLength(1));
    expect(f.calls).toHaveLength(1);
    expect(whoKeys(f.calls[0])).toEqual(["mbot", "ART"]);
    expect(f.wakes[0]?.wake).toMatchObject({ channel: CH, topLevel: true });
    expect("root" in (f.wakes[0]?.wake ?? {})).toBe(false);
    expect(f.wakes[0]?.wake.text).toContain(
      "placed your reply at the top level",
    );
  });

  it("a shared space threads on the message; a moved-on follow-up goes to the earlier message's thread", async () => {
    const f = setup();
    await f.send(top("5", "who owns the flaky suite?"));
    await vi.waitFor(() => expect(f.wakes).toHaveLength(1));
    expect(f.wakes[0]?.wake).toMatchObject({ root: hex("5") });
    f.state.where = { place: "working", moved_on: 0.95, target: "m1" };
    await f.send(top("6", "back to Pat's note: did the build pass?"));
    await vi.waitFor(() => expect(f.wakes).toHaveLength(2));
    expect(f.wakes[1]?.wake).toMatchObject({ root: EARLIER });
    expect(f.wakes[1]?.wake.text).toContain(`earlier message ${EARLIER}`);
    // Under the stricter moved-on line, it stays at the top level.
    f.state.where = { place: "working", moved_on: 0.85, target: "m1" };
    await f.send(top("7", "back to it"));
    await vi.waitFor(() => expect(f.wakes).toHaveLength(3));
    expect(f.wakes[2]?.wake).toMatchObject({ topLevel: true });
  });

  it("tagged at the top level: where only, placed through the hook, and agents tagged together share one decision", async () => {
    const f = setup();
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
    expect(f.wakes).toHaveLength(0);
    // The untagged flow leaves tagged messages to the hook.
    await f.send(event).catch(() => {});
    expect(f.calls).toHaveLength(1);
  });

  it("an ask for another place keeps the place and adds the note", async () => {
    const f = setup();
    f.state.where = { place: "shared", ask_elsewhere: 0.92 };
    await expect(
      f.place(top("9", "@ART post it in #release-notes", [["p", ART]])),
    ).resolves.toEqual({
      root: hex("9"),
      note: ELSEWHERE_NOTE,
    });
  });

  it("Jev down: no wake for an untagged message, no placement for a tagged one", async () => {
    const f = setup();
    f.state.down = true;
    await expect(
      f.place(top("a", "@ART is it done?", [["p", ART]])),
    ).resolves.toBeUndefined();
    await f.send(top("b", "is it done?"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(f.calls).toHaveLength(2);
    expect(f.wakes).toHaveLength(0);
  });

  it("the same message gets the same destination in both flows", async () => {
    for (const where of [
      { place: "working" },
      { place: "shared" },
      { place: "working", moved_on: 0.95, target: "m1" },
      { place: "shared", ask_top: 0.9 },
      { place: "working", ask_thread: 0.9 },
    ] as const) {
      const f = setup();
      f.state.where = where;
      await f.send(top("c", "the message"));
      await vi.waitFor(() => expect(f.wakes).toHaveLength(1));
      const {
        channel: _channel,
        text: _text,
        ...woken
      } = f.wakes[0]?.wake ?? {};
      const placed = await f.place(top("c", "the message", [["p", ART]]));
      expect(placed, JSON.stringify(where)).toEqual(woken);
    }
  });

  it("ships off by default, and stays off without a decisions provider", () => {
    const bundled = bundledPlugins.find(
      (entry) => entry.manifest.id === manifest.id,
    );
    if (!bundled) throw new Error("Smart routing is not bundled");
    expect(bundled.enabledByDefault).toBe(false);
    expect(bundled.manifest.requires).toEqual(["decisions"]);
    expect(manifest.requires).toEqual(["decisions"]);
    expect(unmetRequirement(bundled.manifest, { decisions: false })).toBe(
      "Needs a decisions provider",
    );
    expect(
      unmetRequirement(bundled.manifest, { decisions: true }),
    ).toBeUndefined();
  });
});
