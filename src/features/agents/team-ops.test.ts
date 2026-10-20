import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { ReadFilter, RelayEvent } from "../relay/events";
import { ChannelLifecycleUnconfirmed } from "../relay/channel-lifecycle";
import { PublishRejected } from "../relay/outbox";
import { keypair, signed } from "../relay/testing";
import {
  ARTIFACT_MAX_EVENT_BYTES,
  artifactD,
  artifactTemplate,
} from "./agent-config-artifacts";
import { AgentConfigStore } from "./agent-config";
import { agentConfigs } from "./community-config";
import { LifecycleJournal } from "./config-lifecycle";
import { MIGRATION_STORAGE_KEY, MigrationJournal } from "./config-writes";
import { teamSubject } from "./config-channels";
import { TeamJournal } from "./team-config";
import {
  OPS_BYTE_LIMIT,
  OPS_RECORD_LIMIT,
  STORAGE_FULL,
  TEAM_OPS_KEY,
  type TeamOp,
  TeamOps,
  teamRunner,
  unresolved,
} from "./team-ops";
import { memoryStorage } from "./test-fakes";

const owner = keypair();
const other = keypair();
const community = "wss://relay.example";
const CH = "9b353519-f4fe-4757-aef4-bec6cc0ae54c";
const a = keypair().pubkey;
const b = keypair().pubkey;
const team = { name: "Core", instructions: "Ship it.", members: [a, b] };

type Gate = { promise: Promise<void>; open(): void };
const gate = (): Gate => {
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
};

/** One fake community: a team channel with a head, roster and archive flag,
 * and a log of every privileged command and publish, in order. */
function world(options: { exists?: boolean; agents?: string[] } = {}) {
  const storage = memoryStorage();
  const relay = {
    exists: options.exists ?? false,
    archived: false,
    head: undefined as RelayEvent | undefined,
    stored: [] as RelayEvent[],
    roster: new Set<string>(),
  };
  const log: string[] = [];
  const agents = new Set(options.agents ?? [a, b]);
  const hooks = {
    publish: undefined as ((event: RelayEvent) => Promise<void>) | undefined,
    read: undefined as
      | ((filters: readonly ReadFilter[]) => Promise<void>)
      | undefined,
    add: undefined as ((pubkey: string) => Promise<unknown>) | undefined,
    archive: undefined as (() => Promise<void>) | undefined,
  };
  /** The relay's own acceptance: a create needs an unused `d`, an update
   * the current head as `prev`. */
  const accept = (event: RelayEvent) => {
    const prev = event.tags.find((t) => t[0] === "prev")?.[1];
    if (relay.head ? prev !== relay.head.id : prev)
      throw new PublishRejected("conflict", "conflict: stale head");
    relay.head = event;
    relay.stored.push(event);
  };
  const read = vi.fn(async (filters: readonly ReadFilter[]) => {
    await hooks.read?.(filters);
    const [filter] = filters;
    if (filter?.ids)
      return relay.stored.filter((event) => filter.ids?.includes(event.id));
    return relay.head ? [relay.head] : [];
  });
  const writer = {
    sign: vi.fn(async (template: Parameters<typeof signed>[1]) =>
      signed(owner, template),
    ),
    publish: vi.fn(async (event: RelayEvent) => {
      log.push(`publish ${event.tags.find((t) => t[0] === "op")?.[1]}`);
      if (hooks.publish) return hooks.publish(event);
      accept(event);
    }),
  };
  const channel = () => ({
    id: CH,
    archived: relay.archived,
    members: [owner.pubkey, ...relay.roster],
  });
  const channels = {
    find: vi.fn(async (family: string, subject: string) => {
      if (family === "agent-config")
        return agents.has(subject)
          ? { id: `agent-${subject}`, archived: false }
          : undefined;
      return relay.exists ? channel() : undefined;
    }),
    ensure: vi.fn(async () => {
      relay.exists = true;
      return channel();
    }),
    archive: vi.fn(async () => {
      log.push("archive");
      if (hooks.archive) return hooks.archive();
      relay.archived = true;
    }),
    unarchive: vi.fn(async () => {
      log.push("unarchive");
      relay.archived = false;
    }),
    archived: vi.fn(async () => relay.archived),
    addMember: vi.fn(async (_: string, pubkey: string) => {
      log.push(`add ${pubkey}`);
      if (hooks.add) return hooks.add(pubkey) as never;
      relay.roster.add(pubkey);
      return { status: "confirmed" as const };
    }),
    removeMember: vi.fn(async (_: string, pubkey: string) => {
      log.push(`remove ${pubkey}`);
      relay.roster.delete(pubkey);
      return { status: "confirmed" as const };
    }),
    owns: vi.fn(async (pubkey: string) => agents.has(pubkey)),
  };
  const done = vi.fn();
  const make = (ops: TeamOps, who = owner.pubkey, where = community) =>
    teamRunner({
      read,
      writer,
      maxEventBytes: ARTIFACT_MAX_EVENT_BYTES,
      signal: new AbortController().signal,
      channels,
      sync: { bind: vi.fn(async () => {}) },
      store: new AgentConfigStore(storage),
      ops,
      owner: who,
      community: where,
      done,
      changed() {},
    });
  let ops = new TeamOps(storage);
  const w = {
    storage,
    relay,
    log,
    hooks,
    read,
    writer,
    channels,
    done,
    agents,
    accept,
    get ops() {
      return ops;
    },
    runner: make(ops),
    make,
    /** A restart: the records reload from storage, with no memory. */
    restart() {
      ops = new TeamOps(storage);
      w.runner = make(ops);
      return w.runner;
    },
  };
  return w;
}

/** A team revision as any device would sign it, on the current head. */
async function revision(
  w: ReturnType<typeof world>,
  teamId: string,
  body: { name: string; instructions: string },
  key = other,
) {
  const head = w.relay.head;
  return signed(
    key,
    artifactTemplate({
      channel: CH,
      type: "buzz.team",
      d: await artifactD("buzz.team", CH),
      team: teamId,
      title: body.name,
      content: JSON.stringify({ version: 1, ...body }),
      ...(head
        ? { op: "update" as const, prev: head.id }
        : { op: "create" as const }),
      extra: [["team", teamId]],
    }),
  );
}

/** A team that exists on the relay, made elsewhere, with `roster`. */
async function existing(
  w: ReturnType<typeof world>,
  roster: string[] = [a, b],
) {
  const teamId = crypto.randomUUID();
  w.relay.exists = true;
  w.accept(await revision(w, teamId, team));
  for (const pubkey of roster) w.relay.roster.add(pubkey);
  return teamId;
}

const edit = (
  w: ReturnType<typeof world>,
  teamId: string,
  intent: Partial<typeof team> = {},
  runner = w.runner,
) =>
  runner.start({
    kind: "edit",
    teamId,
    channel: CH,
    base: w.relay.head?.id ?? null,
    intent: { ...team, ...intent },
  });

const record = (w: ReturnType<typeof world>, id: string) =>
  w.ops.get(id) as TeamOp;

describe("team operations: witnesses", () => {
  it("1: a second stale form on one device conflicts and keeps its draft", async () => {
    const w = world();
    const teamId = await existing(w);
    const first = edit(w, teamId, { instructions: "First" });
    const second = edit(w, teamId, { instructions: "Second" });
    expect(await first.done).toBeUndefined();
    const after = await second.done;
    expect(after).toMatchObject({ stop: "conflict", mode: "reconcile-only" });
    expect(after?.intent.instructions).toBe("Second");
    expect(JSON.parse(w.relay.head?.content ?? "").instructions).toBe("First");
  });

  it("2: H accepted, then J on top: no members touched, stopped as conflict", async () => {
    const w = world();
    const teamId = await existing(w, [a]);
    w.hooks.publish = async (event) => {
      w.accept(event);
      w.accept(await revision(w, teamId, { ...team, instructions: "J" }));
    };
    const { done } = edit(w, teamId, { instructions: "H" });
    expect(await done).toMatchObject({ stop: "conflict" });
    expect(w.channels.addMember).not.toHaveBeenCalled();
  });

  it("3: an unreadable lookup is unresolved; a later fresh read resolves a lost reply", async () => {
    const w = world();
    const teamId = await existing(w);
    w.hooks.publish = async (event) => {
      w.accept(event);
      throw new Error("connection lost");
    };
    const { op, done } = edit(w, teamId, { instructions: "H" });
    expect(unresolved((await done) as TeamOp)).toBe(true);
    w.hooks.publish = undefined;
    w.hooks.read = async () => {
      throw new Error("redacted");
    };
    expect(unresolved((await w.runner.run(op.id)) as TeamOp)).toBe(true);
    w.hooks.read = undefined;
    expect(await w.runner.run(op.id)).toBeUndefined();
    expect(w.writer.sign).toHaveBeenCalledTimes(1);
  });

  it("4: H accepted, reply lost, restart: resumes with H confirmed, no replacement", async () => {
    const w = world();
    const teamId = await existing(w);
    w.hooks.publish = async (event) => {
      w.accept(event);
      throw new Error("connection lost");
    };
    const { op, done } = edit(w, teamId, { instructions: "H" });
    const held = ((await done) as TeamOp).candidate?.event.id;
    w.hooks.publish = undefined;
    w.restart();
    await w.runner.resume();
    expect(w.ops.get(op.id)).toBeUndefined();
    expect(w.relay.head?.id).toBe(held);
    expect(w.writer.sign).toHaveBeenCalledTimes(1);
    expect(w.writer.publish).toHaveBeenCalledTimes(1);
  });

  it("5: save confirmed, a member add fails, restart: only that member's command remains", async () => {
    const w = world();
    const teamId = await existing(w, []);
    w.hooks.add = async (pubkey) => {
      if (pubkey === b) return { status: "failed", error: "nope" };
      w.relay.roster.add(pubkey);
      return { status: "confirmed" };
    };
    const { op, done } = edit(w, teamId, { instructions: "New" });
    await done;
    w.restart();
    expect(record(w, op.id).commands).toEqual([
      { action: "add", pubkey: a, state: "confirmed" },
      { action: "add", pubkey: b, state: "refused", error: "nope" },
    ]);
    w.hooks.add = undefined;
    w.log.length = 0;
    expect(await w.runner.run(op.id)).toBeUndefined();
    expect(w.log).toEqual([`add ${b}`]);
  });

  it("6: a never-confirmed member removed in the form: the add drops and no removal is sent", async () => {
    const w = world({ agents: [a] });
    const teamId = await existing(w, []);
    const { op, done } = edit(w, teamId, { members: [a, b] });
    expect(record(w, op.id) ?? (await done)).toBeDefined();
    await done;
    // b has no agent channel yet, so its add stays planned.
    expect(record(w, op.id).commands).toContainEqual({
      action: "add",
      pubkey: b,
      state: "planned",
    });
    await w.runner.revise(op.id, { ...team, members: [a] });
    expect(await w.runner.run(op.id)).toBeUndefined();
    expect(w.channels.removeMember).not.toHaveBeenCalled();
    expect(w.log).not.toContain(`add ${b}`);
  });

  it("7: after an uncertain save, a rename and back resends the held bytes and re-signs nothing", async () => {
    const w = world();
    const teamId = await existing(w);
    w.hooks.publish = async () => {
      throw new Error("timeout");
    };
    const { op, done } = edit(w, teamId, { name: "Renamed" });
    const held = ((await done) as TeamOp).candidate?.event;
    await w.runner.revise(op.id, { ...team, name: "Other" });
    await w.runner.revise(op.id, { ...team, name: "Renamed" });
    w.hooks.publish = undefined;
    expect(await w.runner.run(op.id)).toBeUndefined();
    expect(w.writer.sign).toHaveBeenCalledTimes(1);
    expect(w.writer.publish.mock.calls.map(([e]) => e)).toEqual([held, held]);
  });

  it("after an uncertain rename, reverting the form republishes the original over the landed rename", async () => {
    const w = world();
    const teamId = await existing(w);
    w.hooks.publish = async (event) => {
      w.accept(event);
      throw new Error("timeout");
    };
    const { op, done } = edit(w, teamId, { name: "Intervening" });
    await done;
    await w.runner.revise(op.id, team);
    w.hooks.publish = undefined;
    expect(await w.runner.run(op.id)).toBeUndefined();
    expect(JSON.parse(w.relay.head?.content ?? "{}").name).toBe(team.name);
    expect(w.writer.sign).toHaveBeenCalledTimes(2);
  });

  it("8: Discard moves to reconcile-only and keeps the evidence", async () => {
    const w = world();
    const teamId = await existing(w);
    w.hooks.publish = async () => {
      throw new Error("timeout");
    };
    const { op, done } = edit(w, teamId, { name: "Renamed" });
    await done;
    await w.runner.discard(op.id);
    expect(record(w, op.id)).toMatchObject({
      mode: "reconcile-only",
      stop: "discarded",
      candidate: expect.anything(),
    });
    await expect(w.runner.dismiss(op.id)).rejects.toThrow();
    w.hooks.publish = undefined;
    await w.runner.run(op.id);
    expect(w.writer.publish).toHaveBeenCalledTimes(1);
  });

  it("9: a rejected step, then another on the same team runs; the caller gets the original error", async () => {
    const w = world();
    const teamId = await existing(w);
    w.writer.sign.mockRejectedValueOnce(new Error("signer gone"));
    const first = edit(w, teamId, { name: "One" });
    const second = edit(w, teamId, { name: "Two" });
    await expect(first.done).rejects.toThrow("signer gone");
    await w.runner.discard(first.op.id);
    expect(await second.done).toBeUndefined();
    expect(JSON.parse(w.relay.head?.content ?? "").name).toBe("Two");
  });

  it("10: a Delete submitted during a paused member change archives only after it, held by the fence", async () => {
    const w = world();
    const teamId = await existing(w, []);
    const paused = gate();
    w.hooks.add = async (pubkey) => {
      await paused.promise;
      w.relay.roster.add(pubkey);
      return { status: "confirmed" };
    };
    const change = edit(w, teamId);
    await vi.waitFor(() => expect(w.log).toContain(`add ${a}`));
    const deletion = w.runner.start({
      kind: "delete",
      teamId,
      channel: CH,
      intent: { name: "", instructions: "", members: [] },
    });
    paused.open();
    await change.done;
    expect(await deletion.done).toBeUndefined();
    expect(w.log).toEqual([`add ${a}`, "archive"]);
  });

  it("runs one step of a change at a time, so a second run never resends bytes still being sent", async () => {
    const w = world();
    const teamId = await existing(w);
    const sending = gate();
    const entered = gate();
    w.hooks.publish = async (event) => {
      entered.open();
      await sending.promise;
      w.accept(event);
    };
    const change = edit(w, teamId, { name: "Renamed" });
    await entered.promise;
    const again = w.runner.run(change.op.id);
    sending.open();
    await change.done;
    await again;
    expect(w.log.filter((line) => line.startsWith("publish"))).toEqual([
      "publish update",
    ]);
  });

  it("11: Delete then Recover with H unchanged: the old record's pending add never runs", async () => {
    const w = world({ agents: [a] });
    const teamId = await existing(w, []);
    const old = edit(w, teamId, { members: [a, b] });
    await old.done;
    const lifecycle = { name: "", instructions: "", members: [] };
    await w.runner.start({
      kind: "delete",
      teamId,
      channel: CH,
      intent: lifecycle,
    }).done;
    await w.runner.start({
      kind: "recover",
      teamId,
      channel: CH,
      intent: lifecycle,
    }).done;
    w.agents.add(b);
    await w.runner.run(old.op.id);
    expect(w.log).not.toContain(`add ${b}`);
    expect(record(w, old.op.id)).toMatchObject({ stop: "deleted" });
  });

  it("12: an uncertain Delete, then a read showing active: nothing is resent; Recover and members stay fenced", async () => {
    const w = world();
    const teamId = await existing(w, []);
    w.hooks.archive = async () => {
      throw new ChannelLifecycleUnconfirmed(new Error("timeout"));
    };
    const lifecycle = { name: "", instructions: "", members: [] };
    const del = w.runner.start({
      kind: "delete",
      teamId,
      channel: CH,
      intent: lifecycle,
    });
    expect(record(w, (await del.done)?.id ?? "").commands[0]?.state).toBe(
      "maybe-sent",
    );
    await w.runner.run(del.op.id);
    const recover = w.runner.start({
      kind: "recover",
      teamId,
      channel: CH,
      intent: lifecycle,
    });
    // Recover neither completes nor dispatches while the archive may land.
    expect(await recover.done).toMatchObject({ id: recover.op.id });
    expect(record(w, recover.op.id).commands[0]?.state).toBe("planned");
    await edit(w, teamId).done;
    expect(w.log).toEqual(["archive"]);
  });

  it("13: a restart between sending a member change and recording it: maybe-sent until a roster read shows it", async () => {
    const w = world();
    const teamId = await existing(w, []);
    w.hooks.add = () => new Promise(() => {});
    const { op } = edit(w, teamId, { members: [a] });
    await vi.waitFor(() =>
      expect(record(w, op.id).commands[0]?.state).toBe("maybe-sent"),
    );
    w.hooks.add = undefined;
    w.restart();
    await w.runner.run(op.id);
    expect(w.channels.addMember).toHaveBeenCalledTimes(1);
    expect(record(w, op.id).commands[0]?.state).toBe("maybe-sent");
    w.relay.roster.add(a);
    expect(await w.runner.run(op.id)).toBeUndefined();
    expect(w.channels.addMember).toHaveBeenCalledTimes(1);
  });

  it("14: two owners and two communities don't affect each other's allowance", async () => {
    const storage = memoryStorage();
    const ops = new TeamOps(storage);
    const fill = async (who: string, where: string, n: number) => {
      for (let i = 0; i < n; i++) {
        const op = base(who, where);
        await ops.write({ [op.id]: op });
      }
    };
    await fill("alice", community, OPS_RECORD_LIMIT);
    await expect(fill("alice", community, 1)).rejects.toThrow(STORAGE_FULL);
    await expect(fill("bob", community, 1)).resolves.toBeUndefined();
    await expect(
      fill("alice", "wss://other.example", 1),
    ).resolves.toBeUndefined();
  });

  it("15: a full budget or a throwing setItem sends nothing", async () => {
    const w = world();
    const teamId = await existing(w);
    for (let i = 0; i < OPS_RECORD_LIMIT; i++) {
      const op = base(owner.pubkey, community);
      await w.ops.write({ [op.id]: op });
    }
    expect(() => edit(w, teamId)).toThrow(STORAGE_FULL);
    const v = world();
    const id = await existing(v);
    const setItem = v.storage.setItem;
    const { op, done } = edit(v, id, { name: "Renamed" });
    v.storage.setItem = (key, value) => {
      if (key === TEAM_OPS_KEY && value.includes('"candidate"'))
        throw new Error("QuotaExceededError");
      setItem(key, value);
    };
    await expect(done).rejects.toThrow(STORAGE_FULL);
    expect(v.writer.publish).not.toHaveBeenCalled();
    expect(v.ops.get(op.id)?.candidate).toBeUndefined();
  });

  it("16: a rate-limited team save leaves agent migration storage untouched; no team path uses agent writes", async () => {
    const w = world();
    const teamId = await existing(w);
    w.hooks.publish = async () => {
      throw new PublishRejected("slow down", "rate-limited: slow down");
    };
    const { op, done } = edit(w, teamId, { name: "Renamed" });
    await done;
    // A refused first attempt frees its bytes; the change keeps sending.
    expect(record(w, op.id)).toMatchObject({
      mode: "may-send",
      error: expect.stringContaining("slow down"),
    });
    expect(record(w, op.id).candidate).toBeUndefined();
    expect(w.storage.getItem(MIGRATION_STORAGE_KEY)).toBeNull();
    for (const file of ["team-ops.ts", "team-config.ts"]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source).not.toMatch(
        /import \{[^}]*\b(write|send|resume|migrate|MigrationJournal)\b[^}]*\} from "\.\/config-writes"/,
      );
    }
  });
});

describe("team operations: corrections", () => {
  it("a first Create sends op=create with no head", async () => {
    const w = world();
    const teamId = crypto.randomUUID();
    const { done } = w.runner.start({
      kind: "create",
      teamId,
      base: null,
      intent: team,
    });
    expect(await done).toBeUndefined();
    const [sent] = w.writer.publish.mock.calls.map(([e]) => e);
    expect(sent?.tags).toContainEqual(["op", "create"]);
    expect(sent?.tags.some((t) => t[0] === "prev")).toBe(false);
    expect([...w.relay.roster]).toEqual([a, b]);
  });

  it("a members-only edit signs nothing", async () => {
    const w = world();
    const teamId = await existing(w, [a, b]);
    expect(await edit(w, teamId, { members: [a] }).done).toBeUndefined();
    expect(w.writer.sign).not.toHaveBeenCalled();
    expect(w.log).toEqual([`remove ${b}`]);
  });

  it("an adopted team's base doesn't move on retry, and its text is never replaced", async () => {
    const w = world({ agents: [a] });
    const teamId = await existing(w, []);
    const adopted = w.relay.head?.id;
    const { op, done } = w.runner.start({
      kind: "import",
      teamId,
      source: { kind: "old-buzz-team", id: "old-1" },
      intent: { name: "Imported", instructions: "Old text", members: [a, b] },
    });
    await done;
    expect(record(w, op.id)).toMatchObject({
      base: adopted,
      confirmedHead: adopted,
    });
    w.accept(await revision(w, teamId, { ...team, instructions: "Later" }));
    w.agents.add(b);
    expect(await w.runner.run(op.id)).toMatchObject({
      stop: "conflict",
      base: adopted,
    });
    expect(w.writer.sign).not.toHaveBeenCalled();
    expect(w.log).not.toContain(`add ${b}`);
  });

  it("Delete archives a team whose record can't be read", async () => {
    const w = world();
    const teamId = await existing(w);
    w.hooks.read = async () => {
      throw new Error("unreadable");
    };
    const { done } = w.runner.start({
      kind: "delete",
      teamId,
      channel: CH,
      intent: { name: "", instructions: "", members: [] },
    });
    expect(await done).toBeUndefined();
    expect(w.relay.archived).toBe(true);
  });

  it("Recover runs after archived metadata is seen", async () => {
    const w = world();
    const teamId = await existing(w);
    w.relay.archived = true;
    const { done } = w.runner.start({
      kind: "recover",
      teamId,
      channel: CH,
      intent: { name: "", instructions: "", members: [] },
    });
    expect(await done).toBeUndefined();
    expect(w.log).toEqual(["unarchive"]);
  });

  it("accepted, then superseded: a conflict that frees the held bytes and keeps the draft", async () => {
    const w = world();
    const teamId = await existing(w);
    w.hooks.publish = async (event) => {
      w.accept(event);
      w.accept(await revision(w, teamId, { ...team, instructions: "J" }));
    };
    const { op, done } = edit(w, teamId, { instructions: "H" });
    const after = (await done) as TeamOp;
    expect(after).toMatchObject({
      stop: "conflict",
      intent: { instructions: "H" },
    });
    expect(after.candidate).toBeUndefined();
    expect(after.accepted).toBe(w.relay.stored.at(-2)?.id);
    await expect(w.runner.dismiss(op.id)).resolves.toBeUndefined();
  });

  it("a held revision proven absent after another device moved the head frees the team", async () => {
    const w = world();
    const teamId = await existing(w);
    w.hooks.publish = async () => {
      throw new Error("timeout");
    };
    const { op, done } = edit(w, teamId, { instructions: "H" });
    await done;
    w.hooks.publish = undefined;
    w.accept(await revision(w, teamId, { ...team, instructions: "J" }));
    const after = (await w.runner.run(op.id)) as TeamOp;
    expect(after).toMatchObject({
      stop: "conflict",
      intent: { instructions: "H" },
    });
    expect(after.candidate).toBeUndefined();
    expect(after.accepted).toBeUndefined();
    // Resubmit from the current head publishes the kept draft.
    const again = await w.runner.resubmit(op.id, w.relay.head?.id ?? null);
    expect(await again.done).toBeUndefined();
    expect(JSON.parse(w.relay.head?.content ?? "").instructions).toBe("H");
  });

  it("a superseded head alone doesn't prove a held revision was stored or absent", async () => {
    const w = world();
    const teamId = await existing(w);
    w.hooks.publish = async () => {
      throw new Error("timeout");
    };
    const { op, done } = edit(w, teamId, { instructions: "H" });
    await done;
    w.hooks.publish = undefined;
    w.hooks.read = async ([filter]) => {
      if (filter?.ids) throw new Error("lookup failed");
    };
    w.accept(await revision(w, teamId, { ...team, instructions: "J" }));
    const after = (await w.runner.run(op.id)) as TeamOp;
    expect(after.stop).toBe("conflict");
    expect(after.candidate).toBeDefined();
    expect(after.accepted).toBeUndefined();
    await expect(w.runner.dismiss(op.id)).rejects.toThrow();
  });

  it("a Delete queued mid-step stops the next member command", async () => {
    const w = world();
    const teamId = await existing(w, []);
    const paused = gate();
    w.hooks.add = async (pubkey) => {
      await paused.promise;
      w.relay.roster.add(pubkey);
      return { status: "confirmed" };
    };
    const change = edit(w, teamId);
    await vi.waitFor(() => expect(w.log).toContain(`add ${a}`));
    w.runner.submit({
      kind: "delete",
      teamId,
      channel: CH,
      intent: { name: "", instructions: "", members: [] },
    });
    paused.open();
    await change.done;
    expect(w.log).not.toContain(`add ${b}`);
  });

  it("Resubmit doesn't dispatch while another record on the team has an open command fence", async () => {
    const w = world();
    const teamId = await existing(w);
    w.hooks.publish = async (event) => {
      w.accept(event);
      w.accept(await revision(w, teamId, { ...team, instructions: "J" }));
    };
    const stopped = (await edit(w, teamId, { instructions: "H" })
      .done) as TeamOp;
    w.hooks.publish = undefined;
    w.hooks.archive = async () => {
      throw new ChannelLifecycleUnconfirmed(new Error("timeout"));
    };
    const lifecycle = { name: "", instructions: "", members: [] };
    // An uncertain archive, then a Recover: the archive fence stays open.
    await w.runner.start({
      kind: "delete",
      teamId,
      channel: CH,
      intent: lifecycle,
    }).done;
    w.writer.sign.mockClear();
    const again = await w.runner.resubmit(stopped.id, w.relay.head?.id ?? null);
    expect(unresolved((await again.done) as TeamOp)).toBe(false);
    expect(w.writer.sign).not.toHaveBeenCalled();
  });

  it("measures a record in full serialized bytes, JSON escaping and signed envelope included", async () => {
    const ops = new TeamOps(memoryStorage());
    const event = await signed(owner, {
      kind: 45010,
      created_at: 1,
      content: "x".repeat(4096),
      tags: [["team", "t"]],
    });
    const op: TeamOp = {
      ...base(owner.pubkey, community),
      candidate: { event, sends: 1 },
      commands: [{ action: "add", pubkey: a, state: "maybe-sent" }],
    };
    const envelope = JSON.stringify({
      ...op,
      intent: { ...op.intent, instructions: "" },
    });
    // Each quote serializes as two bytes, so raw length fits but bytes don't.
    const quotes = Math.floor((OPS_BYTE_LIMIT - envelope.length) / 2) + 1;
    const big = {
      ...op,
      intent: { ...op.intent, instructions: '"'.repeat(quotes) },
    };
    expect(big.intent.instructions.length).toBeLessThan(OPS_BYTE_LIMIT);
    expect(() => ops.write({ [big.id]: big })).toThrow(STORAGE_FULL);
    const fits = {
      ...big,
      intent: { ...big.intent, instructions: '"'.repeat(quotes - 2) },
    };
    expect(() => ops.write({ [fits.id]: fits })).not.toThrow();
  });

  it("a storage failure after a member command is sent keeps its maybe-sent fence and reports it", async () => {
    const w = world();
    const teamId = await existing(w, []);
    const setItem = w.storage.setItem;
    w.hooks.add = async (pubkey) => {
      w.relay.roster.add(pubkey);
      w.storage.setItem = () => {
        throw new Error("QuotaExceededError");
      };
      return { status: "confirmed" };
    };
    const { op, done } = edit(w, teamId, { members: [a] });
    await expect(done).rejects.toThrow(STORAGE_FULL);
    w.storage.setItem = setItem;
    w.restart();
    expect(record(w, op.id).commands[0]?.state).toBe("maybe-sent");
  });
});

let seq = 0;
function base(who: string, where: string): TeamOp {
  return {
    id: crypto.randomUUID(),
    owner: who,
    community: where,
    teamId: crypto.randomUUID(),
    kind: "edit",
    intent: team,
    commands: [],
    mode: "may-send",
    seq: ++seq,
  };
}

describe("team operations: failures before sending", () => {
  it("a lifecycle command refused before publishing stays planned and archives on the next run", async () => {
    const w = world();
    const teamId = await existing(w, []);
    w.hooks.archive = async () => {
      throw new Error("Another channel action is still in progress");
    };
    const del = w.runner.start({
      kind: "delete",
      teamId,
      channel: CH,
      intent: { name: "", instructions: "", members: [] },
    });
    const after = (await del.done) as TeamOp;
    expect(after.commands[0]?.state).toBe("planned");
    expect(unresolved(after)).toBe(false);
    // Another change on the team isn't fenced by it.
    w.hooks.archive = undefined;
    w.restart();
    expect(await w.runner.run(del.op.id)).toBeUndefined();
    expect(w.relay.archived).toBe(true);
  });

  it("a member command whose ownership read throws stays planned and joins on the next run", async () => {
    const w = world();
    const teamId = await existing(w, []);
    w.hooks.add = async () => {
      throw new Error("profile read failed");
    };
    const { op, done } = edit(w, teamId, { members: [a] });
    const after = (await done) as TeamOp;
    expect(after.commands).toEqual([
      {
        action: "add",
        pubkey: a,
        state: "planned",
        error: "profile read failed",
      },
    ]);
    expect(unresolved(after)).toBe(false);
    w.hooks.add = undefined;
    expect(await w.runner.run(op.id)).toBeUndefined();
    expect(w.relay.roster.has(a)).toBe(true);
  });
});

describe("team operations: saved before sending", () => {
  /** Holds or rejects the next save of team records that `match` selects. */
  const hold = (
    w: ReturnType<typeof world>,
    match: (value: string) => boolean,
    reject = false,
  ) => {
    const held = gate();
    const reached = gate();
    const set = w.storage.set;
    const spy = vi
      .spyOn(w.storage, "set")
      .mockImplementation(async (key, value) => {
        if (key === TEAM_OPS_KEY && value && match(value)) {
          spy.mockRestore();
          reached.open();
          await held.promise;
          if (reject) throw new Error("disk full");
        }
        return set(key, value);
      });
    return { reached: reached.promise, release: held.open };
  };

  it("sends a revision only once its held bytes are saved", async () => {
    const w = world();
    const teamId = await existing(w);
    const save = hold(w, (value) => value.includes('"candidate"'));
    const { op, done } = edit(w, teamId, { name: "Renamed" });
    await save.reached;
    expect(w.writer.publish).not.toHaveBeenCalled();
    // Not saved yet, so a restart knows of no held bytes.
    expect(new TeamOps(w.storage).get(op.id)?.candidate).toBeUndefined();
    save.release();
    expect(await done).toBeUndefined();
    expect(w.writer.publish).toHaveBeenCalledOnce();
    expect(JSON.parse(w.relay.head?.content ?? "").name).toBe("Renamed");
  });

  it("sends nothing when a revision's held bytes can't be saved", async () => {
    const w = world();
    const teamId = await existing(w);
    const save = hold(w, (value) => value.includes('"candidate"'), true);
    const { op, done } = edit(w, teamId, { name: "Renamed" });
    await save.reached;
    save.release();
    await expect(done).rejects.toThrow(STORAGE_FULL);
    expect(w.writer.publish).not.toHaveBeenCalled();
    expect(w.ops.get(op.id)?.candidate).toBeUndefined();
    expect(new TeamOps(w.storage).get(op.id)?.candidate).toBeUndefined();
  });

  it("adds a member only once its command is saved as maybe sent, and not when that save fails", async () => {
    const w = world();
    const teamId = await existing(w, []);
    const save = hold(w, (value) => value.includes('"maybe-sent"'));
    const { done } = edit(w, teamId, { members: [a] });
    await save.reached;
    expect(w.channels.addMember).not.toHaveBeenCalled();
    save.release();
    expect(await done).toBeUndefined();
    expect(w.relay.roster.has(a)).toBe(true);

    const v = world();
    const id = await existing(v, []);
    const failed = hold(v, (value) => value.includes('"maybe-sent"'), true);
    const change = edit(v, id, { members: [a] });
    await failed.reached;
    failed.release();
    await expect(change.done).rejects.toThrow(STORAGE_FULL);
    expect(v.channels.addMember).not.toHaveBeenCalled();
    expect(v.ops.get(change.op.id)?.commands[0]?.state).toBe("planned");
  });

  it("archives only once a Delete's command is saved as maybe sent, and not when that save fails", async () => {
    const start = (w: ReturnType<typeof world>, teamId: string) =>
      w.runner.start({
        kind: "delete",
        teamId,
        channel: CH,
        intent: { name: "", instructions: "", members: [] },
      });
    const w = world();
    const save = hold(w, (value) => value.includes('"maybe-sent"'));
    const del = start(w, await existing(w, []));
    await save.reached;
    expect(w.channels.archive).not.toHaveBeenCalled();
    save.release();
    expect(await del.done).toBeUndefined();
    expect(w.relay.archived).toBe(true);

    const v = world();
    const failed = hold(v, (value) => value.includes('"maybe-sent"'), true);
    const again = start(v, await existing(v, []));
    await failed.reached;
    failed.release();
    await expect(again.done).rejects.toThrow(STORAGE_FULL);
    expect(v.channels.archive).not.toHaveBeenCalled();
    expect(v.relay.archived).toBe(false);
  });

  it("keeps a revision's held bytes and a newer submission saved while they were", async () => {
    const w = world();
    const teamId = await existing(w);
    const save = hold(w, (value) => value.includes('"candidate"'));
    const { op, done } = edit(w, teamId, { name: "Renamed" });
    await save.reached;
    const revised = w.runner.revise(op.id, { ...team, name: "Later" });
    save.release();
    expect(await revised).toBe("applied");
    await done;
    // The held bytes went as signed, then the later name as its own
    // revision: neither save lost the other's change.
    const sent = w.writer.publish.mock.calls.map(
      ([event]) => JSON.parse((event as RelayEvent).content).name,
    );
    expect(sent).toEqual(["Renamed", "Later"]);
    expect(JSON.parse(w.relay.head?.content ?? "").name).toBe("Later");
  });

  it("a Delete stops an earlier change still saving, and numbers after it", async () => {
    const del = (w: ReturnType<typeof world>, teamId: string) =>
      w.runner.submit({
        kind: "delete",
        teamId,
        channel: CH,
        intent: { name: "", instructions: "", members: [] },
      });
    const w = world();
    const teamId = await existing(w);
    const save = hold(w, (value) => value.includes('"Renamed"'));
    const old = edit(w, teamId, { name: "Renamed" });
    await save.reached;
    const deleting = del(w, teamId);
    save.release();
    await deleting.saved;
    expect(record(w, old.op.id)).toMatchObject({
      mode: "reconcile-only",
      stop: "deleted",
    });
    expect(record(w, deleting.op.id).seq).toBeGreaterThan(
      record(w, old.op.id).seq,
    );
    await old.done;
    expect(w.writer.publish).not.toHaveBeenCalled();

    // An earlier change that never saved isn't there to stop.
    const v = world();
    const id = await existing(v);
    const failed = hold(v, (value) => value.includes('"Renamed"'), true);
    const lost = edit(v, id, { name: "Renamed" });
    await failed.reached;
    const after = del(v, id);
    failed.release();
    await expect(lost.done).rejects.toThrow(STORAGE_FULL);
    await after.saved;
    expect(v.ops.get(lost.op.id)).toBeUndefined();
    expect(record(v, after.op.id)).toMatchObject({ mode: "may-send", seq: 1 });
  });

  it("two Resubmits of one stopped change replace it once", async () => {
    const w = world();
    const teamId = await existing(w);
    const { op } = w.runner.submit({
      kind: "edit",
      teamId,
      channel: CH,
      base: w.relay.head?.id ?? null,
      intent: { ...team, name: "Renamed" },
    });
    await w.ops.settled();
    await w.runner.discard(op.id);
    const save = hold(w, (value) => !value.includes(op.id));
    const first = w.runner.resubmit(op.id, w.relay.head?.id ?? null);
    await save.reached;
    const second = w.runner.resubmit(op.id, w.relay.head?.id ?? null);
    save.release();
    const replaced = await first;
    await expect(second).rejects.toThrow("already resubmitted");
    expect(await replaced.done).toBeUndefined();
    expect(w.ops.every()).toEqual([]);
    expect(w.writer.publish).toHaveBeenCalledOnce();
  });

  it("a community Save while its finished change is being removed edits from the finished head", async () => {
    const w = world();
    const teamId = await existing(w);
    const form = crypto.randomUUID();
    const label = await teamSubject(teamId);
    const channel = () => ({
      id: CH,
      label,
      archived: w.relay.archived,
      members: [owner.pubkey, ...w.relay.roster],
    });
    const configs = agentConfigs({
      owner: owner.pubkey,
      community,
      ops: w.ops,
      lifecycle: new LifecycleJournal(w.storage),
      teamJournal: new TeamJournal(w.storage),
      channels: {
        ...w.channels,
        teams: async () => (w.relay.exists ? [channel()] : []),
      } as never,
      sync: { bind: async () => {}, unbind() {}, dispose() {} } as never,
      deps: {
        read: w.read,
        writer: w.writer,
        store: new AgentConfigStore(w.storage),
        journal: new MigrationJournal(w.storage),
        maxEventBytes: ARTIFACT_MAX_EVENT_BYTES,
        signal: new AbortController().signal,
      },
      strip() {},
      retire: async () => {},
      changed() {},
    });
    await configs.refreshTeams();
    const removal = hold(w, (value) => !value.includes('"edit"'));
    const first = configs.editTeam(
      teamId,
      { ...team, instructions: "RULE" },
      w.relay.head?.id,
      form,
    );
    await removal.reached;
    const second = configs.editTeam(
      teamId,
      { ...team, instructions: "NEW COMMUNITY SAVE" },
      w.relay.head?.id,
      form,
    );
    removal.release();
    await first;
    await second;
    expect(JSON.parse(w.relay.head?.content ?? "{}").instructions).toBe(
      "NEW COMMUNITY SAVE",
    );
    expect(w.ops.every()).toEqual([]);
    configs.dispose();
  });

  it("finishing never removes a submission saved while it retired the record", async () => {
    const w = world();
    const teamId = await existing(w);
    const retiring = gate(),
      retired = gate();
    w.done.mockImplementationOnce(async () => {
      retiring.open();
      await retired.promise;
    });
    const { op, done } = edit(w, teamId, { instructions: "RULE" });
    await retiring.promise;
    expect(
      await w.runner.revise(op.id, { ...team, instructions: "NEWER" }),
    ).toBe("applied");
    retired.open();
    expect(await done).toBeUndefined();
    expect(JSON.parse(w.relay.head?.content ?? "{}").instructions).toBe(
      "NEWER",
    );
    expect(await w.runner.revise(op.id, team)).toBe("absent");
  });

  /** Releases `prior` (a held save), lets `act` save `match` and holds
   * it until the step's next record write has queued behind it: that
   * write was decided before `act` landed. */
  const landsMeanwhile = async (
    w: ReturnType<typeof world>,
    prior: { release(): void },
    match: string,
    act: () => Promise<unknown>,
  ) => {
    const save = hold(w, (value) => value.includes(match));
    const acted = act();
    prior.release();
    await save.reached;
    const queued = gate();
    const write = w.ops.write.bind(w.ops);
    const update = w.ops.update.bind(w.ops);
    const spies = [
      vi.spyOn(w.ops, "write").mockImplementation((changes) => {
        queued.open();
        return write(changes);
      }),
      vi.spyOn(w.ops, "update").mockImplementation((decide) => {
        queued.open();
        return update(decide);
      }),
    ];
    await queued.promise;
    for (const spy of spies) spy.mockRestore();
    save.release();
    await acted;
  };

  it("never publishes a revision discarded while its send was being prepared", async () => {
    const w = world();
    const teamId = await existing(w);
    const candidate = hold(w, (value) => value.includes('"candidate"'));
    const { op, done } = edit(w, teamId, { name: "Renamed" });
    await candidate.reached;
    await landsMeanwhile(w, candidate, '"discarded"', () =>
      w.runner.discard(op.id),
    );
    await done;
    expect(w.writer.publish).not.toHaveBeenCalled();
    expect(w.ops.get(op.id)?.stop).toBe("discarded");
  });

  it("never adds a member discarded or dropped while its add was being prepared", async () => {
    const drops = [
      [
        '"discarded"',
        (w: ReturnType<typeof world>, id: string) => w.runner.discard(id),
      ],
      [
        '"DROPPED"',
        (w: ReturnType<typeof world>, id: string) =>
          w.runner.revise(id, {
            ...team,
            instructions: "DROPPED",
            members: [],
          }),
      ],
    ] as const;
    for (const [match, drop] of drops) {
      const w = world();
      const teamId = await existing(w, []);
      const plan = hold(w, (value) => value.includes('"planned"'));
      const { op, done } = edit(w, teamId, { members: [a] });
      await plan.reached;
      await landsMeanwhile(w, plan, match, () => drop(w, op.id));
      await done;
      expect(w.channels.addMember).not.toHaveBeenCalled();
      expect(w.relay.roster.has(a)).toBe(false);
    }
  });

  it("never archives for a Delete discarded while its archive was being prepared", async () => {
    const w = world();
    const teamId = await existing(w, []);
    const submitted = hold(w, (value) => value.includes('"delete"'));
    const del = w.runner.start({
      kind: "delete",
      teamId,
      channel: CH,
      intent: { name: "", instructions: "", members: [] },
    });
    await submitted.reached;
    await landsMeanwhile(w, submitted, '"discarded"', () =>
      w.runner.discard(del.op.id),
    );
    await del.done;
    expect(w.channels.archive).not.toHaveBeenCalled();
    expect(w.relay.archived).toBe(false);
  });

  it("saves records in the order they were written", async () => {
    const w = world();
    const teamId = await existing(w);
    const first = hold(w, () => true);
    const one = w.runner.submit({
      kind: "edit",
      teamId,
      base: w.relay.head?.id ?? null,
      intent: team,
    });
    await first.reached;
    const two = w.runner.submit({
      kind: "edit",
      teamId,
      base: w.relay.head?.id ?? null,
      intent: team,
    });
    first.release();
    await Promise.all([one.saved, two.saved]);
    const reloaded = new TeamOps(w.storage);
    expect(reloaded.get(one.op.id)).toBeDefined();
    expect(reloaded.get(two.op.id)).toBeDefined();
  });
});

describe("team operations: member ownership", () => {
  it("an Edit whose ownership read fails keeps the removal pending and retries it", async () => {
    const w = world();
    const teamId = await existing(w, [a, b]);
    w.channels.owns.mockRejectedValueOnce(new Error("profile read failed"));
    const { op, done } = edit(w, teamId, { members: [a] });
    expect(await done).toMatchObject({
      mode: "may-send",
      error: "profile read failed",
    });
    expect(w.relay.roster.has(b)).toBe(true);
    expect(await w.runner.run(op.id)).toBeUndefined();
    expect(w.relay.roster.has(b)).toBe(false);
  });

  it("an Edit leaves a member it verifies isn't owned", async () => {
    const w = world();
    const teamId = await existing(w, [a, b]);
    w.agents.delete(b);
    expect(await edit(w, teamId, { members: [a] }).done).toBeUndefined();
    expect(w.channels.removeMember).not.toHaveBeenCalled();
  });
});

describe("team operations: resubmitting a first publication", () => {
  it.each(["create", "import"] as const)(
    "a %s refused outright publishes its first revision on Resubmit",
    async (kind) => {
      const w = world();
      w.hooks.publish = async () => {
        throw new PublishRejected("forbidden", "restricted: not allowed");
      };
      const teamId = crypto.randomUUID();
      const source = { kind: "old-buzz-team" as const, id: "beta-1" };
      const { op, done } = w.runner.start({
        kind,
        teamId,
        intent: team,
        ...(kind === "create" ? { base: null } : { source }),
      });
      expect(await done).toMatchObject({ mode: "reconcile-only" });
      expect(w.relay.head).toBeUndefined();
      w.hooks.publish = undefined;
      const again = await w.runner.resubmit(op.id, null);
      expect(again.op).toMatchObject({ kind });
      expect(await again.done).toBeUndefined();
      expect(w.relay.head?.tags).toContainEqual(["op", "create"]);
      if (kind === "import")
        expect(w.relay.head?.tags).toContainEqual([
          "imported-from",
          "old-buzz-team:beta-1",
        ]);
    },
  );
});

describe("team operations: transitions", () => {
  it("a Delete submitted during an edit's head read stops it before any member command", async () => {
    const w = world();
    const teamId = await existing(w, []);
    const entered = gate(),
      release = gate();
    w.hooks.read = async () => {
      entered.open();
      await release.promise;
    };
    const old = edit(w, teamId, { members: [a] });
    await entered.promise;
    await w.runner.submit({
      kind: "delete",
      teamId,
      channel: CH,
      intent: { name: "", instructions: "", members: [] },
    }).saved;
    expect(record(w, old.op.id).mode).toBe("reconcile-only");
    release.open();
    await old.done;
    expect(w.log).not.toContain(`add ${a}`);
    expect(record(w, old.op.id)).toMatchObject({
      mode: "reconcile-only",
      stop: "deleted",
    });
  });
  it("one change can add, remove and add a member back, following its latest submission", async () => {
    const w = world({ agents: [a] });
    const teamId = await existing(w, []);
    const old = edit(w, teamId, { members: [a, b] });
    await old.done;
    expect(w.relay.roster.has(a)).toBe(true);
    await w.runner.revise(old.op.id, { ...team, members: [b] });
    await w.runner.run(old.op.id);
    expect(w.relay.roster.has(a)).toBe(false);
    await w.runner.revise(old.op.id, { ...team, members: [a, b] });
    w.agents.add(b);
    await w.runner.run(old.op.id);
    expect(w.relay.roster.has(a)).toBe(true);
  });
  it("one change can remove, add and remove a member, following its latest submission", async () => {
    const w = world({ agents: [a] });
    const teamId = await existing(w, [a]);
    const old = edit(w, teamId, { members: [b] });
    await old.done;
    expect(w.relay.roster.has(a)).toBe(false);
    await w.runner.revise(old.op.id, { ...team, members: [a, b] });
    await w.runner.run(old.op.id);
    expect(w.relay.roster.has(a)).toBe(true);
    await w.runner.revise(old.op.id, { ...team, members: [b] });
    w.agents.add(b);
    await w.runner.run(old.op.id);
    expect(w.relay.roster.has(a)).toBe(false);
    expect(w.relay.roster.has(b)).toBe(true);
  });

  it("a partly done Create revised to drop a joined member removes nobody", async () => {
    const c = keypair().pubkey;
    const w = world({ agents: [a, c] });
    const teamId = crypto.randomUUID();
    // b has no agent channel yet: a joins, b waits.
    const old = w.runner.start({
      kind: "create",
      teamId,
      base: null,
      intent: { ...team, members: [a, b] },
    });
    await old.done;
    expect(w.relay.roster.has(a)).toBe(true);
    // Another device adds a same-owner member meanwhile.
    w.relay.roster.add(c);
    await w.runner.revise(old.op.id, { ...team, members: [b] });
    w.agents.add(b);
    expect(await w.runner.run(old.op.id)).toBeUndefined();
    expect(w.relay.roster.has(a)).toBe(true);
    expect(w.relay.roster.has(b)).toBe(true);
    expect(w.relay.roster.has(c)).toBe(true);
    expect(w.channels.removeMember).not.toHaveBeenCalled();
  });

  it("a partly done Create revised to drop a member not yet joined never adds it", async () => {
    const w = world({ agents: [a] });
    const teamId = crypto.randomUUID();
    const old = w.runner.start({
      kind: "create",
      teamId,
      base: null,
      intent: { ...team, members: [a, b] },
    });
    await old.done;
    expect(await w.runner.revise(old.op.id, { ...team, members: [a] })).toBe(
      "applied",
    );
    w.agents.add(b);
    expect(await w.runner.run(old.op.id)).toBeUndefined();
    expect(w.relay.roster.has(a)).toBe(true);
    expect(w.relay.roster.has(b)).toBe(false);
  });

  it("an adopted Import sends no member command through an empty head read", async () => {
    const w = world({ agents: [a] });
    const teamId = await existing(w, []);
    const old = w.runner.start({
      kind: "import",
      teamId,
      source: { kind: "old-buzz-team", id: "source" },
      intent: { ...team, members: [a, b] },
    });
    await old.done;
    w.agents.add(b);
    w.read.mockResolvedValueOnce([]);
    const before = w.log.length;
    await w.runner.run(old.op.id);
    expect(w.log.slice(before)).toEqual([]);
  });
  it("a stopped uncertain save settles from a by-id read while its head is unreadable, without becoming current", async () => {
    const w = world();
    const teamId = await existing(w);
    w.hooks.publish = async (event) => {
      w.accept(event);
      throw new Error("lost reply");
    };
    const old = edit(w, teamId, { instructions: "H" });
    await old.done;
    await w.runner.discard(old.op.id);
    // A by-id read can still return H, but the head lookup is redacted.
    w.read.mockImplementation(async (filters) =>
      filters[0]?.ids
        ? w.relay.stored.filter((e) => filters[0]?.ids?.includes(e.id))
        : Promise.reject(new Error("head unreadable")),
    );
    await w.runner.run(old.op.id);
    expect(record(w, old.op.id).candidate).toBeUndefined();
    expect(record(w, old.op.id).accepted).toBeDefined();
    expect(record(w, old.op.id).confirmedHead).toBeUndefined();
  });
});

describe("team operations: overlapping steps", () => {
  // `w.make(w.ops)` is a second runner over the same records, outside the
  // first one's queue: what each dispatch re-checks, apart from the queue.
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("runs a team's steps one at a time: a second waits for the first's delivery", async () => {
    const w = world();
    const teamId = await existing(w);
    const entered = gate();
    const release = gate();
    let publishes = 0;
    w.hooks.publish = async () => {
      if (++publishes === 1) {
        entered.open();
        await release.promise;
      }
      throw new Error("timeout");
    };
    const first = edit(w, teamId, { instructions: "new" });
    await entered.promise;
    let ran = false;
    const second = w.runner.run(first.op.id).then(() => {
      ran = true;
    });
    await flush();
    expect(ran).toBe(false);
    expect(w.writer.publish).toHaveBeenCalledTimes(1);
    release.open();
    await Promise.all([first.done, second]);
  });

  it("never replaces a held revision another step installed while it signed", async () => {
    const w = world();
    const teamId = await existing(w);
    const signing = gate();
    const releaseSign = gate();
    const publishing = gate();
    const releasePublish = gate();
    let signs = 0;
    w.writer.sign.mockImplementation(async (template) => {
      const n = ++signs;
      if (n === 1) {
        signing.open();
        await releaseSign.promise;
      }
      return signed(owner, {
        ...template,
        created_at: (template.created_at ?? 100) + n,
      });
    });
    w.hooks.publish = async () => {
      publishing.open();
      await releasePublish.promise;
      throw new Error("timeout");
    };
    const first = edit(w, teamId, { instructions: "new" });
    await signing.promise;
    const second = w.make(w.ops).run(first.op.id);
    await publishing.promise;
    const held = record(w, first.op.id).candidate?.event.id;
    releaseSign.open();
    await first.done;
    expect(record(w, first.op.id).candidate?.event.id).toBe(held);
    expect(w.writer.publish).toHaveBeenCalledTimes(1);
    releasePublish.open();
    await second;
  });

  it("re-checks the team fence before sending a first Create signed meanwhile", async () => {
    const w = world();
    const teamId = crypto.randomUUID();
    const signing = gate();
    const release = gate();
    w.writer.sign.mockImplementationOnce(async (template) => {
      signing.open();
      await release.promise;
      return signed(owner, template);
    });
    const first = w.runner.start({
      kind: "create",
      teamId,
      base: null,
      intent: team,
    });
    await signing.promise;
    w.hooks.publish = async () => {
      throw new Error("timeout");
    };
    const other = w.make(w.ops).start({
      kind: "create",
      teamId,
      base: null,
      intent: team,
    });
    await other.done;
    expect(record(w, other.op.id).candidate?.sends).toBe(1);
    release.open();
    await first.done;
    expect(w.writer.publish).toHaveBeenCalledTimes(1);
  });

  it("sends an archive once when another step sent it during the metadata read", async () => {
    const w = world();
    const teamId = await existing(w);
    const read = gate();
    const release = gate();
    let reads = 0;
    w.channels.archived.mockImplementation(async () => {
      if (++reads === 1) {
        read.open();
        await release.promise;
      }
      return false;
    });
    w.hooks.archive = async () => {
      throw new ChannelLifecycleUnconfirmed(new Error("timeout"));
    };
    const first = w.runner.start({
      kind: "delete",
      teamId,
      channel: CH,
      intent: team,
    });
    await read.promise;
    await w.make(w.ops).run(first.op.id);
    release.open();
    await first.done;
    expect(w.channels.archive).toHaveBeenCalledTimes(1);
  });

  /** Holds the first agent-channel lookup until the returned gate opens. */
  const holdLookup = (w: ReturnType<typeof world>) => {
    const entered = gate();
    const release = gate();
    let lookups = 0;
    const original = w.channels.find.getMockImplementation();
    w.channels.find.mockImplementation(async (family, subject) => {
      if (family === "agent-config" && ++lookups === 1) {
        entered.open();
        await release.promise;
      }
      return original?.(family, subject);
    });
    return { entered, release };
  };

  it("sends a member command once when another step sent it during the agent lookup", async () => {
    const w = world();
    const teamId = await existing(w, []);
    const lookup = holdLookup(w);
    const first = edit(w, teamId, { members: [a] });
    await lookup.entered.promise;
    w.hooks.add = async () => ({ status: "uncertain" });
    await w.make(w.ops).run(first.op.id);
    lookup.release.open();
    await first.done;
    expect(w.channels.addMember).toHaveBeenCalledTimes(1);
  });

  it("sends no member command through another record's fence raised during the agent lookup", async () => {
    const w = world();
    const teamId = await existing(w, []);
    const lookup = holdLookup(w);
    const first = edit(w, teamId, { members: [a] });
    await lookup.entered.promise;
    w.hooks.add = async () => ({ status: "uncertain" });
    await edit(w, teamId, { members: [b] }, w.make(w.ops)).done;
    lookup.release.open();
    await first.done;
    expect(w.channels.addMember).toHaveBeenCalledTimes(1);
  });

  it("drops a member plan made before a revise and plans the new intent afresh", async () => {
    const w = world({ agents: [a] });
    const teamId = await existing(w, [a]);
    const lookup = gate();
    const release = gate();
    w.channels.owns.mockImplementationOnce(async () => {
      lookup.open();
      await release.promise;
      return true;
    });
    const first = edit(w, teamId, { members: [] });
    await lookup.promise;
    await w.runner.revise(first.op.id, { ...team, members: [a, b] });
    const next = w.runner.run(first.op.id);
    release.open();
    expect(await first.done).toBeDefined();
    await next;
    expect(w.channels.removeMember).not.toHaveBeenCalled();
    expect(w.relay.roster.has(a)).toBe(true);
    // b has no agent channel yet: its add waits, so the change stays open.
    expect(record(w, first.op.id).commands).toEqual([
      { action: "add", pubkey: b, state: "planned" },
    ]);
  });

  it("does not bring back a record dismissed while its conflict lookup waited", async () => {
    const w = world();
    const teamId = await existing(w);
    w.hooks.publish = async (event) => {
      w.accept(event);
      throw new Error("timeout");
    };
    const first = edit(w, teamId, { instructions: "new" });
    await first.done;
    w.accept(await revision(w, teamId, { ...team, instructions: "other" }));
    await w.runner.discard(first.op.id);
    const lookup = gate();
    const release = gate();
    let byId = 0;
    const original = w.read.getMockImplementation();
    w.read.mockImplementation(async (filters) => {
      if (filters[0]?.ids && ++byId === 1) {
        lookup.open();
        await release.promise;
      }
      return original?.(filters) ?? [];
    });
    const paused = w.runner.run(first.op.id);
    await lookup.promise;
    await w.make(w.ops).run(first.op.id);
    await w.runner.dismiss(first.op.id);
    release.open();
    await paused;
    expect(w.ops.get(first.op.id)).toBeUndefined();
  });

  it("keeps a Delete's cancellation of a first Create that was signing", async () => {
    const w = world();
    const teamId = crypto.randomUUID();
    const entered = gate();
    const release = gate();
    w.writer.sign.mockImplementationOnce(async (template) => {
      entered.open();
      await release.promise;
      return signed(owner, template);
    });
    const first = w.runner.start({
      kind: "create",
      teamId,
      base: null,
      intent: team,
    });
    await entered.promise;
    w.runner.submit({ kind: "delete", teamId, channel: CH, intent: team });
    release.open();
    await first.done;
    expect(w.writer.publish).not.toHaveBeenCalled();
    expect(record(w, first.op.id)).toMatchObject({
      mode: "reconcile-only",
      stop: "deleted",
    });
  });

  it("saves nothing from a late accepted reply once its record finished", async () => {
    const w = world();
    const teamId = await existing(w);
    const accepted = gate();
    const reply = gate();
    w.hooks.publish = async (event) => {
      w.accept(event);
      accepted.open();
      await reply.promise;
    };
    const first = edit(w, teamId, { instructions: "new" });
    await accepted.promise;
    await w.make(w.ops).run(first.op.id);
    expect(w.ops.get(first.op.id)).toBeUndefined();
    reply.open();
    await first.done;
    expect(w.ops.every()).toEqual([]);
  });
});

describe("team operations: revisions during member work", () => {
  it.each(["name-only", "instructions-back", "instructions-away-and-back"])(
    "publishes and finishes %s revised during member lookup",
    async (scenario) => {
      const w = world();
      const teamId = await existing(w, []);
      const entered = gate(),
        release = gate();
      const find = w.channels.find.getMockImplementation();
      w.channels.find.mockImplementation(async (family, subject) => {
        if (family === "agent-config") {
          entered.open();
          await release.promise;
        }
        return find?.(family, subject);
      });
      const initial = {
        ...team,
        members: [a],
        instructions:
          scenario === "instructions-back"
            ? "FIRST NEW RULE"
            : team.instructions,
      };
      const first = edit(w, teamId, initial);
      await entered.promise;
      const latest = {
        ...initial,
        ...(scenario === "name-only"
          ? { name: "Latest name" }
          : { instructions: team.instructions }),
      };
      if (scenario === "instructions-away-and-back") {
        expect(
          await w.runner.revise(first.op.id, {
            ...initial,
            instructions: "TEMP RULE",
          }),
        ).toBe("applied");
        void w.runner.run(first.op.id);
      }
      expect(await w.runner.revise(first.op.id, latest)).toBe("applied");
      const next = w.runner.run(first.op.id);
      release.open();
      await Promise.all([first.done, next]);
      expect(JSON.parse(w.relay.head?.content ?? "{}")).toMatchObject({
        name: latest.name,
        instructions: latest.instructions,
      });
      expect(w.ops.get(first.op.id)).toBeUndefined();
      expect([...w.relay.roster]).toEqual([a]);
    },
  );

  it("publishes instructions revised during a member lookup before finishing", async () => {
    const w = world();
    const teamId = await existing(w, []);
    const entered = gate(),
      release = gate();
    const find = w.channels.find.getMockImplementation();
    w.channels.find.mockImplementation(async (family, subject) => {
      if (family === "agent-config") {
        entered.open();
        await release.promise;
      }
      return find?.(family, subject);
    });
    const first = edit(w, teamId, { members: [a] });
    await entered.promise;
    expect(
      await w.runner.revise(first.op.id, {
        ...team,
        members: [a],
        instructions: "LATEST SUBMITTED RULE",
      }),
    ).toBe("applied");
    const newer = w.runner.run(first.op.id);
    release.open();
    await Promise.all([first.done, newer]);
    expect(JSON.parse(w.relay.head?.content ?? "{}").instructions).toBe(
      "LATEST SUBMITTED RULE",
    );
  });
  it("runs an archive once when a step overlaps its delivery", async () => {
    const w = world();
    const teamId = await existing(w);
    const entered = gate(),
      release = gate();
    w.hooks.archive = async () => {
      entered.open();
      await release.promise;
      throw new ChannelLifecycleUnconfirmed(new Error("timeout"));
    };
    const first = w.runner.start({
      kind: "delete",
      teamId,
      channel: CH,
      intent: team,
    });
    await entered.promise;
    const next = w.runner.run(first.op.id);
    release.open();
    await Promise.all([first.done, next]);
    expect(w.channels.archive).toHaveBeenCalledTimes(1);
  });
});
