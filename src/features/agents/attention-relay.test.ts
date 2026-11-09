import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { describe, expect, it } from "vitest";
import type { RelayEvent } from "../relay/events";
import type { AttentionValue } from "./attention";
import { AttentionError } from "./attention-objects";
import {
  ATTENTION_LABEL,
  ATTENTION_TYPE,
  agentDelivery,
  attentionChange,
  attentionD,
  attentionSet,
  emptySet,
  ensureChannel,
  HEAD_LIMIT,
  mirrored,
  ownerSender,
  publishChange,
  readOnce,
  revision,
  type AttentionSet,
  type Revision,
  type Sent,
} from "./attention-relay";
import type { SnapshotRead } from "./agent-config-artifacts";
import type { ArtifactSyncSnapshot } from "../relay/artifact-sync";
import { PublishRejected } from "../relay/outbox";
import { setAttention, type AgentRecord } from "./store";

const key = generateSecretKey();
const author = getPublicKey(key);
const channel = "9b353519-f4fe-4757-aef4-bec6cc0ae54c";
const interest: AttentionValue = { type: "interest", instructions: "Help" };
const timer: AttentionValue = {
  type: "timer",
  interest_id: "x",
  prompt: "tick",
  enabled: true,
  interval_secs: 3600,
  armed_at: 100,
  max_occurrences: 3,
  expires_at: null,
};
const sign = (event: Revision, created_at = 500) =>
  finalizeEvent({ ...event, created_at }, key) as RelayEvent;
const tag = (event: RelayEvent, name: string) =>
  event.tags.find((t) => t[0] === name)?.[1];
async function record(slug: string, value: AttentionValue, created_at = 500) {
  return sign(
    revision({
      channel,
      d: await attentionD(channel, slug),
      slug,
      op: "create",
      value,
    }),
    created_at,
  );
}
const blank: AgentRecord = { pubkey: author, attention: {}, config: undefined };

/** A relay holding one channel's revisions, as NIP-AR decides them. */
function relay() {
  const heads = new Map<string, RelayEvent>();
  const sent: RelayEvent[] = [];
  let answer: ((event: RelayEvent) => Sent | undefined) | undefined;
  const accept = (event: RelayEvent): Sent => {
    sent.push(event);
    const head = heads.get(tag(event, "d") ?? "");
    const op = tag(event, "op");
    const prev = tag(event, "prev");
    if (op === "create" ? !!head : prev !== head?.id)
      return {
        status: "refused",
        refusal: "conflict",
        message: "conflict: stale",
      };
    if (op === "restore" && tag(head as RelayEvent, "op") !== "delete")
      return {
        status: "refused",
        refusal: "invalid",
        message: "invalid: live",
      };
    heads.set(tag(event, "d") ?? "", event);
    return { status: "accepted", id: event.id };
  };
  const send = async (event: Revision) => {
    const signed = sign(event, 600 + sent.length);
    return answer?.(signed) ?? accept(signed);
  };
  const read: SnapshotRead = async ([filter]) => {
    const d = filter?.["#d"]?.[0];
    const head = d ? heads.get(d) : undefined;
    return head ? [head] : [];
  };
  const set = () =>
    attentionSet(
      channel,
      [...heads.values()].filter((event) => tag(event, "op") !== "delete"),
    );
  return {
    heads,
    sent,
    io: { send, read },
    set,
    accept,
    answer(next: typeof answer) {
      answer = next;
    },
  };
}

describe("attention records", () => {
  it("derives NIP-AR's standard d from channel, type and slug", async () => {
    // From Python: sha256("nip-ar-artifact\0" h "\0" type "\0" key), UUIDv8 bits.
    expect(await attentionD(channel, "watch/project-messages")).toBe(
      "d1310b35-ee53-8192-964a-eb91d08e202a",
    );
  });

  it("encodes the v1 content with title = slug and no title on delete", async () => {
    const d = await attentionD(channel, "interest/x");
    const created = revision({
      channel,
      d,
      slug: "interest/x",
      op: "create",
      value: interest,
    });
    expect(JSON.parse(created.content)).toEqual({
      schema: "agent-attention/v1",
      slug: "interest/x",
      value: interest,
    });
    expect(created.tags).toEqual([
      ["ar", "1"],
      ["d", d],
      ["h", channel],
      ["type", ATTENTION_TYPE],
      ["title", "interest/x"],
      ["op", "create"],
    ]);
    const deleted = revision({
      channel,
      d,
      slug: "interest/x",
      op: "delete",
      prev: "a".repeat(64),
    });
    expect(deleted.content).toBe("");
    expect(deleted.tags.some(([name]) => name === "title")).toBe(false);
  });

  it("applies valid records with their revision time and skips the rest", async () => {
    const good = await record("interest/x", interest, 777);
    const wrongD = sign(
      revision({
        channel,
        d: await attentionD(channel, "interest/y"),
        slug: "interest/x",
        op: "create",
        value: interest,
      }),
    );
    const unknown = sign({
      ...revision({
        channel,
        d: await attentionD(channel, "interest/z"),
        slug: "interest/z",
        op: "create",
        value: interest,
      }),
      content: JSON.stringify({
        schema: "agent-attention/v2",
        slug: "interest/z",
        value: interest,
      }),
    });
    const extra = sign({
      ...revision({
        channel,
        d: await attentionD(channel, "interest/w"),
        slug: "interest/w",
        op: "create",
        value: interest,
      }),
      content: JSON.stringify({
        schema: "agent-attention/v1",
        slug: "interest/w",
        value: interest,
        more: 1,
      }),
    });
    const invalid = await record("watch/bad", {
      ...timer,
      interval_secs: 0,
    } as AttentionValue);
    const set = await attentionSet(channel, [
      good,
      wrongD,
      unknown,
      extra,
      invalid,
    ]);
    expect(set.attention).toEqual({
      "interest/x": { slug: "interest/x", value: interest, modifiedAt: 777 },
    });
    const wrong = `invalid/${tag(wrongD, "d")}`;
    expect(Object.keys(set.skipped).sort()).toEqual(
      [wrong, "interest/w", "interest/z", "watch/bad"].sort(),
    );
    expect(set.skipped[wrong]?.problem).toBe(
      "Record identity does not match its slug",
    );
    expect(set.skipped["interest/z"]?.problem).toMatch(/Unknown schema/);
    expect(set.count).toBe(5);
    expect(set.heads["interest/x"]).toEqual({ id: good.id, d: tag(good, "d") });
  });

  it("applies the first 100 of a group by slug and skips the others", async () => {
    const events = await Promise.all(
      Array.from({ length: 102 }, (_, i) =>
        record(`interest/i${String(i).padStart(3, "0")}`, interest),
      ),
    );
    const set = await attentionSet(channel, events.reverse());
    expect(Object.keys(set.attention)).toHaveLength(100);
    expect(Object.keys(set.skipped).sort()).toEqual([
      "interest/i100",
      "interest/i101",
    ]);
  });
});

describe("the mirror", () => {
  const withSet = (attention: AttentionSet["attention"]): AttentionSet => ({
    ...emptySet(channel),
    attention,
  });

  it("keeps an unchanged object, so work in flight for it goes on", () => {
    const base = setAttention(blank, "interest/x", interest, 100);
    const next = mirrored(
      base,
      withSet({
        "interest/x": {
          slug: "interest/x",
          value: { ...interest },
          modifiedAt: 900,
        },
      }),
    );
    expect(next).toBe(base);
  });

  it("applies a remote timer edit with the local edit rules", () => {
    let base = setAttention(blank, "interest/x", interest, 100);
    base = setAttention(base, "watch/t", timer, 100);
    const state = { armedAt: 100, nextDue: 3700, used: 2 };
    base = { ...base, timers: { "watch/t": state } };
    // Same armed_at: the run state continues and the new interval applies later.
    const edited = mirrored(
      base,
      withSet({
        "interest/x": base.attention["interest/x"] as never,
        "watch/t": {
          slug: "watch/t",
          value: { ...timer, interval_secs: 7200 },
          modifiedAt: 900,
        },
      }),
      1000,
    );
    expect(edited.timers?.["watch/t"]).toEqual(state);
    expect(edited.attention["watch/t"]?.modifiedAt).toBe(900);
    // A rearm keeps the occurrences used and sets a new deadline.
    const rearmed = mirrored(
      edited,
      withSet({
        "interest/x": base.attention["interest/x"] as never,
        "watch/t": {
          slug: "watch/t",
          value: { ...timer, interval_secs: 7200, armed_at: 2000 },
          modifiedAt: 2000,
        },
      }),
      2000,
    );
    expect(rearmed.timers?.["watch/t"]).toMatchObject({
      used: 2,
      nextDue: 9200,
    });
    // Removal takes its run state with it.
    const removed = mirrored(
      rearmed,
      withSet({ "interest/x": base.attention["interest/x"] as never }),
    );
    expect(removed.attention["watch/t"]).toBeUndefined();
    expect(removed.timers?.["watch/t"]).toBeUndefined();
  });

  it("finds the one object an edit changes", () => {
    const base = setAttention(blank, "interest/x", interest, 100);
    expect(attentionChange(base, base)).toBeUndefined();
    expect(
      attentionChange(base, setAttention(base, "interest/x", null)),
    ).toEqual({ slug: "interest/x", value: null });
    const two = setAttention(
      setAttention(blank, "interest/y", interest),
      "interest/z",
      interest,
    );
    expect(() => attentionChange(base, two)).toThrow(
      "one Interest or watch at a time",
    );
    const skipped = {
      ...blank,
      skipped: {
        "watch/s": { slug: "watch/s", value: 1, modifiedAt: 1, problem: "bad" },
      },
    };
    expect(
      attentionChange(skipped, setAttention(skipped, "watch/s", null)),
    ).toEqual({ slug: "watch/s", value: null });
  });
});

describe("one writer revision", () => {
  it("creates, updates and deletes with prev from the read", async () => {
    const r = relay();
    const created = await publishChange(r.io, await r.set(), {
      slug: "interest/x",
      value: interest,
    });
    expect(tag(r.sent[0] as RelayEvent, "op")).toBe("create");
    const updated = await publishChange(r.io, await r.set(), {
      slug: "interest/x",
      value: { ...interest, instructions: "More" },
    });
    expect(tag(r.sent[1] as RelayEvent, "prev")).toBe(created?.id);
    expect(
      await publishChange(r.io, await r.set(), {
        slug: "interest/x",
        value: null,
      }),
    ).toBeNull();
    expect(tag(r.sent[2] as RelayEvent, "op")).toBe("delete");
    expect(tag(r.sent[2] as RelayEvent, "prev")).toBe(updated?.id);
  });

  it("fails a stale write with conflict and does not retry", async () => {
    const r = relay();
    await publishChange(r.io, await r.set(), {
      slug: "interest/x",
      value: interest,
    });
    const stale = await r.set();
    await publishChange(r.io, await r.set(), {
      slug: "interest/x",
      value: { ...interest, instructions: "Other writer" },
    });
    const sent = r.sent.length;
    const write = publishChange(r.io, stale, {
      slug: "interest/x",
      value: { ...interest, instructions: "Mine" },
    });
    await expect(write).rejects.toMatchObject({ code: "conflict" });
    expect(r.sent.length).toBe(sent + 1);
  });

  it("restores a deleted slug, accepts the same live value, and refuses another", async () => {
    const r = relay();
    await publishChange(r.io, await r.set(), {
      slug: "interest/x",
      value: interest,
    });
    await publishChange(r.io, await r.set(), {
      slug: "interest/x",
      value: null,
    });
    // An empty read: the add finds the deletion and restores it.
    await publishChange(r.io, emptySet(channel), {
      slug: "interest/x",
      value: interest,
    });
    expect(r.sent.map((event) => tag(event, "op"))).toEqual([
      "create",
      "delete",
      "create",
      "restore",
    ]);
    // Two identical adds: the second finds the same live value.
    await expect(
      publishChange(r.io, emptySet(channel), {
        slug: "interest/x",
        value: interest,
      }),
    ).resolves.toMatchObject({ d: await attentionD(channel, "interest/x") });
    await expect(
      publishChange(r.io, emptySet(channel), {
        slug: "interest/x",
        value: { ...interest, instructions: "Else" },
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringContaining("interest/x already exists"),
    });
  });

  it("reports a slug whose head was retired", async () => {
    const r = relay();
    r.answer(() => ({
      status: "refused",
      refusal: "conflict",
      message: "conflict: taken",
    }));
    await expect(
      publishChange(r.io, emptySet(channel), {
        slug: "interest/x",
        value: interest,
      }),
    ).rejects.toMatchObject({ code: "invalid-operation" });
  });

  it("settles a lost OK from the head", async () => {
    const r = relay();
    // Accepted, but the answer was lost: the head names what was signed.
    r.answer((event) => {
      r.answer(undefined);
      r.accept(event);
      return { status: "uncertain", id: event.id, message: "lost" };
    });
    const created = await publishChange(r.io, await r.set(), {
      slug: "interest/x",
      value: interest,
    });
    expect(r.sent).toHaveLength(1);
    expect(created?.id).toBe(r.sent[0]?.id);
    // Not accepted: the head is unchanged, so it sends again.
    r.answer(() => {
      r.answer(undefined);
      return { status: "uncertain", message: "lost" };
    });
    await publishChange(r.io, await r.set(), {
      slug: "interest/x",
      value: null,
    });
    expect(r.sent.map((event) => tag(event, "op"))).toEqual([
      "create",
      "delete",
    ]);
  });

  it("refuses a create once the channel holds the most records", async () => {
    const r = relay();
    const full = { ...emptySet(channel), count: HEAD_LIMIT };
    await expect(
      publishChange(r.io, full, { slug: "interest/x", value: interest }),
    ).rejects.toBeInstanceOf(AttentionError);
    expect(r.sent).toHaveLength(0);
  });

  it("resends the owner's same signed event after a lost answer", async () => {
    const published: string[] = [];
    let lose = true;
    const send = ownerSender(
      {
        sign: async (template) => finalizeEvent(template, key) as RelayEvent,
        publish: async (event) => {
          published.push(event.id);
          if (lose) {
            lose = false;
            throw new Error("socket closed");
          }
        },
      },
      new AbortController().signal,
    );
    const event = revision({
      channel,
      d: await attentionD(channel, "interest/x"),
      slug: "interest/x",
      op: "create",
      value: interest,
    });
    expect((await send(event)).status).toBe("uncertain");
    expect((await send(event)).status).toBe("accepted");
    expect(published[0]).toBe(published[1]);
  });

  it("reads typed refusals from the agent's post", () => {
    expect(
      agentDelivery(
        new Error(
          "The community refused the agent event: conflict: stale prev",
        ),
      ),
    ).toEqual({
      status: "refused",
      refusal: "conflict",
      message: "conflict: stale prev",
    });
    expect(agentDelivery(new Error("x"), "a".repeat(64))).toMatchObject({
      status: "uncertain",
      id: "a".repeat(64),
    });
    expect(new PublishRejected("conflict", "x")).toBeInstanceOf(Error);
  });
});

describe("the attention channel", () => {
  const agent = "a".repeat(64);
  const owner = "b".repeat(64);
  const relayKey = generateSecretKey();
  const relayAuthor = getPublicKey(relayKey);
  const metadata = (id: string, created: number, extra: string[][] = []) =>
    finalizeEvent(
      {
        kind: 39000,
        created_at: created,
        content: "",
        tags: [
          ["d", id],
          ["t", "system"],
          ["t", ATTENTION_LABEL],
          ["P", agent],
          ["created_at", String(created)],
          ...extra,
        ],
      },
      relayKey,
    ) as RelayEvent;
  const roster = (id: string, members: string[][]) => [
    metadata(id, 1),
    finalizeEvent(
      {
        kind: 39001,
        created_at: 1,
        content: "",
        tags: [
          ["d", id],
          ...members
            .filter((m) => m[3] === "owner")
            .map(([p, k, , role]) => [
              p as string,
              k as string,
              role as string,
            ]),
        ],
      },
      relayKey,
    ) as RelayEvent,
    finalizeEvent(
      {
        kind: 39002,
        created_at: 1,
        content: "",
        tags: [["d", id], ...members],
      },
      relayKey,
    ) as RelayEvent,
  ];
  function io(found: RelayEvent[], members: string[][]) {
    const published: { kind: number; tags: string[][] }[] = [];
    return {
      published,
      io: {
        agent,
        owner,
        relayAuthor,
        query: async (filters: readonly object[]) =>
          (filters[0] as { kinds: number[] }).kinds.length === 1
            ? found
            : roster(
                (filters[0] as { "#d": string[] })["#d"][0] as string,
                members,
              ),
        publish: async (event: { kind: number; tags: string[][] }) => {
          published.push(event);
        },
      },
    };
  }

  it("creates it as the agent and adds the owner as an owner", async () => {
    const f = io([], [["p", agent, "", "owner"]]);
    const id = await ensureChannel(f.io);
    expect(f.published.map((event) => event.kind)).toEqual([9007, 9000]);
    expect(f.published[0]?.tags).toEqual(
      expect.arrayContaining([
        ["h", id],
        ["visibility", "private"],
        ["channel_type", "system"],
        ["t", ATTENTION_LABEL],
      ]),
    );
    expect(f.published[1]?.tags).toEqual([
      ["h", id],
      ["p", owner],
      ["role", "owner"],
    ]);
  });

  it("uses the oldest, deletes newer ones and leaves a changed roster alone", async () => {
    const older = "11111111-1111-4111-8111-111111111111";
    const newer = "22222222-2222-4222-8222-222222222222";
    const forged = finalizeEvent(
      {
        kind: 39000,
        created_at: 0,
        content: "",
        tags: [
          ["d", "33333333-3333-4333-8333-333333333333"],
          ["t", "system"],
          ["t", ATTENTION_LABEL],
          ["P", agent],
          ["created_at", "0"],
        ],
      },
      key,
    ) as RelayEvent;
    const f = io(
      [metadata(newer, 5), metadata(older, 2), forged],
      [
        ["p", agent, "", "owner"],
        ["p", "c".repeat(64), "", "member"],
      ],
    );
    expect(await ensureChannel(f.io)).toBe(older);
    expect(f.published).toEqual([
      { kind: 9008, content: "", tags: [["h", newer]] },
    ]);
  });
});

describe("one complete read", () => {
  function view(snapshots: ArtifactSyncSnapshot[]) {
    let listener = () => {};
    let disposed = false;
    let at = 0;
    return {
      view: {
        snapshot: () =>
          snapshots[Math.min(at, snapshots.length - 1)] as ArtifactSyncSnapshot,
        subscribe(next: () => void) {
          listener = next;
          return () => {};
        },
        dispose() {
          disposed = true;
        },
      },
      next() {
        at++;
        listener();
      },
      disposed: () => disposed,
    };
  }

  it("takes the set at EOSE and closes", async () => {
    const event = await record("interest/x", interest);
    const v = view([
      { status: "loading", events: [] },
      { status: "live", events: [event] },
    ]);
    const read = readOnce(() => v.view, channel);
    v.next();
    expect(Object.keys((await read).attention)).toEqual(["interest/x"]);
    expect(v.disposed()).toBe(true);
  });

  it("fails without EOSE", async () => {
    const v = view([
      { status: "loading", events: [] },
      { status: "stale", events: [], error: "disconnected" },
    ]);
    const read = readOnce(() => v.view, channel);
    v.next();
    await expect(read).rejects.toThrow(
      "Attention could not be read: disconnected",
    );
  });
});
