import { test, expect } from "./source-fixture.mjs";

// Actual IndexedDB is required for compound-key cursor ordering, upgrade index
// population and auto-commit; the existing owner timeout/race suites stay intact.
test.beforeEach(async ({ page }) => {
  await page.goto("/tests/fixtures/head-persistence.html");
  await page.waitForFunction(() => window.headPersistence);
});

test("native head budget preserves global count, UTF8 bytes, expiry and tied order", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date("2026-10-28T05:00:00Z"));
  const result = await page.evaluate(async () => {
    const f = window.headPersistence,
      viewer = f.keypair(),
      cache = f.createHeadPersistence(viewer.pubkey, "relay");
    const event = f.message(viewer, "a", "shared", 10),
      now = Date.now();
    const make = (channelId, savedAt = now, events = [event]) => ({
      channelId,
      savedAt,
      events,
      profiles: [],
    });
    try {
      for (let i = 64; i >= 0; i--)
        await cache.write(make(`a${String(i).padStart(2, "0")}`));
      const tied = (await cache.read()).map((h) => h.channelId);
      await cache.write(make("expired", now - 86_400_000));
      const expiry = (await cache.read()).some(
        (h) => h.channelId === "expired",
      );
      await cache.clear();
      const big = f.message(viewer, "a", "é".repeat(1_600_000), 11);
      for (let i = 0; i < 3; i++)
        await cache.write(make(`large${i}`, now + i, [big]));
      const retained = await cache.read();
      const logicalBytes = retained.reduce(
        (n, h) => n + new TextEncoder().encode(JSON.stringify(h)).byteLength,
        0,
      );
      const before = retained.map((h) => h.channelId);
      await cache.write(
        make("large2", now + 4, [
          f.message(viewer, "a", "é".repeat(4_200_000), 12),
        ]),
      );
      const after = (await cache.read()).map((h) => h.channelId);
      return { tied, expiry, logicalBytes, before, after };
    } finally {
      await cache.clear();
      cache.close();
    }
  });
  expect(result.tied).toEqual(
    Array.from({ length: 64 }, (_, i) => `a${String(i).padStart(2, "0")}`),
  );
  expect(result.expiry).toBe(false);
  expect(result.logicalBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
  expect(result.before).toEqual(["large2", "large1"]);
  expect(result.after).toEqual(result.before);
});

test("native v2 whole records survive index upgrade and scoped mutations", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const f = window.headPersistence,
      viewer = f.keypair(),
      foreign = f.keypair();
    const scope = `${viewer.pubkey}:relay`,
      now = Date.now();
    const head = {
      channelId: "a",
      savedAt: now,
      events: [f.message(viewer, "a", "legacy signed wire", 10)],
      profiles: [],
    };
    const db = await new Promise((yes, no) => {
      const r = indexedDB.open("buzz-channel-heads-v1", 2);
      r.onupgradeneeded = () => {
        for (const name of ["heads", "startup"])
          r.result.createObjectStore(name, { keyPath: "key" });
      };
      r.onsuccess = () => yes(r.result);
      r.onerror = () => no(r.error);
    });
    await new Promise((yes, no) => {
      const tx = db.transaction("heads", "readwrite");
      tx.objectStore("heads").put({
        ...head,
        key: `${scope}:a`,
        scope,
        bytes: new TextEncoder().encode(JSON.stringify(head)).byteLength,
      });
      tx.oncomplete = yes;
      tx.onabort = () => no(tx.error);
    });
    db.close();
    const cache = f.createHeadPersistence(viewer.pubkey, "relay"),
      other = f.createHeadPersistence(foreign.pubkey, "relay");
    const clean = (h) => ({
      channelId: h.channelId,
      savedAt: h.savedAt,
      events: h.events,
      profiles: h.profiles,
    });
    try {
      const upgraded = (await cache.read()).map(clean);
      await cache.write({
        ...head,
        channelId: "b",
        events: [f.message(viewer, "b", "new wire", 11)],
      });
      await other.write({
        ...head,
        channelId: "foreign",
        events: [f.message(foreign, "foreign", "isolated", 12)],
      });
      await cache.retain(["a"]);
      const retained = (await cache.read()).map((h) => h.channelId);
      await cache.remove("a");
      const removed = await cache.read();
      await cache.write(head);
      await cache.clear();
      return {
        head,
        upgraded,
        retained,
        removed,
        cleared: await cache.read(),
        foreign: (await other.read()).map((h) => h.channelId),
      };
    } finally {
      await cache.clear();
      await other.clear();
      cache.close();
      other.close();
    }
  });
  expect(result.upgraded).toEqual([result.head]);
  expect(result.retained).toEqual(["a"]);
  expect(result.removed).toEqual([]);
  expect(result.cleared).toEqual([]);
  expect(result.foreign).toEqual(["foreign"]);
});

test("write-time global bounds include corrupt rows omitted by the budget index", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const f = window.headPersistence,
      a = f.keypair(),
      b = f.keypair(),
      now = Date.now();
    const mine = f.createHeadPersistence(a.pubkey, "relay"),
      foreign = f.createHeadPersistence(b.pubkey, "relay");
    const make = (id, time = now) => ({
      channelId: id,
      savedAt: time,
      events: [f.message(a, id, "wire", 10)],
      profiles: [],
    });
    const damage = async (expired) => {
      const db = await new Promise((yes, no) => {
        const r = indexedDB.open("buzz-channel-heads-v1");
        r.onsuccess = () => yes(r.result);
        r.onerror = () => no(r.error);
      });
      try {
        await new Promise((yes, no) => {
          const tx = db.transaction("heads", "readwrite"),
            store = tx.objectStore("heads"),
            r = store.get(`${b.pubkey}:relay:old`);
          r.onsuccess = () => {
            const row = r.result;
            delete row.bytes;
            if (expired) row.savedAt = now - 86_400_001;
            store.put(row);
          };
          tx.oncomplete = yes;
          tx.onabort = () => no(tx.error);
        });
      } finally {
        db.close();
      }
    };
    const physical = async () => {
      const db = await new Promise((yes, no) => {
        const r = indexedDB.open("buzz-channel-heads-v1");
        r.onsuccess = () => yes(r.result);
        r.onerror = () => no(r.error);
      });
      try {
        return await new Promise((yes, no) => {
          const tx = db.transaction("heads"),
            r = tx.objectStore("heads").count();
          tx.oncomplete = () => yes(r.result);
          tx.onabort = () => no(tx.error);
        });
      } finally {
        db.close();
      }
    };
    try {
      await foreign.write(make("old", now - 1000));
      await damage(false);
      for (let i = 0; i < 64; i++) await mine.write(make(`head-${i}`));
      const countAfter64 = await physical(),
        foreignAfter64 = (await foreign.read()).map((h) => h.channelId);
      await mine.clear();
      await foreign.clear();
      await foreign.write(make("old", now - 1000));
      await damage(true);
      await mine.write(make("fresh"));
      return {
        countAfter64,
        foreignAfter64,
        countAfterExpiry: await physical(),
      };
    } finally {
      await mine.clear();
      await foreign.clear();
      mine.close();
      foreign.close();
    }
  });
  expect(result).toEqual({
    countAfter64: 64,
    foreignAfter64: [],
    countAfterExpiry: 1,
  });
});
