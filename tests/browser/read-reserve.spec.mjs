import { test, expect } from "./source-fixture.mjs";
import { writeFile } from "node:fs/promises";

// Real browser storage/coordination boundary; the full app journey is in unread.spec.mjs.
test("reserve commits across windows, survives reload, and is purged with only its partition", async ({
  page,
  context,
  sourceOrigin,
}, testInfo) => {
  await context.route(`${sourceOrigin}/reserve-test`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Read storage boundary</title>",
    }),
  );
  const peer = await context.newPage();
  const start = async (window) => {
    await window.goto(`${sourceOrigin}/reserve-test`);
    await window.evaluate(async () => {
      const { createReadState } = await import(
        "/src/features/relay/read-state.ts"
      );
      const { browserReadStateStorage } = await import(
        "/src/features/relay/read-state-storage.ts"
      );
      window.store = browserReadStateStorage("reserve-test", "a".repeat(64));
      window.owner = createReadState({
        viewer: "a".repeat(64),
        storage: window.store,
        reader: { read: async () => [] },
        host: {
          decode: async () => [],
          sign: async () => {
            throw new Error("No signing in storage test");
          },
          publish: async () => {},
        },
        lock: async (_signal, work) => work(),
        broadcastName: "reserve-test",
        debounceMs: 60000,
      });
      await window.owner.ready;
    });
  };
  try {
    await start(page);
    await page.evaluate(() => window.owner.read("msg:old", 20, () => true));
    await start(peer);
    await Promise.all(
      [page, peer].map((window, batch) =>
        window.evaluate(async (batch) => {
          await window.owner.readMessages(
            Array.from({ length: 1000 }, (_, n) => ({
              key: `msg:${(batch * 1000 + n).toString(16).padStart(64, "0")}`,
              timestamp: 100 + n,
              channelId: "room",
            })),
            undefined,
            () => true,
          );
        }, batch),
      ),
    );
    for (const window of [page, peer])
      await expect
        .poll(() =>
          window.evaluate(
            () => Object.keys(window.owner.state().frontiers).length,
          ),
        )
        .toBe(2001);
    const saved = await page.evaluate(() =>
      window.store.update((current) => current),
    );
    expect(saved.state.frontiers["msg:old"]).toBeUndefined();
    expect(saved.reserve["msg:old"]).toBe(20);
    await page.evaluate(() => window.owner.dispose());
    await start(page);
    expect(
      await page.evaluate(() => window.owner.state().frontiers["msg:old"]),
    ).toBe(20);
    await peer.evaluate(() => window.owner.dispose());

    // Diagnostic, not a flaky performance threshold: strict commit latency at
    // the same full journal, with and without the maximum message reserve.
    const timings = await page.evaluate(async () => {
      const result = [];
      for (const size of [0, 5000]) {
        await window.store.update((current) => ({
          ...current,
          reserve: Object.fromEntries(
            Array.from({ length: size }, (_, n) => [
              `msg:${(10000 + n).toString(16).padStart(64, "0")}`,
              1,
            ]),
          ),
        }));
        const samples = [];
        for (let n = 0; n < 20; n++) {
          const before = performance.now();
          await window.owner.read("msg:measured", 1000 + size + n, () => true);
          samples.push(performance.now() - before);
        }
        const journal = await window.store.update((current) => current);
        result.push({
          size,
          samples,
          bytes: new TextEncoder().encode(JSON.stringify(journal)).length,
        });
      }
      return result;
    });
    const timingPath = testInfo.outputPath("strict-save-latency.json");
    await writeFile(timingPath, JSON.stringify(timings));
    await testInfo.attach("strict-save-latency.json", {
      path: timingPath,
      contentType: "application/json",
    });
    const purged = await page.evaluate(async () => {
      const { browserReadStateStorage, purgeReadStateStorage, newReadJournal } =
        await import("/src/features/relay/read-state-storage.ts");
      const other = browserReadStateStorage("other-partition", "a".repeat(64));
      await other.update(() => ({
        ...newReadJournal(),
        reserve: { "msg:other": 9 },
      }));
      window.owner.dispose();
      await purgeReadStateStorage("reserve-test");
      const fresh = browserReadStateStorage("reserve-test", "a".repeat(64));
      let absent;
      await fresh.update((current) => {
        absent = current === undefined;
        return newReadJournal();
      });
      const neighbor = await other.update((current) => current);
      fresh.close();
      other.close();
      return { absent, reserve: neighbor.reserve };
    });
    expect(purged).toEqual({ absent: true, reserve: { "msg:other": 9 } });
  } finally {
    for (const window of [page, peer])
      await window.evaluate(() => window.owner?.dispose());
    await peer.close();
  }
});
