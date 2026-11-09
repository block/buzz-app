import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "nostr-tools/utils";
import { assert, afterEach, expect, it, vi } from "vitest";
import { createRelaySession, type RelaySession } from "../relay/session";
import {
  keypair,
  message,
  metadata,
  roster,
  signed,
  type Key,
} from "../relay/testing";
import { eventDto, type ReadFilter, type RelayEvent } from "../relay/events";
import type { LiveCallbacks } from "../relay/live";
import type { OutboxStorage, OutgoingEvent } from "../relay/outbox";
import { createDmMoves, type MoveStorage } from "./coordinator";
import { moveControl, movedSource } from "./protocol";
const DM = "10000000-0000-4000-8000-000000000001",
  TARGET = "10000000-0000-4000-8000-000000000002";
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function fixture(withAgent = false) {
  vi.spyOn(Math, "random").mockReturnValue(0);
  const relay = keypair(),
    alice = keypair(),
    bob = keypair(),
    agent = keypair();
  const auth = [
    "auth",
    alice.pubkey,
    "",
    bytesToHex(
      schnorr.sign(
        createHash("sha256")
          .update(`nostr:agent-auth:${agent.pubkey}:`)
          .digest(),
        alice.secret,
      ),
    ),
  ];
  let events: RelayEvent[] = [
    metadata(relay, DM, "DM", undefined, [
      ["t", "dm"],
      ["private"],
      ["hidden"],
    ]),
    metadata(relay, TARGET, "Target", undefined, [["t", "stream"], ["public"]]),
    roster(relay, DM, [
      alice.pubkey,
      bob.pubkey,
      ...(withAgent ? [agent.pubkey] : []),
    ]),
    roster(relay, TARGET, [alice.pubkey]),
    message(alice, DM, "First", Math.floor(Date.now() / 1000) - 10),
    message(bob, DM, "Second", Math.floor(Date.now() / 1000) - 9),
  ];
  if (withAgent)
    events.push(
      signed(agent, {
        kind: 0,
        content: JSON.stringify({ name: "Local agent", is_agent: true }),
        tags: [auth],
      }),
      message(agent, DM, "Agent message", Math.floor(Date.now() / 1000) - 8, [
        auth,
      ]),
    );
  const clients = new Set<LiveCallbacks>();
  const published: RelayEvent[] = [];
  const attempts: RelayEvent[] = [];
  const script = { failCopies: false };
  let rosterTime = Math.floor(Date.now() / 1000);
  const reads: ReadFilter[] = [];
  const matches = (e: RelayEvent, f: ReadFilter) =>
    (!f.kinds || f.kinds.includes(e.kind)) &&
    (!f.authors || f.authors.includes(e.pubkey)) &&
    (!f.ids || f.ids.includes(e.id)) &&
    (f.since === undefined || e.created_at >= f.since) &&
    Object.entries(f).every(
      ([k, v]) =>
        !k.startsWith("#") ||
        (v as string[]).some((value) =>
          e.tags.some((t) => t[0] === k.slice(1) && t[1] === value),
        ),
    );
  const emit = (e: RelayEvent) => {
    events.push(e);
    for (const client of clients)
      client.receive([e], {
        phase: "live",
        channelId: e.tags.find((t) => t[0] === "h")?.[1] ?? DM,
      });
  };
  vi.stubGlobal("navigator", {
    locks: {
      request: async (
        _key: string,
        _opts: unknown,
        run: (lock: object) => unknown,
      ) => run({}),
    },
  });
  async function client(
    key: Key,
    retained?: { storage: MoveStorage; outbox: OutboxStorage },
  ) {
    let callbacks!: LiveCallbacks;
    let saved: readonly OutgoingEvent[] = [];
    let journal: ReturnType<MoveStorage["read"]>;
    const storage = retained?.storage ?? {
      read: () => structuredClone(journal),
      write: (value: NonNullable<typeof journal>) => {
        journal = structuredClone(value);
      },
    };
    const outbox = retained?.outbox ?? {
      load: () => structuredClone(saved),
      save: (value: readonly OutgoingEvent[]) => {
        saved = structuredClone(value);
      },
    };
    const owner = createRelaySession(
      {
        viewer: key.pubkey,
        relayAuthor: relay.pubkey,
        scope: "http://localhost:9999",
        media: () => undefined,
        query: async (filters) =>
          filters.flatMap((f) => {
            reads.push(f);
            return events
              .map(eventDto)
              .filter((e) => matches(e, f))
              .sort(
                (a, b) =>
                  b.created_at - a.created_at || b.id.localeCompare(a.id),
              )
              .slice(((f.page ?? 1) - 1) * f.limit, (f.page ?? 1) * f.limit);
          }),
        subscribe(value) {
          callbacks = value;
          clients.add(value);
          return {
            update() {},
            retry() {},
            dispose() {
              clients.delete(value);
            },
          };
        },
        writer: {
          kinds: [9, 9000],
          sign: async (template) => signed(key, template),
          publish: async (event) => {
            attempts.push(event);
            if (script.failCopies && movedSource(event))
              throw new Error("ACK lost before acceptance");
            published.push(event);
            if (event.kind === 9000) {
              const members = events.find(
                (e) =>
                  e.kind === 39002 &&
                  e.tags.some((t) => t[0] === "d" && t[1] === TARGET),
              );
              assert.exists(members);
              events = events.filter((e) => e !== members);
              emit(
                roster(
                  relay,
                  TARGET,
                  [
                    ...members.tags
                      .filter((t) => t[0] === "p")
                      .map((t) => t[1] ?? ""),
                    event.tags.find((t) => t[0] === "p")?.[1] ?? "",
                  ],
                  ++rosterTime,
                ),
              );
            }
            emit(event);
          },
        },
      },
      { outboxStorage: outbox },
    );
    cleanups.push(owner.dispose);
    owner.session.channels.ensureList();
    await vi.waitFor(() =>
      expect(owner.session.channels.list().status).toBe("ready"),
    );
    callbacks.state({ status: "connected", routes: [] });
    const session: RelaySession = {
      ...owner.session,
      presence: { ...owner.session.presence, status: () => "online" },
      agentChoices:
        withAgent && key.pubkey === alice.pubkey
          ? {
              ...owner.session.agentChoices,
              snapshot: () => ({
                ...owner.session.agentChoices.snapshot(),
                identities: [
                  {
                    pubkey: agent.pubkey,
                    name: "Local agent",
                    managed: true,
                    execution: "local" as const,
                  },
                ],
              }),
            }
          : owner.session.agentChoices,
    };
    const host = withAgent
      ? {
          prepare: async (
            _author: string,
            _origin: string,
            template: { kind: number; content: string; tags: string[][] },
          ) =>
            signed(agent, {
              ...template,
              created_at: Math.floor(Date.now() / 1000),
              tags: [...template.tags, auth],
            }),
          publish: async (
            _author: string,
            _origin: string,
            event: RelayEvent,
          ) => {
            published.push(event);
            emit(event);
            return event;
          },
        }
      : undefined;
    const moves = createDmMoves(session, host, storage);
    const errors: string[] = [];
    moves.subscribe(() => {
      const error = moves.snapshot().error;
      if (error) errors.push(error);
    });
    cleanups.push(moves.dispose);
    await vi.waitFor(() => expect(moves.snapshot().loading).toBe(false));
    return {
      session,
      moves,
      errors,
      storage,
      outbox,
      dispose() {
        moves.dispose();
        owner.dispose();
      },
    };
  }
  return {
    alice,
    bob,
    agent,
    relay,
    client,
    published,
    attempts,
    script,
    reads,
    emit,
    events: () => events,
  };
}
it("gets all approvals before membership/copying, preserves authors and recovers without duplicates", async () => {
  const f = fixture();
  const a = await f.client(f.alice);
  const b = await f.client(f.bob);
  const ordinary = vi.fn();
  const incoming = vi.fn();
  a.session.subscribeLive(ordinary);
  a.session.subscribeIncoming(incoming);
  const id = await a.moves.start(DM, TARGET, 24);
  await vi.waitFor(() =>
    expect(
      b.moves.snapshot().moves.some((m) => m.request.event.id === id),
    ).toBe(true),
  );
  expect(
    f.published.every((e) => e.tags.some((t) => t[0] === "h" && t[1] === DM)),
  ).toBe(true);
  await b.moves.respond(id, true);
  await vi.waitFor(
    () =>
      expect(
        a.moves.snapshot().moves.find((m) => m.request.event.id === id)?.status,
      ).toBe("complete"),
    { timeout: 5000 },
  );
  expect(
    ordinary.mock.calls
      .flatMap(([batch]) => batch.events)
      .some((e) => moveControl(e)),
  ).toBe(false);
  expect(
    incoming.mock.calls
      .flatMap(([batch]) => batch)
      .some((e) => e.channelId === DM),
  ).toBe(false);
  const copies = f.published.filter((e) => movedSource(e));
  expect(copies.map((e) => [e.content, e.pubkey]).sort()).toEqual(
    [
      ["First", f.alice.pubkey],
      ["Second", f.bob.pubkey],
    ].sort(),
  );
  expect(f.published.filter((e) => e.kind === 9000)).toHaveLength(1);
  a.dispose();
  const restarted = await f.client(f.alice, a);
  await vi.waitFor(() =>
    expect(
      restarted.moves.snapshot().moves.find((m) => m.request.event.id === id)
        ?.status,
    ).toBe("complete"),
  );
  expect(f.published.filter((e) => movedSource(e))).toHaveLength(2);
  expect(
    f.reads
      .filter((r) => r.include_aux)
      .every((r) => r.consistency === "strong"),
  ).toBe(true);
  expect(
    f.reads.filter((r) => r["#e"]).every((r) => r.depth_limit === undefined),
  ).toBe(true);
  expect(
    f.published.filter((e) => moveControl(e)?.control.type === "done"),
  ).toHaveLength(2);
  const again = await restarted.moves.start(DM, TARGET, 24);
  await vi.waitFor(() =>
    expect(
      b.moves.snapshot().moves.some((m) => m.request.event.id === again),
    ).toBe(true),
  );
  // A fresh request needs fresh consent even when the destination is unchanged.
  expect(f.published.filter((e) => movedSource(e))).toHaveLength(2);
  await b.moves.respond(again, true);
  await vi.waitFor(
    () =>
      expect(
        restarted.moves
          .snapshot()
          .moves.find((m) => m.request.event.id === again)?.status,
      ).toBe("complete"),
    { timeout: 5000 },
  );
  const repeated = restarted.moves
    .snapshot()
    .moves.find((m) => m.request.event.id === again);
  assert.exists(repeated);
  const copiedAgain = f.published.filter(
    (e) => movedSource(e)?.move === repeated.request.control.move,
  );
  expect(copiedAgain.map((e) => e.content).sort()).toEqual(["First", "Second"]);
  expect(copiedAgain.some((e) => movedSource(e)?.original === id)).toBe(false);
  expect(copiedAgain.every((e) => !moveControl(e))).toBe(true);
});

it("lets the initiator cancel without posting and blocks cancellation by another participant", async () => {
  const f = fixture(),
    a = await f.client(f.alice),
    b = await f.client(f.bob);
  const id = await a.moves.start(DM, TARGET, 24);
  await vi.waitFor(() =>
    expect(
      b.moves.snapshot().moves.some((m) => m.request.event.id === id),
    ).toBe(true),
  );
  await expect(b.moves.cancel(id)).rejects.toThrow("cannot be cancelled");
  await a.moves.cancel(id);
  await vi.waitFor(() =>
    expect(
      b.moves.snapshot().moves.find((m) => m.request.event.id === id)?.status,
    ).toBe("cancelled"),
  );
  expect(f.published.some((e) => e.kind === 9000 || movedSource(e))).toBe(
    false,
  );
});
it("includes edits and omits deletions made while approval is pending", async () => {
  const f = fixture(),
    a = await f.client(f.alice),
    b = await f.client(f.bob);
  const id = await a.moves.start(DM, TARGET, 24);
  const first = f.events().find((e) => e.content === "First"),
    second = f.events().find((e) => e.content === "Second");
  assert.exists(first);
  assert.exists(second);
  f.emit(
    signed(f.alice, {
      kind: 40003,
      created_at: Math.floor(Date.now() / 1000),
      content: "Latest first",
      tags: [
        ["h", DM],
        ["e", first.id],
      ],
    }),
  );
  f.emit(
    signed(f.bob, {
      kind: 5,
      created_at: Math.floor(Date.now() / 1000),
      content: "",
      tags: [
        ["h", DM],
        ["e", second.id],
      ],
    }),
  );
  await b.moves.respond(id, true);
  await vi.waitFor(() =>
    expect(
      a.moves.snapshot().moves.find((m) => m.request.event.id === id)?.status,
    ).toBe("complete"),
  );
  expect(
    f.published.filter((e) => movedSource(e)).map((e) => e.content),
  ).toEqual(["Latest first"]);
});

it("lets the owner approve for a local agent and publishes its retained actual signature", async () => {
  const f = fixture(true),
    a = await f.client(f.alice),
    b = await f.client(f.bob);
  const id = await a.moves.start(DM, TARGET, 24);
  await b.moves.respond(id, true);
  await vi.waitFor(
    () =>
      expect({
        status: a.moves.snapshot().moves.find((m) => m.request.event.id === id)
          ?.status,
        errorsA: a.errors,
        errorsB: b.errors,
      }).toEqual({ status: "complete", errorsA: [], errorsB: [] }),
    { timeout: 2000 },
  );
  const copy = f.published.find(
    (e) => e.content === "Agent message" && movedSource(e),
  );
  assert.exists(copy);
  expect(copy.pubkey).toBe(f.agent.pubkey);
  expect(a.session.profiles.owner?.(copy.pubkey)).toBe(f.alice.pubkey);
  expect(
    f.published.filter((e) => moveControl(e)?.control.type === "approve"),
  ).toHaveLength(2);
});

it("recreates an unchanged uncertain human copy after the relay timestamp window expires", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const f = fixture(),
    a = await f.client(f.alice),
    b = await f.client(f.bob);
  f.script.failCopies = true;
  const id = await a.moves.start(DM, TARGET, 24);
  await b.moves.respond(id, true);
  await vi.waitFor(
    () =>
      expect(
        a.session.outbox
          ?.snapshot()
          .some(
            (item) => movedSource(item.event) && item.delivery === "unknown",
          ),
      ).toBe(true),
    { timeout: 5000 },
  );
  const previous = f.attempts.find(
    (e) => movedSource(e) && e.pubkey === f.alice.pubkey,
  );
  assert.exists(previous);
  a.dispose();
  b.dispose();
  vi.setSystemTime(Date.now() + 901000);
  f.script.failCopies = false;
  const restartedA = await f.client(f.alice, a),
    restartedB = await f.client(f.bob, b);
  await vi.waitFor(
    () =>
      expect(
        restartedA.moves.snapshot().moves.find((m) => m.request.event.id === id)
          ?.status,
      ).toBe("complete"),
    { timeout: 5000 },
  );
  const copies = f.published.filter((e) => movedSource(e));
  expect(copies).toHaveLength(2);
  const replacement = copies.find((e) => e.pubkey === f.alice.pubkey);
  assert.exists(replacement);
  expect(replacement.id).not.toBe(previous.id);
  expect(replacement.created_at).toBeGreaterThan(previous.created_at + 900);
  expect(
    restartedB.moves.snapshot().moves.find((m) => m.request.event.id === id)
      ?.status,
  ).toBe("complete");
});
