import { assert, afterEach, expect, it, vi } from "vitest";
import type { EventTemplate } from "nostr-tools";
import type { RelayEvent } from "./events";
import type { LiveCallbacks } from "./live";
import {
  createRelaySession,
  MENTION_HOLD_MS,
  MENTION_UNCHECKED,
} from "./session";
import { PublishBlocked } from "./outbox";
import { retryable } from "./refusal";
import { mentionConformance } from "../../bundled/mentions/mention-rules.conformance";
import {
  flush,
  keypair,
  metadata,
  roster,
  scriptedTransport,
  signed,
} from "./testing";

const viewer = keypair(),
  relay = keypair(),
  honey = keypair(),
  namesake = keypair();
const owners: ReturnType<typeof createRelaySession>[] = [];
function setup(soloMode = false, withLive = false) {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live: LiveCallbacks | undefined;
  let release: (() => void) | undefined;
  let held = false;
  const publish = vi.fn(async (_event: RelayEvent) => {});
  const sign = vi.fn(async (template: EventTemplate, _signal?: AbortSignal) => {
    if (held)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    return signed(viewer, template);
  });
  let currentRoster: RelayEvent | undefined;
  let replicaRoster: RelayEvent | undefined;
  const profileEvents: RelayEvent[] = [];
  const owner = createRelaySession(
    {
      ...wire.transport,
      query: (filters, ...args) => {
        if (
          filters[0]?.authors?.[0] === relay.pubkey &&
          filters[0]?.kinds?.[0] === 39002 &&
          filters[0]?.limit === 1
        )
          return Promise.resolve(
            replicaRoster && filters[0]?.consistency !== "strong"
              ? [replicaRoster]
              : currentRoster
                ? [currentRoster]
                : [],
          );
        if (
          (soloMode || profileEvents.length) &&
          filters.every((filter) => filter.kinds?.every((kind) => kind === 0))
        )
          return Promise.resolve(profileEvents);
        if (soloMode && filters.every((filter) => !!filter.ids))
          return Promise.resolve(publish.mock.calls.map(([event]) => event));
        return wire.transport.query(filters, ...args);
      },
      writer: { sign, publish },
      ...(withLive
        ? {
            subscribe(callbacks: LiveCallbacks) {
              live = callbacks;
              return { update() {}, retry() {}, dispose() {} };
            },
          }
        : {}),
    },
    {
      outboxStorage: { load: () => [], save: () => {} },
    },
  );
  owners.push(owner);
  async function members(
    keys: readonly string[] = [viewer.pubkey, honey.pubkey, namesake.pubkey],
    time = 1700000000,
    author = relay,
    meta?: RelayEvent,
    rosterEvent?: RelayEvent,
  ) {
    const read = owner.session.read([
      { kinds: [39002, 39000], "#d": ["c"], limit: 10 },
    ]);
    let pending = wire.next();
    while (!pending.filters.some((filter) => filter.kinds?.includes(39002))) {
      expect(
        pending.filters.every((filter) =>
          filter.kinds?.every((kind) => kind === 0),
        ),
      ).toBe(true);
      pending.respond([]);
      await tick();
      pending = wire.next();
    }
    currentRoster = rosterEvent ?? roster(author, "c", keys, time);
    pending.respond([
      currentRoster,
      soloMode
        ? signed(relay, {
            kind: 39000,
            content: JSON.stringify({ name: "Work" }),
            tags: [
              ["d", "c"],
              ["t", "stream"],
              ["private"],
              ["t", "buzz.solo"],
            ],
          })
        : (meta ?? metadata(relay, "c", "General")),
    ]);
    await read;
  }
  return {
    ...wire,
    ...owner,
    members,
    live: () => {
      assert(live, "setup(_, true) subscribes a live stream");
      return live;
    },
    setRoster: (keys: readonly string[]) => {
      currentRoster = roster(relay, "c", keys, 1700000001);
    },
    lagReplica: () => {
      replicaRoster = currentRoster;
    },
    async agentProfile(key: typeof honey) {
      profileEvents.push(
        signed(key, {
          kind: 0,
          content: JSON.stringify({ name: "Honey" }),
          tags: [["auth", viewer.pubkey, "", "a".repeat(128)]],
        }),
      );
      await owner.session.profiles.ensure([key.pubkey]);
    },
    sign,
    publish,
    hold: () => {
      held = true;
    },
    release: () => release?.(),
  };
}
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
  vi.useRealTimers();
});
/** Lets queued work run; `flush` waits on a timer that fake timers hold. */
async function tick() {
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
  else await flush();
}

it.each([false, true])(
  "publishes exact selected keys through real session/outbox for reply=%s, deduplicating keys not names",
  async (reply) => {
    const h = setup();
    await h.members();
    const keys = [honey.pubkey, honey.pubkey, namesake.pubkey];
    const root = "a".repeat(64);
    const id = reply
      ? h.session.messages.reply("c", root, "@Honey @Honey help", keys)
      : h.session.messages.send("c", "@Honey @Honey help", keys);
    await flush();
    const event = h.publish.mock.calls[0]?.[0];
    expect(event?.id).toBe(id);
    expect(event?.tags.filter(([tag]) => tag !== "client-id")).toEqual([
      ["h", "c"],
      ...(reply ? [["e", root, "", "reply"]] : []),
      ["p", honey.pubkey],
      ["p", namesake.pubkey],
      ["ms", expect.stringMatching(/^(0|[1-9]\d{0,2})$/)],
    ]);
    expect(h.sign).toHaveBeenCalledTimes(1);
    // Actual publication acknowledgement is not execution completion.
    expect(h.session.outbox?.snapshot()[0]?.delivery).toBe("accepted");
  },
);
it("mentions a just-added member despite an older replica roster", async () => {
  const h = setup();
  await h.members([viewer.pubkey]);
  h.lagReplica();
  await h.members([viewer.pubkey, honey.pubkey], 1700000001);
  const id = h.session.messages.send("c", "@Honey help", [honey.pubkey]);
  await vi.waitFor(() => expect(h.publish).toHaveBeenCalledOnce());
  expect(h.publish.mock.calls[0]?.[0].id).toBe(id);
  expect(h.publish.mock.calls[0]?.[0].tags).toContainEqual(["p", honey.pubkey]);
});

it("typed names create no recipient tags; unconfirmed or forged membership cannot grant mention permission", async () => {
  const h = setup();
  expect(() => h.session.messages.send("c", "@Honey", [honey.pubkey])).toThrow(
    /can’t check who’s in this channel/,
  );
  await h.members(undefined, 1700000000, namesake);
  expect(() => h.session.messages.send("c", "@Honey", [honey.pubkey])).toThrow(
    "You don’t have write access to this conversation.",
  );
  expect(h.sign).not.toHaveBeenCalled();
  expect(h.publish).not.toHaveBeenCalled();
  await h.members();
  expect(() => h.session.messages.send("c", "@Honey", ["not-a-key"])).toThrow(
    /valid/,
  );
  h.session.messages.send("c", "@Honey");
  await flush();
  expect(
    h.publish.mock.calls[0]?.[0].tags.filter(([tag]) => tag !== "client-id"),
  ).toEqual([
    ["h", "c"],
    ["ms", expect.stringMatching(/^(0|[1-9]\d{0,2})$/)],
  ]);
});
it("publishes roster changes even when channel names/previews are unchanged and rejects a removed recipient", async () => {
  const h = setup();
  await h.members();
  const before = h.session.channels.list();
  await h.members([viewer.pubkey, namesake.pubkey], 1700000001);
  expect(h.session.channels.list()).not.toBe(before);
  expect(h.session.channels.list().channels[0]?.members).toEqual(
    [viewer.pubkey, namesake.pubkey].sort(),
  );
  expect(() => h.session.messages.send("c", "@Honey", [honey.pubkey])).toThrow(
    "Someone you mentioned isn’t in this channel anymore. Remove the mention to send.",
  );
  expect(() =>
    h.session.messages.reply("c", "a".repeat(64), "@Honey", [honey.pubkey]),
  ).toThrow(/isn’t in this channel anymore/);
  expect(h.sign).not.toHaveBeenCalled();
});
it("membership loss while signing blocks publication; retry checks again without silently replacing the recipient", async () => {
  const h = setup();
  await h.members();
  h.hold();
  const id = h.session.messages.send("c", "@Honey", [honey.pubkey]);
  await flush();
  expect(h.sign).toHaveBeenCalledTimes(1);
  await h.members([viewer.pubkey, namesake.pubkey], 1700000001);
  h.release();
  await flush();
  expect(h.publish).not.toHaveBeenCalled();
  // Read where the message can't be edited, so its words don't ask for that.
  expect(h.session.outbox?.snapshot()[0]).toMatchObject({
    delivery: "failed",
    unsent: "blocked",
    error: "Someone you mentioned isn’t in this channel anymore.",
  });
  expect(h.session.outbox?.snapshot()[0]?.refused).toBeUndefined();
  h.session.messages.retry(id);
  await flush();
  expect(h.publish).not.toHaveBeenCalled();
  await h.members(undefined, 1700000002);
  h.session.messages.retry(id);
  await flush();
  expect(h.publish.mock.calls[0]?.[0].tags).toContainEqual(["p", honey.pubkey]);
});
it("raw outbox writes cannot bypass the pre-sign membership check", async () => {
  const h = setup();
  await h.members([viewer.pubkey]);
  assert.exists(h.session.outbox);
  h.session.outbox.send({
    kind: 9,
    content: "@Honey",
    tags: [
      ["h", "c"],
      ["p", honey.pubkey],
    ],
  });
  await flush();
  expect(h.sign).not.toHaveBeenCalled();
  expect(h.publish).not.toHaveBeenCalled();
  // Kept on the item, read where the message can't be edited.
  expect(h.session.outbox?.snapshot()[0]).toMatchObject({
    delivery: "failed",
    unsent: "blocked",
    error: "Someone you mentioned isn’t in this channel anymore.",
  });
});
it("disposal during signing fences publication to a retired session", async () => {
  const h = setup();
  await h.members();
  h.hold();
  h.session.messages.send("c", "@Honey", [honey.pubkey]);
  await flush();
  h.dispose();
  h.release();
  await flush();
  expect(h.publish).not.toHaveBeenCalled();
});

it.each([false, true])(
  "preserves an independent caller's explicit Solo chat recipients, reply=%s",
  async (reply) => {
    const h = setup(true);
    await h.members([viewer.pubkey, honey.pubkey]);
    await h.agentProfile(honey);
    const send = (mentions: readonly string[]) =>
      reply
        ? h.session.messages.reply("c", "a".repeat(64), "Keep going", mentions)
        : h.session.messages.send("c", "Keep going", mentions);
    send([]);
    await flush();
    expect(
      h.publish.mock.calls[0]?.[0].tags.filter(([name]) => name === "p"),
    ).toEqual([]);
    send([honey.pubkey]);
    await flush();
    expect(
      h.publish.mock.calls.at(-1)?.[0].tags.filter(([name]) => name === "p"),
    ).toEqual([["p", honey.pubkey]]);
    expect(h.publish).toHaveBeenCalledTimes(2);
  },
);

it.each([true])(
  "publishes nonmember references without addressed tags, reply=%s",
  async (reply) => {
    const h = setup();
    await h.members([viewer.pubkey, honey.pubkey]);
    const root = "f".repeat(64);
    if (reply)
      h.session.messages.reply(
        "c",
        root,
        "@Honey and @Outside",
        [honey.pubkey],
        [],
        undefined,
        [namesake.pubkey],
      );
    else
      h.session.messages.send(
        "c",
        "@Honey and @Outside",
        [honey.pubkey],
        [],
        undefined,
        [namesake.pubkey],
      );
    await flush();
    const event = h.publish.mock.calls[0]?.[0];
    expect(event?.tags).toContainEqual(["p", honey.pubkey]);
    expect(event?.tags).toContainEqual(["mention", namesake.pubkey]);
    expect(event?.tags).not.toContainEqual(["p", namesake.pubkey]);
    expect(() =>
      h.session.messages.send("c", "@Outside", [namesake.pubkey]),
    ).toThrow(/isn’t in this channel anymore/);
    expect(() =>
      h.session.messages.send("c", "@Outside", [], [], undefined, ["invalid"]),
    ).toThrow(/valid mention references/);
  },
);

it.each([false, true])(
  "asks a mentioned agent for a model and effort, and only a mentioned one, reply=%s",
  async (reply) => {
    const h = setup();
    await h.members([viewer.pubkey, honey.pubkey]);
    const root = "f".repeat(64);
    const post = (
      picks: Record<string, { model?: string; effort?: string }>,
    ) =>
      reply
        ? h.session.messages.reply(
            "c",
            root,
            "@Honey",
            [honey.pubkey],
            [],
            undefined,
            [],
            picks,
          )
        : h.session.messages.send(
            "c",
            "@Honey",
            [honey.pubkey],
            [],
            undefined,
            [],
            picks,
          );
    post({
      [honey.pubkey]: { model: "claude-fable-5-1[1m]", effort: "xhigh" },
    });
    await flush();
    const tags = h.publish.mock.calls[0]?.[0]?.tags;
    expect(tags).toContainEqual([
      "model",
      honey.pubkey,
      "claude-fable-5-1[1m]",
    ]);
    expect(tags).toContainEqual(["effort", honey.pubkey, "xhigh"]);
    // goose catalogs name models by their provider: `openrouter`'s `vendor/…`.
    post({ [honey.pubkey]: { model: "anthropic/claude-sonnet-5-5" } });
    await flush();
    expect(h.publish.mock.calls[1]?.[0]?.tags).toContainEqual([
      "model",
      honey.pubkey,
      "anthropic/claude-sonnet-5-5",
    ]);
    expect(() => post({ [namesake.pubkey]: { effort: "high" } })).toThrow(
      /addressed agent/,
    );
    expect(() => post({ [honey.pubkey]: { effort: "High Effort" } })).toThrow(
      /addressed agent/,
    );
    expect(() => post({ [honey.pubkey]: { model: "two words" } })).toThrow(
      /addressed agent/,
    );
  },
);

it("asks a one-to-one DM's other member for a model and effort without a mention", async () => {
  const h = setup();
  const read = h.session.read([
    { kinds: [39002, 39000], "#d": ["c"], limit: 10 },
  ]);
  let pending = h.next();
  while (!pending.filters.some((filter) => filter.kinds?.includes(39002))) {
    pending.respond([]);
    await flush();
    pending = h.next();
  }
  pending.respond([
    roster(relay, "c", [viewer.pubkey, honey.pubkey]),
    metadata(relay, "c", "Honey", 1700000000, [["t", "dm"], ["private"]]),
  ]);
  await read;
  h.session.messages.send("c", "think hard", [], [], undefined, [], {
    [honey.pubkey]: { effort: "high" },
  });
  await flush();
  const tags = h.publish.mock.calls[0]?.[0]?.tags;
  expect(tags).toContainEqual(["effort", honey.pubkey, "high"]);
  expect(tags).not.toContainEqual(["p", honey.pubkey]);
  expect(() =>
    h.session.messages.send("c", "think hard", [], [], undefined, [], {
      [namesake.pubkey]: { effort: "high" },
    }),
  ).toThrow(/addressed agent/);
});

it("queues a plain one-to-one DM message to an agent while the live stream reconnects, and checks membership fresh before publishing", async () => {
  const h = setup(false, true);
  h.live().state({ status: "connected", routes: [] });
  await h.members(
    [viewer.pubkey, honey.pubkey],
    1700000000,
    relay,
    metadata(relay, "c", "Honey", 1700000000, [["t", "dm"], ["private"]]),
  );
  await h.agentProfile(honey);
  h.live().state({ status: "retrying", routes: [] });
  // The agent partner's implicit tag no longer blocks queueing.
  const id = h.session.messages.send("c", "hello");
  await flush();
  const event = h.publish.mock.calls[0]?.[0];
  expect(event?.id).toBe(id);
  expect(event?.tags).toContainEqual(["p", honey.pubkey]);
  // Publication still reads the roster fresh: a partner who has left is refused.
  h.setRoster([viewer.pubkey]);
  const refused = h.session.messages.send("c", "still there?");
  await flush();
  expect(h.publish).toHaveBeenCalledTimes(1);
  expect(
    h.session.outbox?.snapshot().find((item) => item.event.id === refused),
  ).toMatchObject({
    delivery: "failed",
    // The fresh roster no longer lists them: sending again can't work.
    unsent: "blocked",
    error: "Honey isn’t in this conversation anymore.",
  });
  expect(
    h.session.outbox?.snapshot().find((item) => item.event.id === refused)
      ?.refused,
  ).toBeUndefined();
});

it("says a DM's partner who left isn't in the conversation, for each queued message and a write after the list caught up", async () => {
  const h = setup();
  await h.members(
    [viewer.pubkey, honey.pubkey],
    1700000000,
    relay,
    metadata(relay, "c", "Honey", 1700000000, [["t", "dm"], ["private"]]),
  );
  await h.agentProfile(honey);
  // Honey has left; this device's member list doesn't show it yet, so both
  // messages address her.
  h.setRoster([viewer.pubkey]);
  const ids = [
    h.session.messages.send("c", "one"),
    h.session.messages.send("c", "two"),
  ];
  const item = (id: string) =>
    h.session.outbox?.snapshot().find((entry) => entry.event.id === id);
  await vi.waitFor(() =>
    expect(ids.map((id) => item(id)?.delivery)).toEqual(["failed", "failed"]),
  );
  // The first check updates the member list, which no longer has a partner;
  // the second still says conversation.
  for (const id of ids)
    expect(item(id)).toMatchObject({
      unsent: "blocked",
      error: "Honey isn’t in this conversation anymore.",
    });
  // The check before signing reads the updated list.
  assert.exists(h.session.outbox);
  const raw = h.session.outbox.send({
    kind: 9,
    content: "three",
    tags: [
      ["h", "c"],
      ["p", honey.pubkey],
    ],
  });
  await vi.waitFor(() => expect(item(raw)?.delivery).toBe("failed"));
  expect(item(raw)).toMatchObject({
    unsent: "blocked",
    error: "Honey isn’t in this conversation anymore.",
  });
  expect(h.publish).not.toHaveBeenCalled();
});

it("queues a mention while live updates reconnect and checks it once they are back", async () => {
  const h = setup(false, true);
  h.live().state({ status: "connected", routes: [] });
  await h.members([viewer.pubkey, honey.pubkey, namesake.pubkey]);
  h.live().state({ status: "retrying", routes: [] });
  const id = h.session.messages.send("c", "@Honey", [honey.pubkey]);
  // A plain message with no mention isn't held behind it.
  const plain = h.session.messages.send("c", "hello");
  await flush();
  expect(h.publish.mock.calls.map(([event]) => event.id)).toEqual([plain]);
  expect(
    h.session.outbox?.snapshot().find((item) => item.event.id === id)?.delivery,
  ).toBe("sending");
  h.live().state({ status: "connected", routes: [] });
  await vi.waitFor(() =>
    expect(h.publish.mock.calls.map(([event]) => event.id)).toContain(id),
  );
  expect(
    h.publish.mock.calls.find(([event]) => event.id === id)?.[0].tags,
  ).toContainEqual(["p", honey.pubkey]);
});

it("keeps a queued mention, retryable, when live updates stop coming back", async () => {
  const h = setup(false, true);
  h.live().state({ status: "connected", routes: [] });
  await h.members([viewer.pubkey, honey.pubkey]);
  h.live().state({ status: "retrying", routes: [] });
  const id = h.session.messages.send("c", "@Honey", [honey.pubkey]);
  await flush();
  h.live().state({ status: "error", routes: [], error: "restricted: no" });
  await vi.waitFor(() =>
    expect(
      h.session.outbox?.snapshot().find((item) => item.event.id === id),
    ).toMatchObject({ delivery: "failed", error: MENTION_UNCHECKED }),
  );
  expect(
    h.session.outbox?.snapshot().find((item) => item.event.id === id)?.refused,
  ).toBeUndefined();
  expect(h.publish).not.toHaveBeenCalled();
  // Without live updates coming back, a new mention can't wait for them.
  expect(() => h.session.messages.send("c", "@Honey", [honey.pubkey])).toThrow(
    MENTION_UNCHECKED,
  );
});

/** What a mention hold registers: a live updates listener, a channel list
 * listener, and an abort handler on its delivery attempt's signal (the one
 * signing was given). Counts are against the moment tracking began. */
function trackHold(h: ReturnType<typeof setup>) {
  const listeners = () => {
    const { liveListeners, listListeners } = h.diagnostics();
    return { live: liveListeners, list: listListeners };
  };
  const baseline = listeners();
  const added = vi.spyOn(EventTarget.prototype, "addEventListener");
  const removed = vi.spyOn(EventTarget.prototype, "removeEventListener");
  const holdHandlers = (spy: typeof added | typeof removed) => {
    const signal = h.sign.mock.calls[0]?.[1];
    return spy.mock.calls.filter(
      ([type, listener], index) =>
        !!signal &&
        spy.mock.contexts[index] === signal &&
        type === "abort" &&
        typeof listener === "function" &&
        listener.name === "abort",
    ).length;
  };
  return {
    registered: () => {
      const now = listeners();
      return {
        live: now.live - baseline.live,
        list: now.list - baseline.list,
        abort: holdHandlers(added) - holdHandlers(removed),
      };
    },
    restore() {
      added.mockRestore();
      removed.mockRestore();
    },
  };
}
const held = { live: 1, list: 1, abort: 1 },
  released = { live: 0, list: 0, abort: 0 };
/** A mention to Honey held while live updates reconnect, under fake timers. */
async function holdMention(
  h: ReturnType<typeof setup>,
  keys?: readonly string[],
  meta?: RelayEvent,
) {
  h.live().state({ status: "connected", routes: [] });
  await h.members(keys, 1700000000, relay, meta);
  h.live().state({ status: "retrying", routes: [] });
  vi.useFakeTimers();
  const hold = trackHold(h);
  const id = h.session.messages.send("c", "@Honey", [honey.pubkey]);
  await tick();
  const item = () =>
    h.session.outbox?.snapshot().find((entry) => entry.event.id === id);
  expect(item()?.delivery).toBe("sending");
  expect(h.publish).not.toHaveBeenCalled();
  expect(hold.registered()).toEqual(held);
  return { id, item, hold };
}

it("fails a held mention as not sent, with Retry, once MENTION_HOLD_MS passes, and leaves nothing registered", async () => {
  const h = setup(false, true);
  const { item, hold } = await holdMention(h);
  try {
    await vi.advanceTimersByTimeAsync(MENTION_HOLD_MS - 1);
    expect(item()?.delivery).toBe("sending");
    await vi.advanceTimersByTimeAsync(1);
    const failed = item();
    assert.exists(failed);
    expect(failed).toMatchObject({
      delivery: "failed",
      error: MENTION_UNCHECKED,
    });
    expect(failed.refused).toBeUndefined();
    expect(failed.unsent).not.toBe("blocked");
    expect(retryable(failed)).toBe(true);
    expect(h.publish).not.toHaveBeenCalled();
    expect(hold.registered()).toEqual(released);
  } finally {
    hold.restore();
  }
});

it("sends a held mention once live updates are back, and leaves nothing registered", async () => {
  const h = setup(false, true);
  const { id, hold } = await holdMention(h);
  try {
    h.live().state({ status: "connected", routes: [] });
    await tick();
    expect(h.publish.mock.calls.map(([event]) => event.id)).toEqual([id]);
    expect(hold.registered()).toEqual(released);
  } finally {
    hold.restore();
  }
});

it("ends a held mention whose echo arrives, and leaves nothing registered", async () => {
  const h = setup(false, true);
  const { item, hold } = await holdMention(h);
  try {
    const event = await h.sign.mock.results[0]?.value;
    assert.exists(event);
    // The community already has it: the attempt is aborted, not published.
    h.live().receive([event]);
    await tick();
    expect(h.publish).not.toHaveBeenCalled();
    expect(item()?.delivery ?? "seen").toBe("seen");
    expect(hold.registered()).toEqual(released);
  } finally {
    hold.restore();
  }
});

it("releases a held mention in a DM once its member list shows the mention is of the other person", async () => {
  const h = setup(false, true);
  const dm = metadata(relay, "c", "Honey", 1700000000, [
    ["t", "dm"],
    ["private"],
  ]);
  const { id, hold } = await holdMention(
    h,
    [viewer.pubkey, honey.pubkey, namesake.pubkey],
    dm,
  );
  try {
    // Every message in a one-to-one DM addresses its other person, so live
    // updates aren't needed once the member list says it is one.
    await h.members([viewer.pubkey, honey.pubkey], 1700000001, relay, dm);
    await tick();
    expect(h.publish.mock.calls.map(([event]) => event.id)).toEqual([id]);
    expect(hold.registered()).toEqual(released);
  } finally {
    hold.restore();
  }
});

it.each([
  {
    channel: "archived",
    sentence: "This channel is archived.",
    meta: metadata(relay, "c", "General", 1700000001, [["archived", "true"]]),
    changed: undefined,
    // The mention check's own answer.
    atSend: { name: "MentionRefused", message: "This channel is archived." },
  },
  {
    channel: "read-only",
    sentence: "You have read-only access to this channel.",
    meta: undefined,
    changed: signed(relay, {
      kind: 39002,
      content: "",
      created_at: 1700000001,
      tags: [
        ["d", "c"],
        ["p", viewer.pubkey, "", "guest"],
        ["p", honey.pubkey],
        ["p", namesake.pubkey],
      ],
    }),
    // Write access is checked before mentions, at send and at publication,
    // so a guest never reaches the mention check's read-only answer.
    atSend: { message: "You don’t have write access to this conversation." },
  },
])(
  "refuses a mention in a $channel channel rather than holding it, and blocks one that became $channel while signing",
  async ({ sentence, meta, changed, atSend }) => {
    const h = setup(false, true);
    h.live().state({ status: "connected", routes: [] });
    await h.members();
    h.hold();
    const id = h.session.messages.send("c", "@Honey", [honey.pubkey]);
    await flush();
    expect(h.sign).toHaveBeenCalledTimes(1);
    await h.members(undefined, 1700000001, relay, meta, changed);
    h.release();
    await flush();
    expect(h.publish).not.toHaveBeenCalled();
    // Buzz checked it and can't send it as written: no Retry, plain words.
    const blocked = h.session.outbox
      ?.snapshot()
      .find((entry) => entry.event.id === id);
    assert.exists(blocked);
    expect(blocked).toMatchObject({
      delivery: "failed",
      unsent: "blocked",
      error: sentence,
    });
    expect(blocked.refused).toBeUndefined();
    expect(retryable(blocked)).toBe(false);
    // While live updates reconnect, the known answer still comes first:
    // a new mention is refused, not held.
    h.live().state({ status: "retrying", routes: [] });
    const sent = h.session.outbox?.snapshot().length;
    let thrown: unknown;
    try {
      h.session.messages.send("c", "@Honey", [honey.pubkey]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject(atSend);
    if (atSend.name) expect(thrown).toBeInstanceOf(PublishBlocked);
    expect(h.session.outbox?.snapshot().length).toBe(sent);
  },
);

it.each(mentionConformance.tags.write)(
  "conforms to the portable mention tag writing contract: $name",
  async (fixture) => {
    const h = setup();
    // The sender must be a member; fixtures list only the other members.
    await h.members([viewer.pubkey, ...fixture.members]);
    const send = () =>
      h.session.messages.send(
        "c",
        "@Someone",
        fixture.recipients,
        [],
        undefined,
        fixture.references,
      );
    const expected = fixture.expected;
    if ("error" in expected) {
      expect(send).toThrow(
        {
          not_member: /isn’t in this channel anymore/,
          invalid: /valid mention/,
          too_many: /at most 32/,
        }[expected.error],
      );
      return;
    }
    send();
    await flush();
    const event = h.publish.mock.calls[0]?.[0];
    expect(
      event?.tags.filter(([name]) => name === "p" || name === "mention"),
    ).toEqual(expected.tags);
  },
);
