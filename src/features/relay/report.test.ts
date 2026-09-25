import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import { PublishRejected } from "./outbox";
import type { LiveCallbacks } from "./live";
import type { RelayEvent } from "./events";
import { keypair, message, roster, scriptedTransport, signed } from "./testing";

const viewer = keypair(),
  other = keypair(),
  relay = keypair();
const root = message(other, "c", "Report me", 1);
const owners: { dispose(): void }[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});

function connect(
  publish: (event: RelayEvent) => Promise<void>,
  kinds?: number[],
  sign: (template: RelayEvent) => Promise<RelayEvent> = async (template) =>
    signed(viewer, template),
) {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live: LiveCallbacks | undefined;
  const save = vi.fn();
  const owner = createRelaySession(
    {
      ...wire.transport,
      writer: {
        ...(kinds ? { kinds } : {}),
        sign,
        publish,
      },
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    { outboxStorage: { load: () => [], save } },
  );
  owners.push(owner);
  owner.session.channels.ensure("c");
  live?.receive([roster(relay, "c", [viewer.pubkey], 1), root]);
  return { session: owner.session, save };
}

it("publishes one NIP-56 report on relay OK without entering the outbox", async () => {
  const publish = vi.fn(async (_event: RelayEvent) => {});
  const { session, save } = connect(publish);
  const report = session.messages.report;
  if (!report) throw new Error("Missing report capability");
  await report(root.id, "spam", "  repeated links  ");
  expect(publish).toHaveBeenCalledTimes(1);
  const event = publish.mock.calls[0]?.[0];
  expect(event).toMatchObject({
    kind: 1984,
    pubkey: viewer.pubkey,
    content: "repeated links",
    tags: [
      ["p", other.pubkey],
      ["e", root.id, "spam"],
    ],
  });
  expect(session.outbox?.snapshot()).toEqual([]);
  expect(save).not.toHaveBeenCalled();
});

it("surfaces relay rejection and does not retry or persist the report", async () => {
  const publish = vi.fn(async () => {
    throw new PublishRejected("blocked: rate limited");
  });
  const { session, save } = connect(publish);
  await expect(session.messages.report?.(root.id, "other")).rejects.toThrow(
    "rate limited",
  );
  expect(publish).toHaveBeenCalledTimes(1);
  expect(session.outbox?.snapshot()).toEqual([]);
  expect(save).not.toHaveBeenCalled();
});

it("rejects unloaded targets and unknown types before signing", async () => {
  const publish = vi.fn(async () => {});
  const { session } = connect(publish);
  await expect(
    session.messages.report?.("f".repeat(64), "spam"),
  ).rejects.toThrow("Load the message before reporting it");
  await expect(
    session.messages.report?.(root.id, "rude" as "spam"),
  ).rejects.toThrow("Choose a report reason");
  expect(publish).not.toHaveBeenCalled();
});

it("is unavailable when the writer does not advertise kind 1984", () => {
  const { session } = connect(async () => {}, [7, 9]);
  expect(session.messages.report).toBeUndefined();
  expect(connect(async () => {}, [9, 1984]).session.messages.report).toBeTypeOf(
    "function",
  );
});

it("rejects at the 10s deadline when signing never settles, and a late signature never publishes", async () => {
  const deadline = new AbortController();
  const timeout = vi
    .spyOn(AbortSignal, "timeout")
    .mockReturnValue(deadline.signal);
  try {
    let finish: (() => void) | undefined;
    const publish = vi.fn(async () => {});
    const { session, save } = connect(
      publish,
      undefined,
      (template) =>
        new Promise((resolve) => {
          finish = () => resolve(signed(viewer, template));
        }),
    );
    const result = session.messages.report?.(root.id, "spam");
    expect(timeout).toHaveBeenCalledWith(10_000);
    deadline.abort();
    await expect(result).rejects.toThrow();
    finish?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(publish).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  } finally {
    timeout.mockRestore();
  }
});

it("rejects at the 10s deadline when publishing never settles", async () => {
  const deadline = new AbortController();
  const timeout = vi
    .spyOn(AbortSignal, "timeout")
    .mockReturnValue(deadline.signal);
  try {
    let started: () => void = () => {};
    const publishing = new Promise<void>((resolve) => (started = resolve));
    const publish = vi.fn(() => {
      started();
      return new Promise<void>(() => {});
    });
    const { session, save } = connect(publish);
    const result = session.messages.report?.(root.id, "spam");
    await publishing;
    deadline.abort();
    await expect(result).rejects.toThrow();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
  } finally {
    timeout.mockRestore();
  }
});

it("rejects a pending report when the session is disposed", async () => {
  const publish = vi.fn(async () => {});
  const { session } = connect(publish, undefined, () => new Promise(() => {}));
  const result = session.messages.report?.(root.id, "spam");
  for (const owner of owners.splice(0)) owner.dispose();
  await expect(result).rejects.toThrow();
  expect(publish).not.toHaveBeenCalled();
});
