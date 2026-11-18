import { expect, it, vi } from "vitest";
import { indexSource } from "./index-source";
import { listing, rawIndex } from "./testing";

const url = "https://plugins.example/index.json";

it("shares one read, reads again when asked to, and keeps no failed read", async () => {
  let served: unknown = rawIndex([listing()]);
  const request = vi.fn(async () => ({
    status: 200,
    headers: {},
    body: JSON.stringify(served),
  }));
  const source = indexSource({ request }, url);
  expect(await source.listed()).toEqual(new Set([listing().id]));
  await source.read();
  expect(request).toHaveBeenCalledTimes(1);
  served = rawIndex([]);
  await source.read(true);
  expect(await source.listed()).toEqual(new Set());
  expect(request).toHaveBeenCalledTimes(2);
  request.mockRejectedValueOnce(new Error("offline"));
  await expect(source.read(true)).rejects.toThrow("offline");
  expect(await source.listed()).toEqual(new Set());
  expect(request).toHaveBeenCalledTimes(4);
});
