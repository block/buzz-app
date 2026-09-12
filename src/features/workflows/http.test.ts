import { afterEach, expect, it, vi } from "vitest";
import { verifyEvent } from "nostr-tools";
import { connectSignedTransport } from "../relay/transport";
import { keypair, signed } from "../relay/testing";
import { WORKFLOW_READ_BYTES, workflowReadText } from "./http";
const id = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
afterEach(() => vi.unstubAllGlobals());
it("direct signed transport history uses exact GET URL, no payload and the existing principal quota lane", async () => {
  const key = keypair();
  const signer = {
    getPublicKey: async () => key.pubkey,
    signEvent: async (template: Parameters<typeof signed>[1]) =>
      signed(key, template),
  };
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const auth = JSON.parse(
      atob(new Headers(init?.headers).get("Authorization")?.slice(6) ?? ""),
    );
    expect(verifyEvent(auth)).toBe(true);
    expect(auth.pubkey).toBe(key.pubkey);
    expect(auth.tags).toContainEqual(["u", url]);
    expect(auth.tags).toContainEqual(["method", "GET"]);
    expect(auth.tags.some(([name]: string[]) => name === "payload")).toBe(
      false,
    );
    expect(init?.body).toBeUndefined();
    expect(init?.redirect).toBe("error");
    return Response.json(
      { error: "rate-limited: quota exceeded; retry in 0s" },
      { status: 429 },
    );
  });
  vi.stubGlobal("fetch", fetcher);
  const transport = await connectSignedTransport(
    signer,
    "https://workflow-direct.test",
    key.pubkey,
  );
  expect(fetcher).not.toHaveBeenCalled();
  const cursor = {
    before: "2026-09-12T14:44:19.123456+00:00",
    beforeId: runId,
  };
  await expect(
    transport.workflows?.runs(id, cursor, new AbortController().signal),
  ).rejects.toMatchObject({ status: 429 });
  expect(fetcher.mock.calls[0]?.[0]).toBe(
    `https://workflow-direct.test/workflows/${id}/runs?limit=20&before=2026-09-12T14%3A44%3A19.123456%2B00%3A00&before_id=${runId}`,
  );
  await expect(
    transport.query([{ kinds: [0], limit: 1 }]),
  ).rejects.toMatchObject({ status: 429 });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("structured body budget counts stream bytes, cancels overflow, rejects invalid UTF8", async () => {
  const cancel = vi.fn();
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(WORKFLOW_READ_BYTES + 1));
      },
      cancel,
    }),
  );
  await expect(workflowReadText(response)).rejects.toThrow("size limit");
  expect(cancel).toHaveBeenCalledTimes(1);
  await expect(
    workflowReadText(new Response(new Uint8Array([0xff]))),
  ).rejects.toThrow();
});
it("direct workflow cancellation/invalid arguments never sign or dispatch", async () => {
  const key = keypair(),
    signEvent = vi.fn(async (template: Parameters<typeof signed>[1]) =>
      signed(key, template),
    );
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const transport = await connectSignedTransport(
    { getPublicKey: async () => key.pubkey, signEvent },
    "https://workflow-cancel.test",
    key.pubkey,
  );
  const cancel = new AbortController();
  cancel.abort();
  await expect(
    transport.workflows?.runs(id, undefined, cancel.signal),
  ).rejects.toThrow();
  await expect(
    transport.workflows?.approvals(id, "../", new AbortController().signal),
  ).rejects.toThrow();
  expect(signEvent).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
});

// These are transport/admission tests; the real metadata seam is exercised in compatibility.test.ts.
vi.mock("./compatibility", async (original) => ({
  ...(await original<typeof import("./compatibility")>()),
  discoverWorkflowLifecycle: async () => undefined,
}));
