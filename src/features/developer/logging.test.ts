import { afterEach, expect, it, vi } from "vitest";
import {
  developerSettings,
  getLogger,
  isLogLevel,
  logLevel,
  setLogLevel,
  subscribeLogLevel,
} from "./logging";
import {
  filterSummary,
  httpLabel,
  logSocketFrame,
  relayLabel,
} from "./traffic";

afterEach(() => {
  setLogLevel("info");
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
it("updates existing/future tags and never coalesces the firehose", () => {
  const log = getLogger("test");
  const records: unknown[] = [];
  log.setReporters([{ log: (value) => records.push(value) }]);
  const changed = vi.fn();
  const unsubscribe = subscribeLogLevel(changed);
  log.debug("hidden");
  expect(records).toHaveLength(0);
  setLogLevel("debug");
  expect(changed).toHaveBeenCalledOnce();
  expect(getLogger("future").level).toBe(4);
  for (let i = 0; i < 20; i++) log.debug("same frame");
  expect(records).toHaveLength(20);
  setLogLevel("silent");
  log.error("hidden too");
  expect(records).toHaveLength(20);
  unsubscribe();
  expect(isLogLevel("constructor")).toBe(false);
  expect(isLogLevel(4)).toBe(false);
});
it("applies only valid saved responses and leaves the previous level on failure", async () => {
  vi.stubEnv("BUZZ_DEV_SETTINGS", "1");
  const fetcher = vi
    .fn()
    .mockImplementation(async () =>
      Response.json({ logLevel: "trace", revision: 1 }),
    );
  vi.stubGlobal("fetch", fetcher);
  await developerSettings("trace");
  expect(fetcher).toHaveBeenCalledWith(
    "/api/dev/settings",
    expect.objectContaining({
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: '{"logLevel":"trace"}',
    }),
  );
  expect(logLevel()).toBe("trace");
  await developerSettings();
  expect(fetcher).toHaveBeenLastCalledWith(
    "/api/dev/settings",
    expect.objectContaining({ headers: { Accept: "application/json" } }),
  );
  fetcher.mockResolvedValue(Response.json({ logLevel: "invalid" }));
  await expect(developerSettings()).rejects.toThrow("Invalid");
  fetcher.mockResolvedValue(new Response("", { status: 500 }));
  await expect(developerSettings("info")).rejects.toThrow("could not be saved");
  expect(logLevel()).toBe("trace");
});
it("allows only traffic metadata, never bodies, auth challenges or URL secrets", () => {
  const logger = getLogger("relay-ws");
  const lines: string[] = [];
  logger.setReporters([{ log: (value) => lines.push(value.args.join(" ")) }]);
  setLogLevel("trace");
  const event = {
    id: "a".repeat(64),
    kind: 9,
    content: "private-message",
    tags: [["secret", "private-tag"]],
    sig: "private-signature",
  };
  for (const frame of [
    ["AUTH", "private-challenge"],
    ["AUTH", event],
    ["EVENT", "live-1", event],
    ["OK", event.id, false, "private-error"],
    ["NOTICE", "private-notice"],
    ["private-type", "private-data"],
  ])
    logSocketFrame("relay.test", "←", JSON.stringify(frame), frame);
  logSocketFrame("relay.test", "→", "[]", [
    "REQ",
    "live-1",
    {
      kinds: [9],
      limit: 20,
      search: "private-search",
      authors: ["private-author"],
    },
  ]);
  expect(lines.join("\n")).not.toContain("private");
  expect(lines.join("\n")).toContain("kind=9");
  expect(lines.join("\n")).toContain('"authors":1');
  expect(lines).toHaveLength(8);
  expect(relayLabel("wss://user:secret@relay.test/path?token=secret")).toBe(
    "relay.test",
  );
  expect(httpLabel("/api/relay/https%3A%2F%2Frelay.test/query")).toBe(
    "relay.test /relay/query",
  );
  expect(
    filterSummary([{ kinds: [9], content: "private", search: "private" }]),
  ).toBe('[{"kinds":[9]}]');
  setLogLevel("info");
  logSocketFrame("relay.test", "←", "[]", ["EVENT", "live-1", event]);
  expect(lines).toHaveLength(8);
});

it("does not encode rejected oversized text frames, but counts ordinary UTF-8 bytes", () => {
  const logger = getLogger("relay-ws");
  const lines: string[] = [];
  logger.setReporters([{ log: (value) => lines.push(value.args.join(" ")) }]);
  setLogLevel("debug");
  const encode = vi.spyOn(TextEncoder.prototype, "encode");
  try {
    logSocketFrame("relay.test", "←", "x".repeat(1024 * 1024 + 1));
    expect(encode).not.toHaveBeenCalled();
    expect(lines[0]).toContain("1048577 code units; oversized");
    logSocketFrame("relay.test", "←", "é");
    expect(lines[1]).toContain("(2 B)");
  } finally {
    encode.mockRestore();
  }
});
