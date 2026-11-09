import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { describe, expect, it, vi } from "vitest";
import type { RelayEvent } from "../relay/events";
import { OBJECT_LIMIT, type AttentionValue } from "./attention";
import { AttentionError } from "./attention-objects";
import {
  ATTENTION_TYPE,
  addWritten,
  agentDelivery,
  attentionChanges,
  attentionD,
  attentionSet,
  compared,
  emptySet,
  HEAD_LIMIT,
  mirrored,
  ownerSender,
  pendingSet,
  publishChange,
  publishChanges,
  readOnce,
  relayAttention,
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

  it("never lets a record that names another slug hide that slug", async () => {
    const good = await record("interest/x", interest, 777);
    const shadow = sign({
      ...revision({
        channel,
        d: await attentionD(channel, "interest/y"),
        slug: "interest/x",
        op: "create",
        value: interest,
      }),
      content: JSON.stringify({ schema: "other", slug: "interest/x" }),
    });
    for (const events of [
      [shadow, good],
      [good, shadow],
    ]) {
      const set = await attentionSet(channel, events);
      expect(Object.keys(set.attention)).toEqual(["interest/x"]);
      expect(Object.keys(set.skipped)).toEqual([`invalid/${tag(shadow, "d")}`]);
    }
  });

  it("applies the first OBJECT_LIMIT of a group by slug and skips the others", async () => {
    const slug = (i: number) => `interest/i${String(i).padStart(4, "0")}`;
    const events = await Promise.all(
      Array.from({ length: OBJECT_LIMIT + 2 }, (_, i) =>
        record(slug(i), interest),
      ),
    );
    const set = await attentionSet(channel, events.reverse());
    expect(Object.keys(set.attention)).toHaveLength(OBJECT_LIMIT);
    expect(Object.keys(set.skipped).sort()).toEqual([
      slug(OBJECT_LIMIT),
      slug(OBJECT_LIMIT + 1),
    ]);
  });

  it("skips a watch whose Interest is skipped, but runs one whose Interest is missing", async () => {
    const unreadable = sign({
      ...revision({
        channel,
        d: await attentionD(channel, "interest/x"),
        slug: "interest/x",
        op: "create",
        value: interest,
      }),
      content: JSON.stringify({
        schema: "agent-attention/v9",
        slug: "interest/x",
        value: { ...interest, paused: true },
      }),
    });
    const over = `interest/i${String(OBJECT_LIMIT).padStart(4, "0")}`;
    const interests = await Promise.all(
      Array.from({ length: OBJECT_LIMIT + 1 }, (_, i) =>
        record(`interest/i${String(i).padStart(4, "0")}`, interest),
      ),
    );
    const set = await attentionSet(channel, [
      unreadable,
      ...interests,
      await record("watch/a", timer),
      await record("watch/b", { ...timer, interest_id: over.slice(9) }),
      await record("watch/c", { ...timer, interest_id: "i0000" }),
      await record("watch/d", { ...timer, interest_id: "gone" }),
    ]);
    expect(set.skipped["watch/a"]?.problem).toBe(
      "Its Interest interest/x is skipped",
    );
    expect(set.skipped["watch/b"]?.problem).toBe(
      `Its Interest ${over} is skipped`,
    );
    expect(
      Object.keys(set.attention).filter((s) => s.startsWith("watch/")),
    ).toEqual(["watch/c", "watch/d"]);
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

  it("orders an edit's objects so no watch is left without its Interest", () => {
    const base = setAttention(
      setAttention(blank, "interest/x", interest, 100),
      "watch/t",
      timer,
      100,
    );
    expect(attentionChanges(base, base)).toEqual([]);
    const removed = setAttention(
      setAttention(base, "watch/t", null),
      "interest/x",
      null,
    );
    expect(attentionChanges(base, removed)).toEqual([
      { slug: "watch/t", value: null },
      { slug: "interest/x", value: null },
    ]);
    expect(attentionChanges(blank, base)).toEqual([
      { slug: "interest/x", value: interest },
      { slug: "watch/t", value: timer },
    ]);
    const skipped = {
      ...blank,
      skipped: {
        "watch/s": { slug: "watch/s", value: 1, modifiedAt: 1, problem: "bad" },
      },
    };
    expect(
      attentionChanges(skipped, setAttention(skipped, "watch/s", null)),
    ).toEqual([{ slug: "watch/s", value: null }]);
  });

  it("keeps this device's writes over a set made before they landed", async () => {
    const r = relay();
    await publishChange(r.io, await r.set(), {
      slug: "interest/x",
      value: interest,
    });
    const before = await r.set();
    const record = mirrored(blank, before);
    const next = setAttention(
      setAttention(record, "interest/x", null),
      "interest/y",
      interest,
    );
    const replaced = await publishChanges(
      r.io,
      before,
      attentionChanges(record, next),
    );
    // A set made before the writes: they stay until a set shows them.
    const written = addWritten(undefined, replaced);
    const stale = pendingSet(before, next, written);
    expect(Object.keys(stale.set.attention)).toEqual(["interest/y"]);
    expect(stale.settled).toEqual([]);
    const after = pendingSet(await r.set(), next, written);
    expect([...after.settled].sort()).toEqual(["interest/x", "interest/y"]);
    expect(Object.keys(after.set.attention)).toEqual(["interest/y"]);
  });
});

describe("comparing a move", () => {
  it("names each object that differs or only the community holds", () => {
    const object = (slug: string, value: AttentionValue) => ({
      slug,
      value,
      modifiedAt: 1,
    });
    let device = setAttention(blank, "interest/titled", {
      type: "interest",
      title: "PR reviews",
      instructions: "# Older heading",
    } as AttentionValue);
    device = setAttention(device, "watch/t", timer, 1);
    const result = compared(device.attention, {
      ...emptySet(channel),
      attention: {
        "interest/q3": object("interest/q3", {
          type: "interest",
          instructions: "\n## Q3 launch\nShip it.",
        }),
        "interest/plain": object("interest/plain", {
          type: "interest",
          instructions: "Just text.",
        }),
      },
    });
    expect(result.names).toEqual({
      "interest/titled": "PR reviews",
      // A timer has no name: its id.
      "watch/t": "t",
      "interest/q3": "Q3 launch",
      "interest/plain": "plain",
    });
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

  it("keeps another client's tags on an edit, and root on a delete and a restore", async () => {
    const r = relay();
    const d = await attentionD(channel, "interest/x");
    const extra = [
      ["root", "a".repeat(64)],
      ["client", "example"],
    ];
    const signer = [
      ["auth", "b".repeat(64), "", "c".repeat(128)],
      ["ms", "123"],
    ];
    const annotations = (event: RelayEvent | undefined) =>
      event?.tags.filter(([name]) => name === "root" || name === "client");
    r.heads.set(
      d,
      sign(
        revision({
          channel,
          d,
          slug: "interest/x",
          op: "create",
          value: interest,
          tags: [...extra, ...signer],
        }),
      ),
    );
    await publishChange(r.io, await r.set(), {
      slug: "interest/x",
      value: { ...interest, instructions: "More" },
    });
    expect(annotations(r.sent[0])).toEqual(extra);
    // Another signer's NIP-OA proof and ms are its own, never copied.
    expect(
      r.sent[0]?.tags.some(([name]) => name === "auth" || name === "ms"),
    ).toBe(false);
    // A deletion keeps root and drops the other annotations and the title.
    await publishChange(r.io, await r.set(), {
      slug: "interest/x",
      value: null,
    });
    const deletion = r.sent.at(-1) as RelayEvent;
    expect(tag(deletion, "op")).toBe("delete");
    expect(annotations(deletion)).toEqual([extra[0]]);
    expect(tag(deletion, "title")).toBeUndefined();
    // An add over that tombstone, which the current set omits, keeps root.
    await publishChange(r.io, await r.set(), {
      slug: "interest/x",
      value: interest,
    });
    expect(tag(r.sent.at(-1) as RelayEvent, "op")).toBe("restore");
    expect(annotations(r.sent.at(-1))).toEqual([extra[0]]);
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

  it("reports an unread head after a lost OK as unsaved, not a conflict", async () => {
    const r = relay();
    await publishChange(r.io, await r.set(), {
      slug: "interest/x",
      value: interest,
    });
    r.answer(() => ({ status: "uncertain", message: "lost" }));
    const failing = {
      ...r.io,
      read: async () => {
        throw new Error("offline");
      },
    };
    const error = await publishChange(failing, await r.set(), {
      slug: "interest/x",
      value: null,
    }).catch((e: unknown) => e);
    expect(String(error)).toMatch(/may not have been saved/);
    expect(error).not.toBeInstanceOf(AttentionError);
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
    const published: RelayEvent[] = [];
    let lose = true;
    const send = ownerSender(
      {
        sign: async (template) => finalizeEvent(template, key) as RelayEvent,
        publish: async (event) => {
          published.push(event);
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
    // The same signed event, not one signed again in the same second.
    expect(published[1]).toBe(published[0]);
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

describe("the kept-current set", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const agent = "a".repeat(64);
  const found = (members = [agent]) => ({ id, archived: false, members });

  /** A relay attention over one channel whose find, sync and follow the
   * test drives. */
  function kept(
    options: {
      find?: () => Promise<ReturnType<typeof found> | undefined>;
      snapshot?: ArtifactSyncSnapshot;
    } = {},
  ) {
    let snapshot: ArtifactSyncSnapshot = options.snapshot ?? {
      status: "live",
      events: [],
    };
    const listeners = new Set<() => void>();
    const followers = new Set<(events: readonly RelayEvent[]) => void>();
    const sets: AttentionSet[] = [];
    const views: { disposed: boolean }[] = [];
    let finds = 0;
    let reports = 0;
    const find = options.find ?? (async () => found());
    const controller = new AbortController();
    const attention = relayAttention({
      agent,
      find: async () => {
        finds++;
        return find();
      },
      artifactSync: true,
      sync: () => {
        const state = { disposed: false };
        views.push(state);
        return {
          snapshot: () => snapshot,
          subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          dispose() {
            state.disposed = true;
          },
        };
      },
      follow(_channel, changed) {
        followers.add(changed);
        return () => followers.delete(changed);
      },
      changed: (set) => sets.push(set),
      reported: () => reports++,
      signal: controller.signal,
      retryMs: 10,
    });
    return {
      attention,
      sets,
      views,
      finds: () => finds,
      reports: () => reports,
      set(next: ArtifactSyncSnapshot) {
        snapshot = next;
        for (const listener of [...listeners]) listener();
      },
      roster(event: Partial<RelayEvent>) {
        for (const follower of [...followers])
          follower([
            { kind: 39002, tags: [["d", id]], ...event } as RelayEvent,
          ]);
      },
      stop: () => controller.abort(),
    };
  }

  it("never finds or creates a channel where the relay has no artifact sync", async () => {
    const find = vi.fn();
    const attention = relayAttention({
      agent,
      find,
      artifactSync: false,
      sync: () => {
        throw new Error("no sync");
      },
      follow: () => () => {},
      changed: () => {},
      reported: () => {},
      signal: new AbortController().signal,
    });
    expect(attention.problem()).toBe("This community can't store attention");
    await expect(attention.read()).rejects.toThrow("can't store attention");
    expect(find).not.toHaveBeenCalled();
    attention.dispose();
  });

  it("drops the set on resync until Find and a new set verify it", async () => {
    const f = kept();
    await vi.waitFor(() => expect(f.sets).toHaveLength(1));
    expect(f.finds()).toBe(1);
    f.set({
      status: "stale",
      events: [],
      error: "resync: channel access changed",
    });
    // Nothing runs from the old set meanwhile.
    expect(f.attention.current()).toBeUndefined();
    expect(f.attention.lost()).toBe(false);
    expect(f.attention.problem()).toMatch(/out of date/);
    f.set({ status: "live", events: [] });
    await vi.waitFor(() => expect(f.sets).toHaveLength(2));
    expect(f.finds()).toBe(2);
    expect(f.attention.current()).toBe(f.sets[1]);
    expect(f.attention.problem()).toBeUndefined();
    f.stop();
  });

  it("keeps the last set through a disconnect", async () => {
    const f = kept();
    await vi.waitFor(() => expect(f.sets).toHaveLength(1));
    f.set({ status: "stale", events: [], error: "disconnected" });
    expect(f.attention.current()).toBe(f.sets[0]);
    expect(f.attention.problem()).toMatch(/reconnecting/);
    f.stop();
  });

  it("runs nothing without a channel, and never creates one", async () => {
    let channel: ReturnType<typeof found> | undefined;
    const f = kept({ find: async () => channel });
    await vi.waitFor(() => expect(f.attention.lost()).toBe(true));
    expect(f.attention.current()).toBeUndefined();
    expect(f.attention.problem()).toBe(
      "This agent has no attention channel on its community",
    );
    expect(f.views).toHaveLength(0);
    await expect(f.attention.read()).rejects.toThrow("no attention channel");
    // Its owner creates one: a later Find uses it.
    channel = found();
    await vi.waitFor(() => expect(f.sets).toHaveLength(1));
    expect(f.attention.lost()).toBe(false);
    f.stop();
  });

  it("runs nothing when the agent is not a member", async () => {
    const f = kept({ find: async () => found(["b".repeat(64)]) });
    await vi.waitFor(() => expect(f.attention.lost()).toBe(true));
    expect(f.attention.problem()).toBe(
      "This agent is not a member of its attention channel",
    );
    expect(f.views).toHaveLength(0);
    f.stop();
  });

  it("stops when a roster change removes the agent", async () => {
    let members = [agent];
    const f = kept({ find: async () => found(members) });
    await vi.waitFor(() => expect(f.sets).toHaveLength(1));
    // A change that keeps the agent goes on with the same sync.
    f.roster({});
    await vi.waitFor(() => expect(f.finds()).toBe(2));
    expect(f.attention.current()).toBe(f.sets[0]);
    expect(f.views).toHaveLength(1);
    members = ["b".repeat(64)];
    f.roster({});
    await vi.waitFor(() => expect(f.attention.lost()).toBe(true));
    expect(f.attention.current()).toBeUndefined();
    expect(f.views[0]?.disposed).toBe(true);
    f.stop();
  });

  it("stops when the channel can no longer be read", async () => {
    const f = kept();
    await vi.waitFor(() => expect(f.sets).toHaveLength(1));
    const reports = f.reports();
    f.set({ status: "restricted", events: [], error: "restricted: gone" });
    expect(f.attention.lost()).toBe(true);
    expect(f.attention.current()).toBeUndefined();
    expect(f.reports()).toBeGreaterThan(reports);
    f.stop();
  });

  it("applies a valid set after one with a malformed record", async () => {
    const f = kept();
    await vi.waitFor(() => expect(f.sets).toHaveLength(1));
    const d = await attentionD(id, "interest/x");
    const malformed = finalizeEvent(
      {
        kind: 45010,
        created_at: 500,
        content: JSON.stringify({
          schema: { toString: 1 },
          slug: "interest/x",
          value: interest,
        }),
        tags: [
          ["ar", "1"],
          ["d", d],
          ["h", id],
          ["type", ATTENTION_TYPE],
          ["op", "create"],
        ],
      },
      key,
    ) as RelayEvent;
    f.set({ status: "live", events: [malformed] });
    await vi.waitFor(() => expect(f.sets).toHaveLength(2));
    expect(f.sets[1]?.skipped["interest/x"]?.problem).toBe(
      "Record schema is not a string",
    );
    const valid = sign(
      revision({
        channel: id,
        d,
        slug: "interest/x",
        op: "create",
        value: interest,
      }),
      600,
    );
    f.set({ status: "live", events: [valid] });
    await vi.waitFor(() => expect(f.sets).toHaveLength(3));
    expect(Object.keys(f.sets[2]?.attention ?? {})).toEqual(["interest/x"]);
    f.stop();
  });
});

it("runs Find at once when a roster change lets a lost agent back in", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const agent = "a".repeat(64);
  let members = [agent];
  const followers = new Set<(events: readonly RelayEvent[]) => void>();
  const controller = new AbortController();
  const attention = relayAttention({
    agent,
    find: async () => ({ id, archived: false, members }),
    artifactSync: true,
    sync: () => ({
      snapshot: () => ({ status: "live", events: [] }),
      subscribe: () => () => {},
      dispose() {},
    }),
    follow(_channel, changed) {
      followers.add(changed);
      return () => followers.delete(changed);
    },
    changed: () => {},
    reported: () => {},
    signal: controller.signal,
    // The default wait: a lost channel's first retry is 15 to 30 seconds.
    retryMs: 30_000,
  });
  const roster = () => {
    for (const follower of [...followers])
      follower([{ kind: 39002, tags: [["d", id]] } as RelayEvent]);
  };
  await vi.waitFor(() => expect(attention.current()).toBeDefined());
  members = ["b".repeat(64)];
  roster();
  await vi.waitFor(() => expect(attention.lost()).toBe(true));
  // Its owner lets it back in (NIP-AT Lost access: Find runs at once).
  members = [agent];
  roster();
  await vi.waitFor(() => expect(attention.lost()).toBe(false), {
    timeout: 1_000,
  });
  controller.abort();
});

it("waits longer after each failed Find in a row", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(1);
  const controller = new AbortController();
  try {
    let finds = 0;
    relayAttention({
      agent: "a".repeat(64),
      find: async () => {
        finds++;
        throw new Error("relay down");
      },
      artifactSync: true,
      sync: () => {
        throw new Error("not reached");
      },
      follow: () => () => {},
      changed: () => {},
      reported: () => {},
      signal: controller.signal,
      retryMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(finds).toBe(1);
    // 1 s, then 2 s, then 4 s (NIP-AR rule 7).
    for (const [wait, total] of [
      [1_000, 2],
      [1_999, 2],
      [1, 3],
      [3_999, 3],
      [1, 4],
    ]) {
      await vi.advanceTimersByTimeAsync(wait as number);
      expect(finds).toBe(total);
    }
  } finally {
    controller.abort();
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
});
