import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "nostr-tools/utils";
import { describe, expect, it, vi } from "vitest";
import type { EventData, ReadFilter, RelayEvent } from "./events";
import type { Outbox, OutgoingEvent } from "./outbox";
import type { ProfileQueries } from "./profile-directory";
import type { RelayReader } from "./reader";
import { SessionControls } from "../agent-harness/session-control";
import { keypair, signed, type Key } from "./testing";
import {
  createThreadGovernance,
  foldThreadGovernance,
  THREAD_GOVERNANCE_KIND,
} from "./thread-governance";

const agent = "a".repeat(64);
const owner = "b".repeat(64);
const channel = "11111111-1111-4111-8111-111111111111";
const rootA = "d".repeat(64);
const rootB = "e".repeat(64);

function authTag(agentKey: Key, ownerKey: Key) {
  const digest = createHash("sha256")
    .update(`nostr:agent-auth:${agentKey.pubkey}:`)
    .digest();
  return [
    "auth",
    ownerKey.pubkey,
    "",
    bytesToHex(schnorr.sign(new Uint8Array(digest), ownerKey.secret)),
  ];
}

function event(
  id: number,
  input: Partial<EventData> & Pick<EventData, "kind" | "tags">,
): EventData {
  return {
    id: id.toString(16).padStart(64, "0"),
    pubkey: agent,
    created_at: id,
    content: "",
    ...input,
  };
}

function completion(id: number, root = rootA) {
  return event(id, {
    kind: THREAD_GOVERNANCE_KIND,
    pubkey: owner,
    content: JSON.stringify({ version: 1, agent }),
    tags: [
      ["h", channel],
      ["e", root, "", "root"],
      ["type", "buzz.thread-governance/v1"],
      ["action", "completed"],
    ],
  });
}

function approval(
  relay: Key,
  roles: readonly (readonly [string, "owner" | "admin"])[],
  createdAt = 1,
) {
  return signed(relay, {
    kind: 39001,
    content: "",
    created_at: createdAt,
    tags: [
      ["d", channel],
      ...roles.map(([pubkey, role]) => ["p", pubkey, role]),
    ],
  });
}

function control(
  id: number,
  actor: string,
  action: "extend" | "scope-change" | "closed" | "defer",
  authority: RelayEvent,
  body: Record<string, unknown> = {},
) {
  return event(id, {
    kind: THREAD_GOVERNANCE_KIND,
    pubkey: actor,
    content: JSON.stringify({ version: 1, approval: authority, ...body }),
    tags: [
      ["h", channel],
      ["e", rootA, "", "root"],
      ["type", "buzz.thread-governance/v1"],
      ["action", action],
    ],
  });
}

describe("thread governance fold", () => {
  it("counts only owner-attested agents and applies the specified resets", () => {
    const declaredOnly = "f".repeat(64);
    const human = "1".repeat(64);
    const events = [
      completion(1),
      { ...completion(2), pubkey: declaredOnly },
      event(3, {
        kind: 9,
        pubkey: human,
        content: "Human decision",
        tags: [
          ["h", channel],
          ["e", rootA, "", "reply"],
        ],
      }),
      completion(4),
      event(5, {
        kind: 40002,
        content: JSON.stringify({ content: "[BLOCKER] Need approval" }),
        tags: [
          ["h", channel],
          ["e", rootA, "", "reply"],
        ],
      }),
      completion(6),
    ];
    const state = foldThreadGovernance(
      { channelId: channel, root: rootA },
      events,
      (pubkey) => (pubkey === agent ? owner : undefined),
    );
    expect(state.count).toBe(1);
    expect(state.resets.map(({ action }) => action)).toEqual([
      "human",
      "blocker-open",
    ]);
  });

  it("keeps approvals durable across demotion without activating old records after promotion", () => {
    const relay = keypair();
    const formerLead = "2".repeat(64);
    const futureLead = "3".repeat(64);
    const approved = approval(relay, [[formerLead, "admin"]]);
    const demoted = approval(relay, [], 10);
    const promoted = approval(relay, [[futureLead, "admin"]], 11);
    const events = [
      control(2, formerLead, "extend", approved, {
        reason: "Approved before demotion",
        threshold: 20,
      }),
      control(3, futureLead, "closed", approved),
      demoted,
      promoted,
    ];

    const state = foldThreadGovernance(
      { channelId: channel, root: rootA },
      events,
      () => undefined,
      relay.pubkey,
    );
    expect(state.threshold).toBe(20);
    expect(state.extensions).toEqual([
      expect.objectContaining({
        by: formerLead,
        reason: "Approved before demotion",
        threshold: 20,
      }),
    ]);
    expect(state.closed).toBe(false);
  });

  it("rejects a stale administrator head after the approver was demoted", () => {
    const relay = keypair();
    const administrator = keypair();
    const formerLead = keypair();
    const approved = approval(relay, [[formerLead.pubkey, "admin"]]);
    const demotion = signed(administrator, {
      kind: 9001,
      content: "",
      created_at: 10,
      tags: [
        ["h", channel],
        ["p", formerLead.pubkey],
      ],
    });
    // The relay has since replaced its demotion snapshot with this later head.
    // The immutable accepted moderation event must still retire `approved`.
    const repromoted = approval(relay, [[formerLead.pubkey, "admin"]], 20);
    const events = [
      control(2, formerLead.pubkey, "extend", approved, {
        reason: "Approved before demotion",
        threshold: 20,
      }),
      demotion,
      control(15, formerLead.pubkey, "extend", approved, {
        reason: "Reused after demotion",
        threshold: 30,
      }),
      repromoted,
    ];

    const state = foldThreadGovernance(
      { channelId: channel, root: rootA },
      events,
      () => undefined,
      relay.pubkey,
    );
    expect(state.threshold).toBe(20);
    expect(state.extensions).toHaveLength(1);
    expect(state.extensions[0]).toMatchObject({
      by: formerLead.pubkey,
      reason: "Approved before demotion",
    });
  });

  it("does not retire an approval for role-preserving member commands", () => {
    const relay = keypair();
    const administrator = keypair();
    const lead = keypair();
    const approved = approval(relay, [[lead.pubkey, "admin"]]);
    const preserving = (createdAt: number, tags: string[][]) =>
      signed(administrator, {
        kind: 9000,
        content: "",
        created_at: createdAt,
        tags: [["h", channel], ...tags],
      });
    const events = [
      preserving(10, [["p", lead.pubkey]]),
      preserving(11, [
        ["p", lead.pubkey],
        ["role", "admin"],
      ]),
      preserving(12, [["p", lead.pubkey, "admin"]]),
      control(15, lead.pubkey, "extend", approved, {
        reason: "Role stayed admin",
        threshold: 20,
      }),
    ];

    const state = foldThreadGovernance(
      { channelId: channel, root: rootA },
      events,
      () => undefined,
      relay.pubkey,
    );
    expect(state.threshold).toBe(20);
    expect(state.extensions).toHaveLength(1);
  });
});

function harness(relay: EventData[] = []) {
  let sequence = relay.length + 100;
  let pending: OutgoingEvent[] = [];
  const listeners = new Set<() => void>();
  const outbox = {
    supports: (kind: number) => kind === THREAD_GOVERNANCE_KIND,
    snapshot: () => pending,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    send(input: Pick<EventData, "kind" | "content" | "tags">) {
      const sent = event(sequence++, { ...input, pubkey: owner });
      relay.push(sent);
      pending = [...pending, { event: sent, delivery: "sending" as const }];
      for (const listener of listeners) listener();
      return sent.id;
    },
  } as Pick<Outbox, "supports" | "snapshot" | "subscribe" | "send"> as Outbox;
  const reader = {
    read: async () => relay as unknown as readonly RelayEvent[],
  } as RelayReader;
  const profiles = {
    snapshot: () => new Map(),
    subscribe: () => () => {},
    ensure: async () => {},
    owner: (pubkey: string) => (pubkey === agent ? owner : undefined),
  } as ProfileQueries;
  const capability = createThreadGovernance({
    reader,
    outbox,
    profiles,
    viewer: agent,
    canManage: () => false,
    receive: () => () => {},
  });
  return { capability, relay };
}

function pagedReader(events: readonly EventData[]) {
  const read = vi.fn(async (filters: readonly ReadFilter[]) => {
    const matches = (item: EventData, filter: ReadFilter) =>
      (!filter.kinds || filter.kinds.includes(item.kind)) &&
      (!filter.ids || filter.ids.includes(item.id)) &&
      (!filter.authors || filter.authors.includes(item.pubkey)) &&
      Object.entries(filter).every(([name, values]) => {
        if (!name.startsWith("#") || !Array.isArray(values)) return true;
        return item.tags.some(
          ([key, value]) => key === name.slice(1) && values.includes(value),
        );
      }) &&
      (filter.until === undefined ||
        item.created_at < filter.until ||
        (item.created_at === filter.until &&
          (!filter.before_id || item.id > filter.before_id)));
    return filters.flatMap((filter) =>
      events
        .filter((item) => matches(item, filter))
        .sort(
          (a, b) =>
            b.created_at - a.created_at ||
            (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        )
        .slice(0, filter.limit),
    ) as unknown as readonly RelayEvent[];
  });
  return { read } as Pick<RelayReader, "read"> as RelayReader;
}

function viewHarness(
  events: readonly EventData[],
  profiles: ProfileQueries = {
    snapshot: () => new Map(),
    subscribe: () => () => {},
    ensure: async () => {},
    owner: (pubkey: string) => (pubkey === agent ? owner : undefined),
  },
  relayAuthor?: string,
) {
  const reader = pagedReader(events);
  const capability = createThreadGovernance({
    reader,
    profiles,
    viewer: owner,
    ...(relayAuthor ? { relayAuthor } : {}),
    canManage: () => false,
    receive: () => () => {},
  });
  const view = capability.view({ channelId: channel, root: rootA });
  return { capability, reader, view };
}

it("embeds the current relay-signed approval in management records", async () => {
  const relay = keypair();
  const authority = approval(relay, [[owner, "owner"]]);
  let sent: EventData | undefined;
  const outbox = {
    supports: (kind: number) => kind === THREAD_GOVERNANCE_KIND,
    snapshot: () => [],
    subscribe: () => () => {},
    send(input: Pick<EventData, "kind" | "content" | "tags">) {
      sent = event(20, { ...input, pubkey: owner });
      return sent.id;
    },
  } as Pick<Outbox, "supports" | "snapshot" | "subscribe" | "send"> as Outbox;
  const capability = createThreadGovernance({
    reader: pagedReader([authority]),
    outbox,
    profiles: {
      snapshot: () => new Map(),
      subscribe: () => () => {},
      ensure: async () => {},
    },
    viewer: owner,
    relayAuthor: relay.pubkey,
    canManage: () => true,
    receive: () => () => {},
  });

  await capability.act({ channelId: channel, root: rootA }, "extend", {
    reason: "Approved",
    threshold: 20,
  });
  expect(JSON.parse(sent?.content ?? "{}").approval).toMatchObject({
    id: authority.id,
    sig: authority.sig,
  });
  expect(
    foldThreadGovernance(
      { channelId: channel, root: rootA },
      sent ? [sent] : [],
      () => undefined,
      relay.pubkey,
    ),
  ).toMatchObject({ threshold: 20, tripped: false });
  capability.dispose();
});

it("isolates tripped source threads sharing one session and survives reload", async () => {
  const first = harness();
  const sourceA = { channelId: channel, root: rootA };
  const sourceB = { channelId: channel, root: rootB };
  const controls = new SessionControls(() => {});
  let releaseRunningA!: () => void;
  let markRunningAStarted!: () => void;
  const runningAReleased = new Promise<void>((resolve) => {
    releaseRunningA = resolve;
  });
  const runningAStarted = new Promise<void>((resolve) => {
    markRunningAStarted = resolve;
  });

  // A and B use the same native session control key. This A turn crosses the
  // final handoff seam before the trip and remains active while later work arrives.
  const alreadyRunningA = controls.deliver(
    "shared-native-session",
    async () => {
      const admitted = await first.capability.admit(
        sourceA,
        agent,
        new AbortController().signal,
      );
      markRunningAStarted();
      await runningAReleased;
      admitted.completed();
    },
  );
  await runningAStarted;
  for (let turn = 0; turn < 10; turn++) {
    const admitted = await first.capability.admit(
      sourceA,
      agent,
      new AbortController().signal,
    );
    admitted.completed();
  }

  const pausedA = controls.deliver("shared-native-session", async () => {
    await first.capability.admit(sourceA, agent, new AbortController().signal);
  });
  await expect(pausedA.done).rejects.toThrow(
    "Thread turn budget reached (10/10)",
  );
  const startingB = controls.deliver("shared-native-session", async () => {
    await first.capability.admit(sourceB, agent, new AbortController().signal);
  });
  await expect(startingB.done).resolves.toBeUndefined();

  // It completes normally after the trip: no interrupt, abort, or queue clear.
  releaseRunningA();
  await expect(alreadyRunningA.done).resolves.toBeUndefined();
  first.capability.dispose();

  const restored = harness(first.relay);
  await expect(
    restored.capability.admit(sourceA, agent, new AbortController().signal),
  ).rejects.toThrow("Thread turn budget reached (11/10)");
  await expect(
    restored.capability.admit(sourceB, agent, new AbortController().signal),
  ).resolves.toBeDefined();
  restored.capability.dispose();
});

it("pages the complete governance history so an old extension survives reload", async () => {
  const relay = keypair();
  const authority = approval(relay, [[owner, "owner"]]);
  const events = [
    control(1, owner, "extend", authority, {
      reason: "Long-running approved thread",
      threshold: 600,
    }),
    ...Array.from({ length: 500 }, (_, index) => completion(index + 2)),
  ];
  const { capability, reader, view } = viewHarness(
    events,
    undefined,
    relay.pubkey,
  );

  await view.refresh();
  expect(view.snapshot()).toMatchObject({
    count: 500,
    threshold: 600,
    tripped: false,
  });
  expect(view.snapshot().extensions).toHaveLength(1);
  expect(
    vi
      .mocked(reader.read)
      .mock.calls.some(([filters]) => filters[0]?.before_id !== undefined),
  ).toBe(true);
  view.dispose();
  capability.dispose();
});

it("pages the complete message history so an old human reset survives reload", async () => {
  const human = "4".repeat(64);
  const events = [
    ...Array.from({ length: 5 }, (_, index) => completion(index + 1)),
    event(6, {
      kind: 9,
      pubkey: human,
      content: "Reset the thread",
      tags: [
        ["h", channel],
        ["e", rootA, "", "reply"],
      ],
    }),
    ...Array.from({ length: 500 }, (_, index) =>
      event(index + 7, {
        kind: 9,
        pubkey: agent,
        content: `Agent note ${index}`,
        tags: [
          ["h", channel],
          ["e", rootA, "", "reply"],
        ],
      }),
    ),
  ];
  const { capability, view } = viewHarness(events);

  await view.refresh();
  expect(view.snapshot().count).toBe(0);
  expect(view.snapshot().resets).toContainEqual(
    expect.objectContaining({ action: "human", by: human }),
  );
  view.dispose();
  capability.dispose();
});

it("pages accepted role changes so an old demotion retires a stale approval", async () => {
  const relay = keypair();
  const administrator = keypair();
  const formerLead = keypair();
  const approved = approval(relay, [[formerLead.pubkey, "admin"]]);
  const roleChange = (createdAt: number, target: string) =>
    signed(administrator, {
      kind: 9000,
      content: "",
      created_at: createdAt,
      tags: [
        ["h", channel],
        ["p", target],
      ],
    });
  const events = [
    signed(administrator, {
      kind: 9001,
      content: "",
      created_at: 10,
      tags: [
        ["h", channel],
        ["p", formerLead.pubkey],
      ],
    }),
    ...Array.from({ length: 500 }, (_, index) =>
      roleChange(index + 11, "5".repeat(64)),
    ),
    control(600, formerLead.pubkey, "extend", approved, {
      reason: "Stale after demotion",
      threshold: 30,
    }),
    approval(relay, [[formerLead.pubkey, "admin"]], 700),
  ];
  const { capability, reader, view } = viewHarness(
    events,
    undefined,
    relay.pubkey,
  );

  await view.refresh();
  expect(view.snapshot()).toMatchObject({ threshold: 10, tripped: false });
  expect(view.snapshot().extensions).toHaveLength(0);
  expect(
    vi
      .mocked(reader.read)
      .mock.calls.some(
        ([filters]) =>
          filters[0]?.kinds?.includes(9000) &&
          filters[0]?.before_id !== undefined,
      ),
  ).toBe(true);
  view.dispose();
  capability.dispose();
});

it("drops cached ownership as soon as a newer profile revokes auth", async () => {
  const agentKey = keypair();
  const ownerKey = keypair();
  const attested = signed(agentKey, {
    kind: 0,
    content: "{}",
    created_at: 1,
    tags: [authTag(agentKey, ownerKey)],
  });
  const revoked = signed(agentKey, {
    kind: 0,
    content: "{}",
    created_at: 2,
    tags: [],
  });
  let head = attested;
  let currentOwner: string | undefined = ownerKey.pubkey;
  const listeners = new Set<() => void>();
  const profiles: ProfileQueries = {
    snapshot: () => new Map(),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ensure: async () => {},
    event: (pubkey) => (pubkey === agentKey.pubkey ? head : undefined),
    owner: (pubkey) => (pubkey === agentKey.pubkey ? currentOwner : undefined),
  };
  const completed = {
    ...completion(1),
    pubkey: ownerKey.pubkey,
    content: JSON.stringify({ version: 1, agent: agentKey.pubkey }),
  };
  const { capability, view } = viewHarness([completed], profiles);

  await view.refresh();
  expect(view.snapshot().count).toBe(1);
  head = revoked;
  currentOwner = undefined;
  for (const listener of listeners) listener();
  expect(view.snapshot().count).toBe(0);
  view.dispose();
  capability.dispose();
});

it("does not install an attestation whose profile head was superseded while verifying", async () => {
  const agentKey = keypair();
  const ownerKey = keypair();
  const attested = signed(agentKey, {
    kind: 0,
    content: "{}",
    created_at: 1,
    tags: [authTag(agentKey, ownerKey)],
  });
  const revoked = signed(agentKey, {
    kind: 0,
    content: "{}",
    created_at: 2,
    tags: [],
  });
  let head = attested;
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const digestStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  const spy = vi
    .spyOn(crypto.subtle, "digest")
    .mockImplementation(async (...args: Parameters<SubtleCrypto["digest"]>) => {
      started();
      await held;
      return digest(...args);
    });
  const profiles: ProfileQueries = {
    snapshot: () => new Map(),
    subscribe: () => () => {},
    ensure: async () => {},
    event: (pubkey) => (pubkey === agentKey.pubkey ? head : undefined),
    owner: () => undefined,
  };
  const completed = {
    ...completion(1),
    pubkey: ownerKey.pubkey,
    content: JSON.stringify({ version: 1, agent: agentKey.pubkey }),
  };
  const { capability, view } = viewHarness([completed], profiles);

  try {
    const refreshing = view.refresh();
    await digestStarted;
    head = revoked;
    release();
    await refreshing;
    expect(view.snapshot().count).toBe(0);
  } finally {
    spy.mockRestore();
    view.dispose();
    capability.dispose();
  }
});
