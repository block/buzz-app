import { afterEach, assert, expect, it, vi } from "vitest";
import {
  connectBrokerTransport,
  connectSignedTransport,
} from "../relay/transport";
import { keypair, signed } from "../relay/testing";
import { workflowLifecycleVersion } from "./compatibility";
const origin = "https://workflow-compat.test";
const key = keypair();
const info = {
  self: key.pubkey,
  supported_extensions: ["buzz-workflows"],
  workflows: { lifecycle: 1, host: "workflow-compat.test" },
};
const invalid = [
  null,
  {},
  { ...info, self: undefined, pubkey: key.pubkey },
  { ...info, self: "b".repeat(64) },
  { ...info, supported_extensions: [] },
  { ...info, workflows: undefined },
  ...[0, 2, "1", true, null].map((lifecycle) => ({
    ...info,
    workflows: { ...info.workflows, lifecycle },
  })),
  ...[
    "other.test",
    "workflow-compat.test:443",
    "workflow-compat.test:1234",
    "https://workflow-compat.test",
    "workflow-compat.test/path",
  ].map((host) => ({ ...info, workflows: { ...info.workflows, host } })),
];
afterEach(() => vi.unstubAllGlobals());
it("requires explicit version, extension, self and exact normalized host", () => {
  expect(workflowLifecycleVersion(info, origin, key.pubkey)).toBe(1);
  expect(
    workflowLifecycleVersion(info, "wss://WORKFLOW-COMPAT.test./", key.pubkey),
  ).toBe(1);
  for (const data of invalid)
    expect(workflowLifecycleVersion(data, origin, key.pubkey)).toBeUndefined();
});
it.each([info, ...invalid])(
  "real broker session projects only verified compatibility %#",
  async (workflowInfo) => {
    vi.stubGlobal("fetch", async () =>
      Response.json({
        viewer: key.pubkey,
        relayAuthor: key.pubkey,
        relayUrl: origin,
        workflowReads: true,
        workflowInfo,
        writeKinds: [9, 30620, 46020, 5],
      }),
    );
    const transport = await connectBrokerTransport();
    expect(transport.workflows?.lifecycleVersion).toBe(
      workflowInfo === info ? 1 : undefined,
    );
  },
);
it.each([info, ...invalid])(
  "signed host discovers against its own origin without signing or forwarding identity %#",
  async (metadata) => {
    const fetcher = vi.fn(async () => Response.json(metadata));
    const signEvent = vi.fn(async (t: Parameters<typeof signed>[1]) =>
      signed(key, t),
    );
    vi.stubGlobal("fetch", fetcher);
    const transport = await connectSignedTransport(
      { getPublicKey: async () => key.pubkey, signEvent },
      origin,
      key.pubkey,
    );
    expect(transport.workflows?.lifecycleVersion).toBe(
      metadata === info ? 1 : undefined,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]).toEqual([
      origin,
      {
        headers: { Accept: "application/nostr+json" },
        redirect: "error",
        credentials: "omit",
        signal: expect.any(AbortSignal),
      },
    ]);
    expect(signEvent).not.toHaveBeenCalled();
  },
);
it("metadata failure, malformed JSON and reconnect downgrade keep signed host reads available, writes off", async () => {
  for (const result of [
    new Response("bad json"),
    new Response("", { status: 503 }),
    new Error("offline"),
  ]) {
    vi.stubGlobal("fetch", async () => {
      if (result instanceof Error) throw result;
      return result;
    });
    const transport = await connectSignedTransport(
      {
        getPublicKey: async () => key.pubkey,
        signEvent: async (t) => signed(key, t),
      },
      origin,
      key.pubkey,
    );
    expect(transport.workflows?.lifecycleVersion).toBeUndefined();
    expect(transport.workflows?.runs).toBeTypeOf("function");
  }
});
it("direct signer checks real metadata again at both signing and publishing, preserving exact event and receipt", async () => {
  let compatible = true;
  const calls: string[] = [];
  const signEvent = vi.fn(async (t: Parameters<typeof signed>[1]) =>
    signed(key, t),
  );
  const template = {
    kind: 46020,
    created_at: 1,
    content: "",
    tags: [
      ["h", "11111111-1111-4111-8111-111111111111"],
      ["d", "22222222-2222-4222-8222-222222222222"],
    ],
  };
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (url === origin)
      return Response.json(compatible ? info : { self: key.pubkey });
    calls.push(url);
    expect(init?.body).toBe(JSON.stringify(event));
    return Response.json({
      accepted: true,
      event_id: event.id,
      message: "run-result",
    });
  });
  const t = await connectSignedTransport(
    { getPublicKey: async () => key.pubkey, signEvent },
    origin,
    key.pubkey,
  );
  assert.exists(t.writer);
  const event = await t.writer.sign(template, new AbortController().signal);
  expect(event.kind).toBe(46020);
  expect(await t.writer.publish(event, new AbortController().signal)).toBe(
    "run-result",
  );
  expect(calls).toEqual([`${origin}/events`]);
  compatible = false;
  signEvent.mockClear();
  await expect(
    t.writer.sign(template, new AbortController().signal),
  ).rejects.toThrow("unavailable");
  await expect(
    t.writer.publish(event, new AbortController().signal),
  ).rejects.toThrow("unavailable");
  expect(signEvent).not.toHaveBeenCalled();
  expect(calls).toHaveLength(1);
});
it("positive metadata alone cannot authorize invalid direct workflow commands", async () => {
  const signEvent = vi.fn(async (t: Parameters<typeof signed>[1]) =>
    signed(key, t),
  );
  const fetcher = vi.fn(async () => Response.json(info));
  vi.stubGlobal("fetch", fetcher);
  const t = await connectSignedTransport(
    { getPublicKey: async () => key.pubkey, signEvent },
    origin,
    key.pubkey,
  );
  assert.exists(t.writer);
  await expect(
    t.writer.sign(
      { kind: 30620, created_at: 1, content: "invalid", tags: [] },
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  expect(signEvent).not.toHaveBeenCalled();
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it.each(
  [false, true].flatMap((compatible) =>
    ["030620", "+30620", "+00030620"].flatMap((alias) =>
      ["sign", "publish"].map((operation) => ({
        compatible,
        alias,
        operation,
      })),
    ),
  ),
)(
  "signed host rejects $alias at $operation with compatibility=$compatible",
  async ({ compatible, alias, operation }) => {
    const signEvent = vi.fn(async (t: Parameters<typeof signed>[1]) =>
      signed(key, t),
    );
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url === origin)
        return Response.json(compatible ? info : { self: key.pubkey });
      calls.push(url);
      const event = JSON.parse(String(init?.body));
      return Response.json({
        accepted: true,
        event_id: event.id,
        message: "accepted",
      });
    });
    const t = await connectSignedTransport(
      { getPublicKey: async () => key.pubkey, signEvent },
      origin,
      key.pubkey,
    );
    assert.exists(t.writer);
    const input = {
      kind: 5,
      created_at: 1,
      content: "",
      tags: [
        ["h", "11111111-1111-4111-8111-111111111111"],
        ["a", `${alias}:${key.pubkey}:22222222-2222-4222-8222-222222222222`],
      ],
    };
    await expect(
      operation === "sign"
        ? t.writer.sign(input, new AbortController().signal)
        : t.writer.publish(signed(key, input), new AbortController().signal),
    ).rejects.toThrow();
    expect(signEvent).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  },
);
it.each([false, true])(
  "unrelated deletes retain signed host behavior with compatibility=%s",
  async (compatible) => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url === origin)
        return Response.json(compatible ? info : { self: key.pubkey });
      calls.push(url);
      const event = JSON.parse(String(init?.body));
      return Response.json({
        accepted: true,
        event_id: event.id,
        message: "accepted",
      });
    });
    const t = await connectSignedTransport(
      {
        getPublicKey: async () => key.pubkey,
        signEvent: async (t) => signed(key, t),
      },
      origin,
      key.pubkey,
    );
    assert.exists(t.writer);
    for (const target of [
      ["e", "b".repeat(64)],
      ["a", `030000:${key.pubkey}:other`],
    ]) {
      const event = await t.writer.sign(
        { kind: 5, created_at: 1, content: "", tags: [target] },
        new AbortController().signal,
      );
      await t.writer.publish(event, new AbortController().signal);
    }
    expect(calls).toEqual([`${origin}/events`, `${origin}/events`]);
  },
);
