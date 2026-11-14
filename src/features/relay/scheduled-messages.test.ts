import { describe, expect, it, vi } from "vitest";
import { keypair, signed } from "./testing";
import {
  createScheduledMessages,
  type ScheduledInput,
} from "./scheduled-messages";

const channel = "11111111-1111-4111-8111-111111111111";
const id = "22222222-2222-4222-8222-222222222222";
function fixture(mentioned = true) {
  const key = keypair(),
    lifetime = new AbortController();
  const input: ScheduledInput = {
    destination: { channelId: channel, name: "Launch" },
    content: "Ready tomorrow",
    sendAt: Date.now() + 86400000,
  };
  const event = signed(key, {
    kind: 9,
    content: input.content,
    created_at: Math.floor(input.sendAt / 1000),
    tags: [
      ["h", channel],
      ...(mentioned ? [["p", "a".repeat(64)]] : []),
      ["e", "b".repeat(64), "", "reply"],
      ["imeta", "url https://example.invalid/file.png"],
    ],
  });
  const request = vi.fn(async (_body: unknown, _signal: AbortSignal) =>
    Response.json({ accepted: true }),
  );
  const sign = vi.fn(async (template: Parameters<typeof signed>[1]) =>
    signed(key, template),
  );
  const service = createScheduledMessages(
    { request, sign },
    {
      viewer: key.pubkey,
      signal: lifetime.signal,
      prepare: () => ({ kind: 9, content: input.content, tags: event.tags }),
      name: () => "Launch",
    },
  );
  const list = () => {
    request.mockResolvedValueOnce(
      Response.json({
        messages: [
          {
            id,
            revision: 1,
            event,
            send_at: event.created_at,
            status: "scheduled",
          },
        ],
      }),
    );
    return service.list(new AbortController().signal);
  };
  return { key, lifetime, input, event, request, sign, service, list };
}

describe("relay-backed scheduled messages", () => {
  it("retries an uncertain create with the same operation and signed event", async () => {
    const h = fixture();
    h.request.mockRejectedValueOnce(new Error("Response lost"));
    await expect(h.service.create(h.input)).rejects.toThrow("Response lost");
    await h.service.create(h.input);
    expect(h.sign).toHaveBeenCalledTimes(1);
    expect(h.request.mock.calls[0]?.[0]).toEqual(h.request.mock.calls[1]?.[0]);
  });
  it("checks the exact approved timestamp and signature before queueing", async () => {
    const h = fixture();
    h.sign.mockImplementationOnce(async (template) =>
      signed(h.key, {
        ...template,
        created_at: (template.created_at ?? 0) + 60,
      }),
    );
    await expect(h.service.create(h.input)).rejects.toThrow("approved draft");
    expect(h.request).not.toHaveBeenCalled();
    h.sign.mockImplementationOnce(async (template) => ({
      ...signed(h.key, template),
      sig: "0".repeat(128),
    }));
    await expect(h.service.create(h.input)).rejects.toThrow();
    expect(h.request).not.toHaveBeenCalled();
  });
  it("refuses invalid times before signing or contacting the relay", async () => {
    const h = fixture();
    for (const time of [NaN, Date.now() - 1, Date.now() + 121 * 86400000])
      await expect(
        h.service.create({ ...h.input, sendAt: time }),
      ).rejects.toThrow();
    expect(h.sign).not.toHaveBeenCalled();
    expect(h.request).not.toHaveBeenCalled();
  });
  it("verifies queued signatures and preserves thread and attachment bindings on edit", async () => {
    const h = fixture(false);
    const rows = await h.list();
    expect(rows[0]?.destination.threadRootId).toBe("b".repeat(64));
    await h.service.update(id, "1", { ...h.input, content: "Updated" });
    expect(h.sign.mock.calls[0]?.[0]).toMatchObject({
      content: "Updated",
      tags: h.event.tags,
    });
    await expect(h.service.cancel(id, "2")).rejects.toThrow("Refresh");
  });
  it("refuses prose edits with retained recipients but allows rescheduling", async () => {
    const h = fixture();
    await h.list();
    await expect(
      h.service.update(id, "1", { ...h.input, content: "No mention now" }),
    ).rejects.toThrow("save it to drafts");
    expect(h.sign).not.toHaveBeenCalled();
    expect(h.request).toHaveBeenCalledTimes(1);
    await h.service.update(id, "1", {
      ...h.input,
      sendAt: h.input.sendAt + 60000,
    });
    expect(h.sign.mock.calls[0]?.[0]).toMatchObject({
      content: h.event.content,
      tags: h.event.tags,
    });
  });
  it("reuses an uncertain send-now operation after the client clock changes", async () => {
    vi.useFakeTimers();
    try {
      const h = fixture();
      await h.list();
      h.request.mockRejectedValueOnce(new Error("Response lost"));
      await expect(h.service.sendNow(id, "1")).rejects.toThrow("Response lost");
      vi.advanceTimersByTime(301000);
      await h.service.sendNow(id, "1");
      expect(h.sign).toHaveBeenCalledTimes(1);
      expect(h.request.mock.calls[1]?.[0]).toEqual(
        h.request.mock.calls[2]?.[0],
      );
    } finally {
      vi.useRealTimers();
    }
  });
  it("renews an uncommitted expired send-now only after a definite relay rejection", async () => {
    vi.useFakeTimers();
    try {
      const h = fixture();
      await h.list();
      h.request.mockRejectedValueOnce(new Error("Offline before commit"));
      await expect(h.service.sendNow(id, "1")).rejects.toThrow(
        "Offline before commit",
      );
      vi.advanceTimersByTime(301000);
      h.request.mockResolvedValueOnce(new Response(null, { status: 400 }));
      await expect(h.service.sendNow(id, "1")).rejects.toThrow("fresh request");
      expect(h.request.mock.calls[1]?.[0]).toEqual(
        h.request.mock.calls[2]?.[0],
      );
      expect(h.sign).toHaveBeenCalledTimes(1);
      await h.service.sendNow(id, "1");
      expect(h.sign).toHaveBeenCalledTimes(2);
      expect(h.sign.mock.calls[1]?.[0].created_at).toBe(
        Math.floor(Date.now() / 1000),
      );
      expect(h.request.mock.calls[3]?.[0]).not.toEqual(
        h.request.mock.calls[2]?.[0],
      );
    } finally {
      vi.useRealTimers();
    }
  });
  it("rejects tampered queued content before allowing any mutation", async () => {
    const h = fixture();
    h.request.mockResolvedValueOnce(
      Response.json({
        messages: [
          {
            id,
            revision: 1,
            event: { ...h.event, content: "tampered" },
            send_at: h.event.created_at,
            status: "scheduled",
          },
        ],
      }),
    );
    await expect(
      h.service.list(new AbortController().signal),
    ).rejects.toThrow();
    await expect(h.service.sendNow(id, "1")).rejects.toThrow("Refresh");
  });
  it("signs send-now with a current timestamp and the exact reviewed message", async () => {
    const h = fixture();
    await h.list();
    await h.service.sendNow(id, "1");
    expect(h.sign.mock.calls[0]?.[0]).toMatchObject({
      kind: 9,
      content: h.event.content,
      tags: h.event.tags,
    });
    expect(h.sign.mock.calls[0]?.[0].created_at).toBeLessThanOrEqual(
      Math.floor(Date.now() / 1000),
    );
    expect(h.request.mock.calls[1]?.[0]).toMatchObject({
      action: "send_now",
      id,
      revision: 1,
    });
  });
  it("revokes signing and relay operations when the account/session closes", async () => {
    const h = fixture();
    h.lifetime.abort();
    await expect(h.service.create(h.input)).rejects.toThrow();
    await expect(
      h.service.list(new AbortController().signal),
    ).rejects.toThrow();
    expect(h.sign).not.toHaveBeenCalled();
    expect(h.request).not.toHaveBeenCalled();
  });
});
