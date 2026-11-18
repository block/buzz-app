import { afterEach, expect, it, vi } from "vitest";
import type { EventTemplate } from "nostr-tools";
import { artifactTypePolicyAccess } from "./artifact-type-policy";
import type { RelayEvent } from "./events";
import { PublishNotSent, PublishRejected } from "./outbox";
import { keypair, signed } from "./testing";

const viewer = keypair();
const COMMUNITY = "9b353519-f4fe-4757-aef4-bec6cc0ae54c";
const TYPE = "example.settings";
const change = { type: TYPE, policy: "admins", prev: "0" } as const;

afterEach(() => {
  vi.useRealTimers();
});

/** `publish` scripts the relay. */
function access(
  publish: (signal: AbortSignal) => Promise<string> = async () => "",
) {
  const read = vi.fn<() => Promise<unknown>>(async () => ({
    policy: "admins",
    revision: null,
  }));
  const writer = {
    sign: vi.fn(async (template: EventTemplate) => signed(viewer, template)),
    publish: vi.fn((_event: RelayEvent, signal: AbortSignal) =>
      publish(signal),
    ),
  };
  return {
    access: artifactTypePolicyAccess(COMMUNITY, read, writer),
    read,
    writer,
  };
}

it("hands a plugin only the parsed policy the relay returned", async () => {
  const h = access();
  h.read.mockResolvedValueOnce({
    policy: "everyone",
    revision: null,
    extra: "ignored",
  });
  await expect(
    h.access.read(TYPE, new AbortController().signal),
  ).resolves.toEqual({ policy: "everyone", revision: null });
});

it("rejects a relay read that is not a policy", async () => {
  const h = access();
  h.read.mockResolvedValueOnce({ policy: "nobody", revision: null });
  await expect(
    h.access.read(TYPE, new AbortController().signal),
  ).rejects.toThrow("Invalid artifact type policy");
});

it.each([
  ["accepted", async () => "", true, ""],
  [
    "refused with the relay's reason",
    () =>
      Promise.reject(
        new PublishRejected(
          "You don't have permission.",
          "restricted: community artifact access denied",
        ),
      ),
    false,
    "restricted: community artifact access denied",
  ],
  [
    "refused with only a message",
    () =>
      Promise.reject(
        new PublishRejected(
          "conflict: the relay state changed; reload before writing again",
        ),
      ),
    false,
    "conflict: the relay state changed; reload before writing again",
  ],
  [
    "not sent",
    () => Promise.reject(new PublishNotSent("rate-limited: slow down")),
    false,
    "",
  ],
  [
    "unconfirmed",
    () =>
      Promise.reject(new Error("Relay delivery could not be confirmed (502)")),
    false,
    "",
  ],
])(
  "signs this community's command once and reports %s",
  async (_, publish, ok, message) => {
    vi.useFakeTimers({ toFake: ["Date"], now: 1_700_000_123_456 });
    const h = access(publish);
    const result = await h.access.set(change, new AbortController().signal);
    expect(h.writer.sign).toHaveBeenCalledOnce();
    expect(h.writer.sign.mock.calls[0]?.[0]).toEqual({
      kind: 9034,
      created_at: 1_700_000_123,
      content: "",
      tags: [
        ["community", COMMUNITY],
        ["type", TYPE],
        ["policy", "admins"],
        ["prev", "0"],
      ],
    });
    const event = await h.writer.sign.mock.results[0]?.value;
    expect(h.writer.publish).toHaveBeenCalledOnce();
    expect(h.writer.publish.mock.calls[0]?.[0]).toBe(event);
    expect(result).toEqual({ id: event.id, ok, message });
  },
);

it("refuses a malformed change before signing", async () => {
  const h = access();
  await expect(
    h.access.set(
      { ...change, prev: "A".repeat(64) },
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  expect(h.writer.sign).not.toHaveBeenCalled();
});

it("rejects when signing fails or the caller aborts the publish", async () => {
  const h = access(
    (signal) =>
      new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason)),
      ),
  );
  h.writer.sign.mockRejectedValueOnce(new Error("Signer unavailable"));
  await expect(
    h.access.set(change, new AbortController().signal),
  ).rejects.toThrow("Signer unavailable");
  expect(h.writer.publish).not.toHaveBeenCalled();

  const controller = new AbortController();
  const pending = h.access.set(change, controller.signal);
  await vi.waitFor(() => expect(h.writer.publish).toHaveBeenCalledOnce());
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
});
