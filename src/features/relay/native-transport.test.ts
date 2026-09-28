import { afterEach, expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import {
  nativeTransport,
  type NativeRelayHost,
  type NativeAccount,
} from "./native-transport";
import { createAccountConnection } from "../communities/account-connection";
import { createCommunities } from "../communities/service";
import { createRelaySession } from "./session";
import { PublishRejected } from "./outbox";
import { keypair, metadata, roster, signed } from "./testing";
import type { ReadFilter, RelayEvent } from "./events";
// Only browser persistence is substituted; actual community/session/outbox runs.
vi.mock("./outbox-storage", () => ({
  browserOutboxStorage: () => ({ load: () => [], save: () => {} }),
}));
const roots: Context[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await root.fiber.dispose();
  vi.unstubAllGlobals();
});
function fixture() {
  const viewer = keypair(),
    relay = keypair(),
    peer = keypair();
  const account: NativeAccount = {
    viewer: viewer.pubkey,
    origin: "https://relay.example",
    relayAuthor: relay.pubkey,
    archiveAuthority: relay.pubkey,
    lease: "11111111-1111-4111-8111-111111111111",
  };
  let members = [viewer.pubkey, peer.pubkey],
    generation = 1700000000;
  let serial = 0;
  const publications: RelayEvent[] = [];
  const order: string[] = [];
  const host: NativeRelayHost = {
    begin: vi.fn(async () => `operation-${++serial}`),
    cancel: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    run: vi.fn<NativeRelayHost["run"]>(async (lease, _id, op) => {
      expect(lease).toBe(account.lease);
      order.push(op.kind);
      if (op.kind === "sign")
        return { kind: "signed", value: signed(viewer, op.value) };
      if (op.kind === "publish") {
        publications.push(op.value);
        return {
          kind: "response",
          value: {
            status: 200,
            body: JSON.stringify({ accepted: true, event_id: op.value.id }),
          },
        };
      }
      const filters = op.value as ReadFilter[];
      const events = filters.flatMap((f) =>
        f.ids
          ? publications.filter((e) => f.ids?.includes(e.id))
          : [
              ...(f.kinds?.includes(39000)
                ? [metadata(relay, "c", "General", generation)]
                : []),
              ...(f.kinds?.includes(39002)
                ? [roster(relay, "c", members, generation)]
                : []),
            ],
      );
      return {
        kind: "response",
        value: { status: 200, body: JSON.stringify(events) },
      };
    }),
  };
  return {
    account,
    host,
    publications,
    order,
    peer,
    removePeer() {
      members = [viewer.pubkey];
      generation++;
    },
  };
}
it("native adapter and actual session preserve mention preflight, exact reply tags and rejected membership", async () => {
  const f = fixture();
  const transport = nativeTransport(f.account, f.host);
  const owner = createRelaySession(transport, {
    outboxStorage: { load: () => [], save: () => {} },
  });
  try {
    await owner.session.read([
      { kinds: [39000, 39002], "#d": ["c"], limit: 10 },
    ]);
    expect(owner.session.outbox?.supports(9)).toBe(true);
    expect(owner.session.outbox?.supports(7)).toBe(false);
    expect(owner.session.live.snapshot().status).toBe("unavailable");
    expect(owner.session.agentActivity.snapshot().status).toBe("unavailable");
    const id = owner.session.messages.send("c", "Hello", [f.peer.pubkey]);
    await vi.waitFor(() => expect(f.publications).toHaveLength(1));
    expect(f.publications[0]?.tags).toContainEqual(["p", f.peer.pubkey]);
    const beforePublish = f.order.slice(0, f.order.indexOf("publish"));
    expect(beforePublish.indexOf("sign")).toBeLessThan(
      beforePublish.lastIndexOf("query"),
    );
    const parent = "a".repeat(64);
    owner.session.messages.reply(
      "c",
      id,
      "Nested reply",
      [f.peer.pubkey],
      [],
      parent,
    );
    await vi.waitFor(() => expect(f.publications).toHaveLength(2));
    expect(f.publications[1]?.tags).toContainEqual(["e", id, "", "root"]);
    expect(f.publications[1]?.tags).toContainEqual(["e", parent, "", "reply"]);
    f.removePeer();
    owner.session.messages.send("c", "Must not publish", [f.peer.pubkey]);
    await vi.waitFor(() =>
      expect(
        owner.session.outbox
          ?.snapshot()
          .some(
            (m) =>
              m.event.content === "Must not publish" && m.delivery === "failed",
          ),
      ).toBe(true),
    );
    expect(f.publications).toHaveLength(2);
  } finally {
    owner.dispose();
  }
});
it("actual communities activation does not call broker or persist connection, and disconnect retires session", async () => {
  const f = fixture();
  const writes = vi.fn();
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: writes });
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("No broker permitted");
    }),
  );
  const connection = createAccountConnection(
    {
      begin: async () => "ticket",
      run: async () => f.account,
      cancel: async () => {},
      close: f.host.close,
    },
    (account, signal) => nativeTransport(account, f.host, signal),
  );
  const ctx = new Context();
  roots.push(ctx);
  const communities = createCommunities(
    ctx,
    false,
    undefined,
    "",
    undefined,
    connection,
  );
  expect(f.host.begin).not.toHaveBeenCalled();
  await connection.check(f.account.viewer, f.account.origin);
  await vi.waitFor(() =>
    expect(communities.relay.snapshot().status).toBe("ready"),
  );
  const session = communities.relay.snapshot().session;
  await vi.waitFor(() => expect(session.channels.list().status).toBe("ready"));
  expect(session.channels.list().channels.some((c) => c.id === "c")).toBe(true);
  session.messages.send("c", "From the application owner");
  await vi.waitFor(() => expect(f.publications).toHaveLength(1));
  expect(
    writes.mock.calls.some(([key]) => String(key).startsWith("buzz-client")),
  ).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
  await connection.disconnect();
  expect(communities.snapshot().viewer).toBeUndefined();
  expect(communities.relay.snapshot().status).toBe("disconnected");
  expect(f.host.close).toHaveBeenCalledWith(f.account.lease);
  expect(() => session.messages.send("c", "After disconnect")).toThrow();
  connection.dispose();
});
it("distinguishes native pre-dispatch refusal from uncertain dispatched result and invalid receipt", async () => {
  const f = fixture();
  const writer = nativeTransport(f.account, f.host).writer;
  if (!writer) throw new Error("Missing writer");
  const event = signed(keypair(), {
    kind: 9,
    content: "x",
    tags: [["h", "c"]],
  });
  const signal = new AbortController().signal;
  vi.mocked(f.host.run).mockRejectedValueOnce({
    message: "closed",
    sent: false,
  });
  await expect(writer.publish(event, signal)).rejects.toBeInstanceOf(
    PublishRejected,
  );
  vi.mocked(f.host.run).mockRejectedValueOnce({
    message: "timeout",
    sent: true,
  });
  await expect(writer.publish(event, signal)).rejects.not.toBeInstanceOf(
    PublishRejected,
  );
  vi.mocked(f.host.run).mockResolvedValueOnce({
    kind: "response",
    value: {
      status: 200,
      body: JSON.stringify({ accepted: true, event_id: "different" }),
    },
  });
  await expect(writer.publish(event, signal)).rejects.not.toBeInstanceOf(
    PublishRejected,
  );
});
it("cancels late operation tickets and validates returned event signatures", async () => {
  const f = fixture();
  let release!: (v: string) => void;
  const held = new Promise<string>((r) => {
    release = r;
  });
  vi.mocked(f.host.begin).mockReturnValueOnce(held);
  const controller = new AbortController();
  const transport = nativeTransport(f.account, f.host, controller.signal);
  const read = transport.query([{ kinds: [0], limit: 1 }]);
  controller.abort();
  release("late");
  await expect(read).rejects.toHaveProperty("name", "AbortError");
  expect(f.host.run).not.toHaveBeenCalled();
  expect(f.host.cancel).toHaveBeenCalledWith(f.account.lease, "late");
  const fresh = nativeTransport(f.account, f.host);
  const event = signed(keypair(), { kind: 0, content: "{}", tags: [] });
  vi.mocked(f.host.run).mockResolvedValueOnce({
    kind: "response",
    value: {
      status: 200,
      body: JSON.stringify([{ ...event, content: "tampered" }]),
    },
  });
  await expect(fresh.query([{ kinds: [0], limit: 1 }])).rejects.toThrow(
    /invalidly signed/,
  );
});

it("keeps an outbox reservation timeout unsent, but a dispatched timeout unknown", async () => {
  vi.useFakeTimers();
  const { createOutbox } = await import("./outbox");
  const viewer = keypair(),
    relay = keypair();
  let entered!: () => void, release!: (id: string) => void;
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const held = new Promise<string>((r) => {
    release = r;
  });
  let begins = 0;
  const host: NativeRelayHost = {
    begin: vi.fn(async () => {
      if (++begins === 2) {
        entered();
        return held;
      }
      return `op${begins}`;
    }),
    run: vi.fn(async (_l, _o, op) => {
      if (op.kind === "sign")
        return { kind: "signed" as const, value: signed(viewer, op.value) };
      return { kind: "response" as const, value: { status: 200, body: "{}" } };
    }),
    cancel: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  const writer = nativeTransport(
    {
      viewer: viewer.pubkey,
      origin: "https://relay.example",
      relayAuthor: relay.pubkey,
      lease: "lease",
      archiveAuthority: null,
    },
    host,
  ).writer;
  if (!writer) throw new Error("Missing writer");
  const confirmed = vi.fn();
  const outbox = createOutbox(
    viewer.pubkey,
    writer,
    { load: () => [], save: () => {} },
    { timeoutMs: 1000, onAccepted: confirmed },
  );
  try {
    outbox.outbox.send({
      kind: 9,
      content: "held reserve",
      tags: [["h", "c"]],
    });
    await started;
    await vi.advanceTimersByTimeAsync(1001);
    expect(outbox.outbox.snapshot()[0]?.delivery).toBe("failed");
    expect(confirmed).not.toHaveBeenCalled();
    release("late-reservation");
    await vi.advanceTimersByTimeAsync(0);
    expect(host.cancel).toHaveBeenCalledWith("lease", "late-reservation");
    expect(
      vi.mocked(host.run).mock.calls.every(([, , op]) => op.kind !== "publish"),
    ).toBe(true);
    let dispatch!: () => void;
    const sent = new Promise<void>((r) => {
      dispatch = r;
    });
    vi.mocked(host.run).mockImplementation(async (_l, _o, op) => {
      if (op.kind === "sign")
        return { kind: "signed", value: signed(viewer, op.value) };
      dispatch();
      return new Promise(() => {});
    });
    outbox.outbox.send({
      kind: 9,
      content: "held dispatched",
      tags: [["h", "c"]],
    });
    await sent;
    await vi.advanceTimersByTimeAsync(1001);
    expect(
      outbox.outbox
        .snapshot()
        .find((row) => row.event.content === "held dispatched")?.delivery,
    ).toBe("unknown");
    expect(confirmed).toHaveBeenCalledTimes(1);
  } finally {
    release("late-reservation");
    outbox.dispose();
    vi.useRealTimers();
  }
});

it("repeated native connect/disconnect disposes prior relay owners instead of accumulating callbacks", async () => {
  const f = fixture();
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  const aborted: AbortSignal[] = [];
  const connection = createAccountConnection(
    {
      begin: async () => "ticket",
      run: async () => f.account,
      cancel: async () => {},
      close: f.host.close,
    },
    (account, signal) => {
      if (signal) aborted.push(signal);
      return nativeTransport(account, f.host, signal);
    },
  );
  const ctx = new Context();
  roots.push(ctx);
  const communities = createCommunities(
    ctx,
    false,
    undefined,
    "",
    undefined,
    connection,
  );
  for (let i = 0; i < 3; i++) {
    await connection.check(f.account.viewer, f.account.origin);
    await vi.waitFor(() =>
      expect(communities.relay.snapshot().status).toBe("ready"),
    );
    await connection.disconnect();
    expect(communities.snapshot().memberships).toEqual([]);
    expect(aborted.every((signal) => signal.aborted)).toBe(true);
  }
  expect(aborted).toHaveLength(3);
  connection.dispose();
});
