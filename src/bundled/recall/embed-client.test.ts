import { afterEach, expect, it, vi } from "vitest";
import {
  boundedInput,
  createEmbeddingClient,
  endpoint,
  vector,
} from "./embed-client.ts";
import type { HostRequest } from "../../features/host/service";
import { DEFAULT_SETTINGS, type Settings } from "./types.ts";

const response = (vectors: unknown[] = [[3, 4]], model = "model") => ({
  status: 200,
  headers: {},
  body: JSON.stringify({
    model,
    data: vectors.map((embedding, index) => ({ index, embedding })).reverse(),
  }),
});
function rig() {
  let settings: Settings = {
    ...DEFAULT_SETTINGS,
    embeddingUrl: "http://127.0.0.1:8080",
    embeddingKey: "secret",
  };
  const host = { request: vi.fn(async (_request: HostRequest) => response()) };
  const reset = vi.fn();
  const client = createEmbeddingClient(host, () => settings, reset);
  return {
    host,
    client,
    reset,
    set: (next: Partial<Settings>) => {
      settings = { ...settings, ...next };
    },
  };
}
afterEach(() => vi.useRealTimers());
it.each([
  "http://localhost",
  "http://127.0.0.1.evil.test",
  "http://192.168.1.2",
  "http://[::ffff:127.0.0.1]",
  "https://u:p@example.test",
  "ftp://example.test",
  "https://example.test?key=secret",
  "https://example.test#fragment",
])("refuses unsafe endpoint %s", (url) =>
  expect(() => endpoint(url)).toThrow(),
);
it.each([
  "http://127.0.0.1",
  "http://127.3.2.1",
  "http://[::1]",
  "https://example.test/prefix",
])("accepts %s and appends the endpoint", (url) =>
  expect(endpoint(url)).toBe(`${url}/v1/embeddings`),
);
it("accepts full endpoint and v1 base", () => {
  expect(endpoint("https://example.test/v1")).toBe(
    "https://example.test/v1/embeddings",
  );
  expect(endpoint("https://example.test/v1/embeddings")).toBe(
    "https://example.test/v1/embeddings",
  );
});
it.each([[], [0, 0], [NaN, 1], [Infinity], ["1"], null])(
  "rejects malformed numerical vector %j",
  (value) => expect(() => vector(value)).toThrow(),
);
it("normalizes finite vectors without overflow and pins a learned dimension", () => {
  expect(Array.from(vector([3, 4]))).toEqual([
    expect.closeTo(0.6),
    expect.closeTo(0.8),
  ]);
  expect(Array.from(vector([1e308, 1e308]))).toEqual([
    expect.closeTo(Math.SQRT1_2),
    expect.closeTo(Math.SQRT1_2),
  ]);
  expect(() => vector([1, 0, 0], 2)).toThrow();
});
it("restores response order, sends bearer only in headers, and bounds the final bytes", async () => {
  const r = rig();
  r.host.request.mockResolvedValue(
    response([
      [3, 4],
      [0, 2],
    ]),
  );
  const values = await r.client.embed(["a".repeat(8000), "b"]);
  expect(Array.from(values[0] ?? [])).toEqual([
    expect.closeTo(0.6),
    expect.closeTo(0.8),
  ]);
  expect(Array.from(values[1] ?? [])).toEqual([0, 1]);
  const call = r.host.request.mock.calls[0]?.[0];
  expect(call).toMatchObject({
    url: "http://127.0.0.1:8080/v1/embeddings",
    method: "POST",
    headers: { Authorization: "Bearer secret" },
  });
  expect(JSON.parse(call?.body ?? "{}").input[0]).toHaveLength(4000);
  expect(r.client.status()).toEqual({ model: "model", dimensions: 2 });
});
it.each([
  { model: "m", data: [] },
  { model: "m", data: [{ index: 1, embedding: [1] }] },
  { model: "m", data: [{ index: 0.5, embedding: [1] }] },
  { model: "m", data: [{ index: -1, embedding: [1] }] },
  { data: [{ index: 0, embedding: [1] }] },
])("rejects malformed response %j", async (body) => {
  const r = rig();
  r.host.request.mockResolvedValue({
    ...response(),
    body: JSON.stringify(body),
  });
  await expect(r.client.embed(["a"])).rejects.toThrow();
});
it("rejects duplicate indexes and mixed dimensions within a batch", async () => {
  const r = rig();
  r.host.request.mockResolvedValue({
    ...response(),
    body: JSON.stringify({
      model: "m",
      data: [
        { index: 0, embedding: [1] },
        { index: 0, embedding: [1] },
      ],
    }),
  });
  await expect(r.client.embed(["a", "b"])).rejects.toThrow();
  r.host.request.mockResolvedValue(response([[1, 0], [1]]));
  await expect(r.client.embed(["a", "b"])).rejects.toThrow();
});
it("rejects a changed dimension, clears on returned model change, then accepts the new model", async () => {
  const r = rig();
  await r.client.embed(["a"]);
  r.host.request.mockResolvedValue(response([[1, 0, 0]]));
  await expect(r.client.embed(["a"])).rejects.toThrow();
  r.reset.mockClear();
  r.host.request.mockResolvedValue(response([[1, 0, 0]], "different"));
  await expect(r.client.embed(["a"])).rejects.toThrow(/model changed/);
  expect(r.reset).toHaveBeenCalledOnce();
  await expect(r.client.embed(["a"])).resolves.toHaveLength(1);
});
it.each([
  "embeddingUrl",
  "embeddingKey",
  "queryPrefix",
  "documentPrefix",
] as const)("%s change invalidates state", async (field) => {
  const r = rig();
  await r.client.embed(["a"]);
  r.reset.mockClear();
  r.set({ [field]: "changed" });
  r.client.configured();
  expect(r.reset).toHaveBeenCalledOnce();
  expect(r.client.status().dimensions).toBeUndefined();
});
it("fences a response from previous settings", async () => {
  const r = rig();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  r.host.request.mockImplementationOnce(async () => {
    await gate;
    return response();
  });
  const pending = r.client.embed(["a"]);
  r.set({ embeddingUrl: "https://other.test" });
  release();
  await expect(pending).rejects.toThrow(/configuration changed/);
  expect(r.client.status().dimensions).toBeUndefined();
});
it("empty URL sends nothing, non-200 fails, and a hung request respects its deadline", async () => {
  const r = rig();
  r.set({ embeddingUrl: "" });
  await expect(r.client.embed(["a"])).rejects.toThrow();
  expect(r.host.request).not.toHaveBeenCalled();
  r.set({ embeddingUrl: "https://example.test" });
  r.host.request.mockResolvedValueOnce({ ...response(), status: 400 });
  await expect(r.client.embed(["a"])).rejects.toThrow();
  vi.useFakeTimers();
  r.host.request.mockImplementationOnce(() => new Promise(() => {}));
  const pending = expect(r.client.embed(["a"], 37)).rejects.toThrow(/Deadline/);
  await vi.advanceTimersByTimeAsync(37);
  await pending;
  expect(r.host.request.mock.calls.at(-1)?.[0].timeoutMs).toBe(37);
});
it("cuts UTF-8 without splitting a code point, counting spaces as ordinary bytes", () => {
  const text = boundedInput("🧬 ".repeat(2000));
  expect(new TextEncoder().encode(text).length).toBe(4000);
  expect(text.endsWith("🧬 ")).toBe(true);
});
