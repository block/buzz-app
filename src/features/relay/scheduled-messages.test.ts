import { describe, expect, it, vi } from "vitest";
import type { OutgoingMessage } from "../messages/outgoing-message";
import { keypair, signed } from "./testing";
import { createScheduledMessages } from "./scheduled-messages";

const channel = "11111111-1111-4111-8111-111111111111";
const id = "22222222-2222-4222-8222-222222222222";
function fixture() {
  const key = keypair(),
    lifetime = new AbortController();
  const message: OutgoingMessage = {
    channelId: channel,
    text: "Ready tomorrow",
    recipients: ["a".repeat(64)],
    references: [],
    attachments: [],
    picks: {},
  };
  const sendAt = Date.now() + 86400000;
  const event = signed(key, {
    kind: 9,
    content: message.text,
    created_at: Math.floor(sendAt / 1000),
    tags: [
      ["h", channel],
      ["p", "a".repeat(64)],
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
      prepare: (draft) => ({ kind: 9, content: draft.text, tags: event.tags }),
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
  return {
    key,
    lifetime,
    message,
    sendAt,
    event,
    request,
    sign,
    service,
    list,
  };
}

describe("relay-backed scheduled messages", () => {
  it.each([
    [400, "Check the message and send time"],
    [403, "permission to schedule messages"],
    [404, "does not support scheduled delivery"],
    [503, "Refresh to check whether the change was saved"],
  ])("explains a scheduling refusal with HTTP %s", async (status, message) => {
    const h = fixture();
    h.request.mockResolvedValueOnce(new Response(null, { status }));
    await expect(h.service.create(h.message, h.sendAt)).rejects.toThrow(
      message,
    );
  });

  it("retries an uncertain create with the same operation and signed event", async () => {
    const h = fixture();
    h.request.mockRejectedValueOnce(new Error("Response lost"));
    await expect(h.service.create(h.message, h.sendAt)).rejects.toThrow(
      "Response lost",
    );
    await Promise.all([
      h.service.create(h.message, h.sendAt),
      h.service.create(h.message, h.sendAt),
    ]);
    expect(h.sign).toHaveBeenCalledTimes(1);
    expect(h.request.mock.calls[0]?.[0]).toEqual(h.request.mock.calls[1]?.[0]);
    expect(h.request.mock.calls[0]?.[0]).toEqual(h.request.mock.calls[2]?.[0]);
  });
  it("requires an explicit relay acknowledgment before resolving create", async () => {
    const h = fixture();
    h.request.mockResolvedValueOnce(Response.json({ accepted: false }));
    await expect(h.service.create(h.message, h.sendAt)).rejects.toThrow(
      "did not confirm",
    );
    await h.service.create(h.message, h.sendAt);
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
    await expect(h.service.create(h.message, h.sendAt)).rejects.toThrow(
      "approved draft",
    );
    expect(h.request).not.toHaveBeenCalled();
    h.sign.mockImplementationOnce(async (template) => ({
      ...signed(h.key, template),
      sig: "0".repeat(128),
    }));
    await expect(h.service.create(h.message, h.sendAt)).rejects.toThrow();
    expect(h.request).not.toHaveBeenCalled();
  });
  it("refuses invalid times before signing or contacting the relay", async () => {
    const h = fixture();
    for (const time of [NaN, Date.now() - 1, Date.now() + 121 * 86400000])
      await expect(h.service.create(h.message, time)).rejects.toThrow();
    expect(h.sign).not.toHaveBeenCalled();
    expect(h.request).not.toHaveBeenCalled();
  });
  it("reschedules the verified event with the same content and tags", async () => {
    const h = fixture();
    const rows = await h.list();
    expect(rows[0]?.destination.threadRootId).toBe("b".repeat(64));
    const sendAt = h.sendAt + 60000;
    await expect(h.service.reschedule(id, "2", sendAt)).rejects.toThrow(
      "Refresh",
    );
    expect(h.sign).not.toHaveBeenCalled();
    await h.service.reschedule(id, "1", sendAt);
    expect(h.sign).toHaveBeenCalledWith(
      {
        kind: h.event.kind,
        content: h.event.content,
        tags: h.event.tags,
        created_at: Math.floor(sendAt / 1000),
      },
      expect.any(AbortSignal),
    );
    expect(h.request.mock.calls[1]?.[0]).toMatchObject({
      action: "update",
      id,
      revision: 1,
      event: { created_at: Math.floor(sendAt / 1000) },
    });
    await expect(h.service.cancel(id, "2")).rejects.toThrow("Refresh");
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
    await expect(
      h.service.reschedule(id, "1", h.sendAt + 60000),
    ).rejects.toThrow("Refresh");
    expect(h.sign).not.toHaveBeenCalled();
  });
  it("revokes signing and relay operations when the account/session closes", async () => {
    const h = fixture();
    h.lifetime.abort();
    await expect(h.service.create(h.message, h.sendAt)).rejects.toThrow();
    await expect(
      h.service.list(new AbortController().signal),
    ).rejects.toThrow();
    expect(h.sign).not.toHaveBeenCalled();
    expect(h.request).not.toHaveBeenCalled();
  });
});
