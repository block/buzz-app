import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";
import type { BuzzClient, BuzzEvent, Filter, Template } from "./client";
import { respond } from "./rpc";
import { sessionTools } from "./session-tools";
import { callSoloWorkerTool, type Clock } from "./solo-worker";
import {
  ACK_HORIZON,
  type GrantAck,
  type Intent,
  intentId,
  readRecord,
  recordTemplate,
  type Response,
} from "./solo-worker-protocol";

const key = (byte: number) => new Uint8Array(32).fill(byte);
const OWNER = key(1);
const AGENT = key(2);
const WORKER = key(3);
const RELAY = key(4);
const STRANGER = key(5);
const H = getPublicKey(OWNER);
const C = getPublicKey(AGENT);
const W = getPublicKey(WORKER);
const K = "7d3c1b52-9a0e-4f61-8d2b-3c5e6f708192";
const S = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const START = 1_790_000_000;
const ROUTE = {
  v: 1,
  owner: H,
  controller: C,
  stream: K,
  community: "wss://relay.example.com",
  device: "desk-1",
  grant: { id: "g1", revision: 3 },
} as const;
const ACK: GrantAck = {
  ...ROUTE,
  type: "grant_ack",
  workers: [W],
  operations: [
    "archive",
    "create",
    "list",
    "read",
    "readiness",
    "send",
    "stop",
  ],
  state: "active",
  issued_at: START - 100,
};

type Answer = Readonly<
  Partial<Response> & { phase: Response["phase"]; signer?: Uint8Array }
>;
/** What the owner's Buzz answers each request with, in revision order. */
type Owner = (intent: Intent, id: string) => readonly Answer[];
const ready: Owner = (intent) =>
  intent.action === "readiness"
    ? [
        {
          phase: "ready",
          result: { custody_epoch: "c7", valid_until: intent.issued_at + 30 },
        },
      ]
    : [];

/** A community holding the agent's control channel with the owner, whose
 * Buzz answers requests as `owner` says. */
function community(
  owner: Owner = ready,
  options: { roster?: string[]; ack?: GrantAck | null } = {},
) {
  let now = START;
  const clock: Clock = {
    now: () => now,
    wait: async (ms) => {
      now += ms / 1000;
    },
  };
  const events: BuzzEvent[] = [];
  const sign = (
    secret: Uint8Array,
    template: Template,
    at = Math.floor(now),
  ) => {
    const event = finalizeEvent(
      {
        ...template,
        tags: template.tags.map((tag) => [...tag]),
        created_at: at,
      },
      secret,
    );
    events.push(event);
    return event;
  };
  sign(RELAY, {
    kind: 39002,
    content: "",
    tags: [
      ["d", K],
      ...(options.roster ?? [H, C]).map((member) => [
        "p",
        member,
        "",
        "member",
      ]),
    ],
  });
  if (options.ack !== null) sign(OWNER, recordTemplate(options.ack ?? ACK));
  const published: BuzzEvent[] = [];
  const client: BuzzClient = {
    pubkey: C,
    key: C,
    relayAuthor: getPublicKey(RELAY),
    async query(filters: readonly Filter[]) {
      const [filter = {}] = filters as Record<string, unknown>[];
      const has = (
        name: string,
        values: (event: BuzzEvent) => readonly unknown[],
      ) => {
        const wanted = filter[name] as unknown[] | undefined;
        return (event: BuzzEvent) =>
          !wanted || values(event).some((value) => wanted.includes(value));
      };
      const tagged = (letter: string) => (event: BuzzEvent) =>
        event.tags.filter((tag) => tag[0] === letter).map((tag) => tag[1]);
      const checks = [
        has("kinds", (event) => [event.kind]),
        has("authors", (event) => [event.pubkey]),
        ...["h", "e", "p", "d"].map((letter) =>
          has(`#${letter}`, tagged(letter)),
        ),
      ];
      const until = filter.until as number | undefined;
      return events
        .filter((event) => checks.every((check) => check(event)))
        .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1))
        .filter(
          (event) =>
            until === undefined ||
            event.created_at < until ||
            (event.created_at === until && event.id > String(filter.before_id)),
        )
        .slice(0, filter.limit as number);
    },
    async publish(template: Template) {
      const event = sign(AGENT, template);
      published.push(event);
      const intent = readRecord(event, "request");
      if (intent) {
        const id = await intentId(intent);
        for (const [index, { signer = OWNER, ...answer }] of owner(
          intent,
          id,
        ).entries())
          sign(
            signer,
            recordTemplate(
              {
                ...ROUTE,
                type: "response",
                request: id,
                action: intent.action,
                revision: index + 1,
                observed_at: Math.floor(now),
                ...answer,
              } as Response,
              [event.id],
            ),
          );
      }
      return event;
    },
  } as unknown as BuzzClient;
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    JSON.parse(await callSoloWorkerTool(client, name, args, clock));
  const requests = () =>
    published.map((event) => readRecord(event, "request") as Intent);
  return {
    call,
    client,
    requests,
    published,
    sign,
  };
}

describe("solo_worker_connections", () => {
  it("lists the owner's acknowledged grant", async () => {
    expect(await community().call("solo_worker_connections")).toEqual({
      connections: [
        {
          owner: H,
          stream: K,
          workers: [W],
          actions: ACK.operations,
          state: "active",
        },
      ],
      complete: true,
    });
  });

  it("ignores a channel with anyone else in it", async () => {
    const { call } = community(ready, { roster: [H, C, W] });
    expect((await call("solo_worker_connections")).connections).toEqual([]);
  });

  it("ignores an acknowledgement the owner did not sign", async () => {
    const { call, sign } = community(ready, { ack: null });
    sign(AGENT, recordTemplate(ACK));
    sign(STRANGER, recordTemplate(ACK));
    expect((await call("solo_worker_connections")).connections).toEqual([]);
    await expect(call("solo_worker_readiness")).rejects.toThrow(
      /No owner has authorized you/,
    );
  });

  it("ignores a roster the relay did not sign", async () => {
    const { call, sign } = community(ready, { roster: [H, C, W] });
    sign(STRANGER, {
      kind: 39002,
      content: "",
      tags: [
        ["d", K],
        ["p", H],
        ["p", C],
      ],
    });
    expect((await call("solo_worker_connections")).connections).toEqual([]);
  });

  it("finds nothing where the relay's roster cannot be checked", async () => {
    const { client } = community();
    await expect(
      callSoloWorkerTool(
        { ...client, relayAuthor: undefined },
        "solo_worker_connections",
        {},
      ),
    ).rejects.toThrow(/cannot verify channel members/);
  });

  it("lists each owner's grant, and needs owner to choose between them", async () => {
    const { call, sign, requests } = community();
    const elsewhere = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
    const stranger = getPublicKey(STRANGER);
    sign(RELAY, {
      kind: 39002,
      content: "",
      tags: [
        ["d", elsewhere],
        ["p", stranger],
        ["p", C],
      ],
    });
    sign(
      STRANGER,
      recordTemplate({ ...ACK, owner: stranger, stream: elsewhere }),
    );
    const { connections } = await call("solo_worker_connections");
    expect(
      connections.map((found: { owner: string }) => found.owner).sort(),
    ).toEqual([H, stranger].sort());
    await expect(call("solo_worker_readiness")).rejects.toThrow(/give owner/);
    expect(requests()).toEqual([]);
    expect(await call("solo_worker_readiness", { owner: H })).toMatchObject({
      phase: "ready",
    });
    expect(requests()).toMatchObject([{ owner: H, stream: K }]);
  });

  it("reads the acknowledgement from the owner's newest events alone", async () => {
    const { call, sign } = community();
    for (let index = 0; index < ACK_HORIZON; index++)
      sign(
        OWNER,
        { kind: 9, content: `${index}`, tags: [["h", K]] },
        START + 1,
      );
    expect((await call("solo_worker_connections")).connections).toEqual([]);
    sign(OWNER, recordTemplate(ACK), START + 2);
    expect((await call("solo_worker_connections")).connections).toHaveLength(1);
  });

  it("follows the newest acknowledgement, so a revoked grant stops working", async () => {
    const { call, sign } = community();
    sign(
      OWNER,
      recordTemplate({
        ...ACK,
        state: "revoked",
        grant: { id: "g1", revision: 4 },
      }),
      START + 1,
    );
    expect((await call("solo_worker_connections")).connections[0].state).toBe(
      "revoked",
    );
    await expect(call("solo_worker_readiness")).rejects.toThrow(
      /No owner has authorized you/,
    );
  });
});

describe("a change", () => {
  it("asks for readiness, then sends the request under that custody epoch", async () => {
    const { call, requests } = community((intent) =>
      intent.action === "create"
        ? [
            { phase: "accepted" },
            { phase: "ready", result: { solo: S, worker: W, worker_epoch: 1 } },
          ]
        : ready(intent, ""),
    );
    expect(
      await call("solo_worker_create", { worker: W, title: "Fix it" }),
    ).toMatchObject({
      status: "answered",
      phase: "ready",
      result: { solo: S, worker: W, worker_epoch: 1 },
    });
    const [readiness, create] = requests();
    expect(readiness?.action).toBe("readiness");
    expect(create).toMatchObject({
      action: "create",
      custody_epoch: "c7",
      admit_before: START + 30,
      args: { worker: W, title: "Fix it" },
    });
  });

  it("sends nothing when the owner's Buzz is not ready", async () => {
    const { call, requests } = community((intent) =>
      intent.action === "readiness"
        ? [{ phase: "refused", reason: "approval_required" }]
        : [],
    );
    expect(
      await call("solo_worker_send", { solo: S, worker_epoch: 1, text: "go" }),
    ).toMatchObject({
      status: "answered",
      phase: "refused",
      reason: "approval_required",
    });
    expect(requests().map((intent) => intent.action)).toEqual(["readiness"]);
  });

  it("refuses a worker or action the owner did not allow, before asking", async () => {
    const { call, requests } = community(ready, {
      ack: { ...ACK, operations: ["read", "readiness"] },
    });
    await expect(
      call("solo_worker_create", { worker: getPublicKey(STRANGER) }),
    ).rejects.toThrow(/not allowed solo_worker_create/);
    await expect(
      call("solo_worker_stop", { solo: S, worker_epoch: 1 }),
    ).rejects.toThrow(/not allowed/);
    expect(requests()).toEqual([]);
  });

  it("names a missing worker rather than refusing it", async () => {
    const { call, requests } = community();
    await expect(call("solo_worker_create")).rejects.toThrow(/args\.worker/);
    expect(requests().map((request) => request.action)).toEqual(["readiness"]);
  });

  it("returns a pending request to retry, and a retry sends it unchanged", async () => {
    let settle = false;
    const { call, requests, published } = community((intent) =>
      intent.action === "send"
        ? settle
          ? [{ phase: "running" }, { phase: "settled", result: {} }]
          : [{ phase: "accepted" }]
        : ready(intent, ""),
    );
    const first = await call("solo_worker_send", {
      solo: S,
      worker_epoch: 1,
      text: "go",
    });
    expect(first).toMatchObject({ status: "pending", phase: "accepted" });
    expect(first.retry).toEqual(requests()[1]);
    settle = true;
    expect(
      await call("solo_worker_send", { retry: first.retry }),
    ).toMatchObject({
      status: "answered",
      request: first.request,
      phase: "settled",
    });
    expect(published.at(-1)?.content).toBe(published[1]?.content);
    expect(
      requests().filter((intent) => intent.action === "readiness"),
    ).toHaveLength(1);
  });

  it("returns an unsent request to retry when posting fails", async () => {
    const harness = community();
    const { call } = harness;
    const original = harness.client.publish;
    let calls = 0;
    harness.client.publish = (template) =>
      ++calls === 2
        ? Promise.reject(new Error("socket closed"))
        : original(template);
    const answer = await call("solo_worker_archive", { solo: S });
    expect(answer).toMatchObject({
      status: "unsent",
      retry: { action: "archive", args: { solo: S } },
    });
    expect(answer.note).toMatch(/may still have arrived/);
  });

  it("keeps a sent request to retry when checking for its answer fails", async () => {
    const harness = community();
    const original = harness.client.query;
    harness.client.query = (filters) =>
      harness.published.length === 2
        ? Promise.reject(new Error("offline"))
        : original(filters);
    const answer = await harness.call("solo_worker_archive", { solo: S });
    expect(answer).toMatchObject({
      status: "pending",
      retry: { action: "archive", args: { solo: S } },
    });
    expect(answer.note).toMatch(/was sent and may have run/);
  });

  it("refuses a retry with other arguments, or for another tool or agent", async () => {
    const { call } = community();
    const retry = {
      ...ROUTE,
      type: "request",
      action: "stop",
      nonce: "0".repeat(32),
      issued_at: START,
      admit_before: START + 60,
      custody_epoch: "c7",
      args: { solo: S, worker_epoch: 1 },
    };
    await expect(call("solo_worker_stop", { retry, solo: S })).rejects.toThrow(
      /on its own/,
    );
    await expect(call("solo_worker_archive", { retry })).rejects.toThrow(
      /not a solo_worker_archive request/,
    );
    await expect(
      call("solo_worker_stop", {
        retry: { ...retry, controller: getPublicKey(STRANGER) },
      }),
    ).rejects.toThrow(/request of yours/);
    await expect(
      call("solo_worker_stop", { retry: { ...retry, args: { solo: S } } }),
    ).rejects.toThrow(/worker_epoch is required/);
  });
});

describe("answers", () => {
  const settled = {
    phase: "settled",
    result: { workers: [], complete: true },
  } as const;

  it("count only when the owner signs them for this exact request", async () => {
    const { call } = community((intent) =>
      intent.action === "list"
        ? [
            { ...settled, device: "desk-2" },
            { ...settled, grant: { id: "g1", revision: 4 } },
            { ...settled, signer: STRANGER },
            { ...settled, signer: AGENT },
          ]
        : [],
    );
    const answer = await call("solo_worker_list");
    expect(answer).toMatchObject({ status: "pending" });
    expect(answer.note).toMatch(/may be closed/);
    expect(answer.retry).toBeUndefined();
  });

  it("report two different answers at one revision as uncertain", async () => {
    const { call } = community((intent) =>
      intent.action === "list"
        ? [
            { ...settled, revision: 1 },
            {
              phase: "settled",
              revision: 1,
              result: { workers: [], complete: false },
            },
          ]
        : [],
    );
    expect(await call("solo_worker_list")).toMatchObject({
      status: "answered",
      phase: "uncertain",
      reason: "conflict",
    });
  });
});

describe("solo_worker_read", () => {
  it("shows the Solo's messages from the worker and those the owner relayed", async () => {
    const harness = community((intent) => {
      if (intent.action !== "read") return [];
      const tags = [["h", S]];
      const worker = finalizeEvent(
        { kind: 9, content: "done", tags, created_at: START },
        WORKER,
      );
      const relayed = finalizeEvent(
        {
          kind: 9,
          content: "next",
          tags: [...tags, ["control", "solo_worker", "1", "relay"]],
          created_at: START + 1,
        },
        OWNER,
      );
      return [
        {
          phase: "running",
          result: {
            worker: W,
            state: "running",
            worker_epoch: 1,
            events: [relayed, worker],
            complete: true,
          },
        },
      ];
    });
    const answer = await harness.call("solo_worker_read", { solo: S });
    expect(answer.result.messages).toEqual([
      expect.objectContaining({ from: "worker", text: "done" }),
      expect.objectContaining({ from: "you", text: "next" }),
    ]);
    expect(harness.requests()[0]?.args).toEqual({ solo: S, limit: 20 });
  });
});

describe("registration", () => {
  it("lists every Solo worker tool on search, with write annotations", () => {
    const tools = sessionTools().filter((tool) =>
      tool.name.startsWith("solo_worker_"),
    );
    expect(tools.map((tool) => [tool.name, tool.load])).toEqual(
      [
        "connections",
        "readiness",
        "create",
        "send",
        "read",
        "stop",
        "archive",
        "list",
      ].map((name) => [`solo_worker_${name}`, "search"]),
    );
    const annotations = Object.fromEntries(
      tools.map((tool) => [
        tool.name,
        (tool as unknown as { annotations: object }).annotations,
      ]),
    );
    expect(annotations.solo_worker_read).toEqual({ readOnlyHint: true });
    expect(annotations.solo_worker_stop).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
    });
  });

  it("answers a session's call", async () => {
    const { client } = community();
    const reply = (await respond(
      client,
      {},
      {
        id: 1,
        method: "tools/call",
        params: { name: "solo_worker_connections", arguments: {} },
      },
    )) as { result: { content: { text: string }[] } };
    expect(
      JSON.parse(reply.result.content[0]?.text ?? "").connections,
    ).toHaveLength(1);
  });

  it("refuses arguments a tool does not list", async () => {
    await expect(
      community().call("solo_worker_read", { solo: S, channel: K }),
    ).rejects.toThrow(/channel cannot be used/);
  });
});
