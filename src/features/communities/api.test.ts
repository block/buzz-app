import { afterEach, expect, it, vi } from "vitest";
import { checkCommunityAccess, communityRequest } from "./api";
import { connectCommunityTransport } from "./connection";

vi.mock("./connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./connection")>()),
  connectCommunityTransport: vi.fn(),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(connectCommunityTransport).mockReset();
});

it("registers an unvisited destination before its scoped read, without a session", async () => {
  let release!: () => void;
  const registered = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/relay/register") {
      expect(JSON.parse(init?.body as string)).toEqual({
        url: "https://unvisited.example",
      });
      await registered;
      return Response.json({});
    }
    expect(url).toBe(
      "/api/relay/https%3A%2F%2Funvisited.example/agent-inventory",
    );
    expect(init?.body).toBe("{}");
    return Response.json({ identities: ["ab".repeat(32)] });
  });
  vi.stubGlobal("fetch", fetcher);
  const result = communityRequest(
    "https://unvisited.example",
    "agent-inventory",
    {},
  );
  try {
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally {
    release();
  }
  await expect(result).resolves.toEqual({ identities: ["ab".repeat(32)] });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[0]?.[1]?.signal).toBe(
    fetcher.mock.calls[1]?.[1]?.signal,
  );
});

it("does not read after registration failure and registers again on retry", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ error: "Destination rejected" }, { status: 400 }),
    )
    .mockResolvedValueOnce(Response.json({}))
    .mockResolvedValueOnce(Response.json({ identities: [] }));
  vi.stubGlobal("fetch", fetcher);
  await expect(
    communityRequest("https://unvisited.example", "agent-inventory", {}),
  ).rejects.toThrow("Destination rejected");
  expect(fetcher).toHaveBeenCalledTimes(1);
  await expect(
    communityRequest("https://unvisited.example", "agent-inventory", {}),
  ).resolves.toEqual({ identities: [] });
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    "/api/relay/register",
    "/api/relay/register",
    "/api/relay/https%3A%2F%2Funvisited.example/agent-inventory",
  ]);
});

it("does not read when cancelled during registration", async () => {
  const cancel = new AbortController();
  const fetcher = vi.fn(async () => {
    cancel.abort();
    return Response.json({});
  });
  vi.stubGlobal("fetch", fetcher);
  await expect(
    communityRequest(
      "https://unvisited.example",
      "agent-inventory",
      {},
      cancel.signal,
    ),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("checks access with one signed read of the viewer's own profile and never reads what comes back", async () => {
  const viewer = "cd".repeat(32);
  const query = vi.fn(async () => [
    { kind: 0, pubkey: viewer, content: "not json", created_at: 1, id: "e" },
  ]);
  vi.mocked(connectCommunityTransport).mockResolvedValue({
    viewer,
    query,
  } as unknown as Awaited<ReturnType<typeof connectCommunityTransport>>);
  const signal = new AbortController().signal;
  await expect(
    checkCommunityAccess("https://primary.example", signal),
  ).resolves.toBeUndefined();
  expect(connectCommunityTransport).toHaveBeenCalledWith(
    "https://primary.example",
    signal,
  );
  expect(query).toHaveBeenCalledTimes(1);
  expect(query).toHaveBeenCalledWith(
    [{ kinds: [0], authors: [viewer], limit: 1 }],
    signal,
  );
  // The relay's answer, or no answer, is the caller's to classify.
  query.mockRejectedValueOnce(new Error("Relay read failed (403)"));
  await expect(
    checkCommunityAccess("https://primary.example", signal),
  ).rejects.toThrow("Relay read failed (403)");
  const aborted = new AbortController();
  aborted.abort();
  await expect(
    checkCommunityAccess("https://primary.example", aborted.signal),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(query).toHaveBeenCalledTimes(2);
});
