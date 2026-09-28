import type { ViteHotContext } from "vite/types/hot.d.ts";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
async function client(supported = true) {
  vi.resetModules();
  vi.stubEnv("BUZZ_DEV_SETTINGS", supported ? "1" : "0");
  const requests: { resolve: (response: Response) => void }[] = [];
  const fetcher = vi.fn(() => {
    return new Promise<Response>((resolve) => {
      requests.push({ resolve });
    });
  });
  vi.stubGlobal("fetch", fetcher);
  const logging = await import("./logging");
  const handlers = new Map<string, (value?: unknown) => void>();
  let dispose = () => {};
  const hot = {
    on: (event: string, callback: (value?: unknown) => void) =>
      handlers.set(event, callback),
    off: (event: string) => handlers.delete(event),
    dispose: (callback: () => void) => {
      dispose = callback;
    },
  } as unknown as ViteHotContext;
  logging.connectDeveloperSettings(hot);
  const reply = (index: number, logLevel: string, revision: number) => {
    const request = requests[index];
    if (!request) throw new Error(`Missing request ${index}`);
    request.resolve(Response.json({ logLevel, revision }));
  };
  return { ...logging, handlers, fetcher, reply, dispose: () => dispose() };
}
it("does not subscribe or fetch without the serving capability (including production)", async () => {
  const c = await client(false);
  await expect(c.developerSettings()).rejects.toThrow("unavailable");
  await expect(c.developerSettings("debug")).rejects.toThrow("unavailable");
  expect(c.fetcher).not.toHaveBeenCalled();
  expect(c.handlers.size).toBe(0);
  vi.stubEnv("DEV", false);
  vi.stubEnv("BUZZ_DEV_SETTINGS", "1");
  c.connectDeveloperSettings({} as ViteHotContext);
  await expect(c.developerSettings()).rejects.toThrow("unavailable");
  expect(c.fetcher).not.toHaveBeenCalled();
});
it("a delayed GET cannot overwrite a completed save", async () => {
  const c = await client();
  try {
    const initial = c.developerSettings();
    const save = c.developerSettings("debug");
    c.reply(2, "debug", 1);
    await save;
    c.reply(1, "info", 0);
    await initial;
    c.reply(0, "info", 0);
    expect(c.logLevel()).toBe("debug");
  } finally {
    c.dispose();
  }
});
it.each([undefined, "debug"] as const)(
  "a delayed %s response cannot overwrite a newer HMR snapshot",
  async (level) => {
    const c = await client();
    try {
      const request = c.developerSettings(level);
      c.handlers.get(c.LOG_LEVEL_EVENT)?.({ logLevel: "silent", revision: 2 });
      c.reply(1, level ?? "info", level ? 1 : 0);
      expect(await request).toBe("silent");
      c.reply(0, "info", 0);
      expect(c.logLevel()).toBe("silent");
    } finally {
      c.dispose();
    }
  },
);
it("refreshes when the initial HMR socket opens after a missed save", async () => {
  const c = await client();
  try {
    c.reply(0, "info", 0);
    // The save happened while the socket was not open; no event was received.
    c.handlers.get("vite:ws:connect")?.();
    expect(c.fetcher).toHaveBeenCalledTimes(2);
    c.reply(1, "warn", 1);
    await vi.waitFor(() => expect(c.logLevel()).toBe("warn"));
  } finally {
    c.dispose();
  }
});
