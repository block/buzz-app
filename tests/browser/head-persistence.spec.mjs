import { test, expect } from "./source-fixture.mjs";

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/fixtures/head-persistence.html");
  await page.waitForFunction(() => window.headPersistence);
});

// Browser-only boundary: actual IDB transaction auto-commit, reopen, shared-wire
// reference cleanup and migration. Session admission still verifies real signatures.
test("signed heads survive atomic replacement, reopen and session hydration with scoped cleanup", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const f = window.headPersistence;
    const viewer = f.keypair(),
      relay = f.keypair();
    const now = Date.now();
    const profile = f.profile(viewer, { name: "Persisted author" });
    const first = f.message(viewer, "a", "oldest", 10);
    const last = f.message(viewer, "a", "newest", 11);
    const head = {
      channelId: "a",
      savedAt: now,
      events: [
        last,
        first,
        f.bounds(relay, "a", "head", { has_more: false, next_cursor: null }),
      ],
      profiles: [profile, profile],
    };
    const cache = f.createHeadPersistence(viewer.pubkey, "relay");
    const other = f.createHeadPersistence("other", "relay");
    const copies = JSON.parse(JSON.stringify(head));
    try {
      await cache.writeStartup({
        discovery: {
          savedAt: now,
          relayAuthor: relay.pubkey,
          events: [
            f.roster(relay, "a", [viewer.pubkey]),
            f.metadata(relay, "a", "A"),
          ],
        },
      });
      await cache.write(head);
      await cache.write({ ...head, channelId: "b" });
      await other.write({ ...head, channelId: "private-other" });
    } finally {
      cache.close();
      other.close();
    }
    const restored = f.createHeadPersistence(viewer.pubkey, "relay");
    const read = await restored.read();
    const exactWire =
      JSON.stringify(read.find((h) => h.channelId === "a")) ===
      JSON.stringify(copies);
    const valid = read
      .flatMap((h) => [...h.events, ...h.profiles])
      .every((value) => f.eventDto(value).id);
    const owner = f.createRelaySession(
      {
        viewer: viewer.pubkey,
        relayAuthor: relay.pubkey,
        query: async () => [],
        media: () => undefined,
      },
      {
        persistence: restored,
        prepared: true,
        cachedOnly: true,
        initialChannelId: "a",
      },
    );
    try {
      await owner.restore();
      owner.session.channels.ensure("a");
      const rows = owner.session.channels
        .window("a")
        .rows.map((r) => ({ id: r.id, content: r.content }));
      const cached = owner.session.channels.window("a").freshness;
      let postingError;
      try {
        owner.session.messages.send("a", "must not publish cached evidence");
      } catch (error) {
        postingError = error.message;
      }
      await restored.remove("b");
      const afterRemove = (await restored.read()).map((h) => h.channelId);
      await restored.retain([]);
      const removed = await restored.read();
      const isolation = f.createHeadPersistence("other", "relay");
      try {
        const otherRows = await isolation.read();
        await restored.clear();
        const afterClear = await isolation.read();
        await isolation.clear();
        const db = await new Promise((yes, no) => {
          const r = indexedDB.open("buzz-channel-heads-v1");
          r.onsuccess = () => yes(r.result);
          r.onerror = () => no(r.error);
        });
        const counts = await new Promise((yes, no) => {
          const tx = db.transaction(["heads", "payloads", "references"]);
          const requests = ["heads", "payloads", "references"].map((name) =>
            tx.objectStore(name).count(),
          );
          tx.oncomplete = () => yes(requests.map((r) => r.result));
          tx.onabort = () => no(tx.error);
        });
        db.close();
        return {
          exactWire,
          valid: Boolean(valid),
          rows,
          expected: [
            { id: first.id, content: first.content },
            { id: last.id, content: last.content },
          ],
          cached,
          postingError,
          afterRemove,
          removed,
          otherRows: otherRows.map((h) => h.channelId),
          afterClear: afterClear.map((h) => h.channelId),
          counts,
        };
      } finally {
        isolation.close();
      }
    } finally {
      owner.dispose();
      restored.close();
    }
  });
  expect(result.exactWire).toBe(true);
  expect(result.valid).toBe(true);
  expect(result.rows).toEqual(result.expected);
  expect(result.cached).toBe("cached");
  expect(result.postingError).toBe("Join the conversation before posting");
  expect(result.afterRemove).toEqual(["a"]);
  expect(result.removed).toEqual([]);
  expect(result.otherRows).toEqual(["private-other"]);
  expect(result.afterClear).toEqual(["private-other"]);
  expect(result.counts).toEqual([0, 0, 0]);
});

test("corrupt and missing shared wires isolate one head and fresh writes repair them", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const f = window.headPersistence,
      viewer = f.keypair();
    const cache = f.createHeadPersistence(viewer.pubkey, "relay");
    const make = (channelId) => ({
      channelId,
      savedAt: Date.now(),
      events: [f.message(viewer, channelId, channelId, 10)],
      profiles: [],
    });
    const a = make("a"),
      b = make("b");
    const outcomes = [];
    try {
      for (const fault of ["missing", "json", "manifest"]) {
        await cache.write(a);
        await cache.write(b);
        const db = await new Promise((yes, no) => {
          const r = indexedDB.open("buzz-channel-heads-v1");
          r.onsuccess = () => yes(r.result);
          r.onerror = () => no(r.error);
        });
        await new Promise((yes, no) => {
          const tx = db.transaction(["heads", "payloads"], "readwrite");
          const request = tx
            .objectStore("heads")
            .get(`${viewer.pubkey}:relay:a`);
          request.onsuccess = () => {
            const row = request.result,
              key = `${viewer.pubkey}:relay:${row.eventRefs[0]}`;
            if (fault === "missing") tx.objectStore("payloads").delete(key);
            else if (fault === "json")
              tx.objectStore("payloads").put({
                key,
                scope: `${viewer.pubkey}:relay`,
                wire: "broken JSON",
              });
            else tx.objectStore("heads").put({ ...row, eventRefs: null });
          };
          tx.oncomplete = yes;
          tx.onabort = () => no(tx.error);
        });
        db.close();
        const isolated = (await cache.read()).map((h) => h.channelId);
        await cache.write(a);
        const repaired = await cache.read();
        outcomes.push({
          fault,
          isolated,
          repaired: repaired.map((h) => h.channelId).sort(),
          content: repaired.find((h) => h.channelId === "a")?.events[0].content,
        });
      }
      return outcomes;
    } finally {
      await cache.clear();
      cache.close();
    }
  });
  expect(result).toEqual(
    ["missing", "json", "manifest"].map((fault) => ({
      fault,
      isolated: ["b"],
      repaired: ["a", "b"],
      content: "a",
    })),
  );
});

test("native transaction abort after a queued write leaves the prior complete head and no orphan wire", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const f = window.headPersistence,
      viewer = f.keypair();
    const cache = f.createHeadPersistence(viewer.pubkey, "relay");
    const head = {
      channelId: "a",
      savedAt: Date.now(),
      events: [f.message(viewer, "a", "before abort", 10)],
      profiles: [],
    };
    await cache.write(head);
    const put = IDBObjectStore.prototype.put;
    let aborted = false,
      rejected = false;
    IDBObjectStore.prototype.put = function (...args) {
      const request = put.apply(this, args);
      if (this.name === "heads" && !aborted) {
        request.addEventListener(
          "success",
          () => {
            aborted = true;
            this.transaction.abort();
          },
          { once: true },
        );
      }
      return request;
    };
    try {
      try {
        await cache.write({
          ...head,
          events: [f.message(viewer, "a", "must roll back", 11)],
        });
      } catch {
        rejected = true;
      }
    } finally {
      IDBObjectStore.prototype.put = put;
    }
    try {
      const records = await cache.read();
      const db = await new Promise((yes, no) => {
        const r = indexedDB.open("buzz-channel-heads-v1");
        r.onsuccess = () => yes(r.result);
        r.onerror = () => no(r.error);
      });
      const counts = await new Promise((yes, no) => {
        const tx = db.transaction(["payloads", "references"]);
        const a = tx.objectStore("payloads").count(),
          b = tx.objectStore("references").count();
        tx.oncomplete = () => yes([a.result, b.result]);
        tx.onabort = () => no(tx.error);
      });
      db.close();
      return {
        aborted,
        rejected,
        contents: records.flatMap((h) => h.events.map((e) => e.content)),
        counts,
      };
    } finally {
      await cache.clear();
      cache.close();
    }
  });
  expect(result).toEqual({
    aborted: true,
    rejected: true,
    contents: ["before abort"],
    counts: [1, 1],
  });
});

test("v2 upgrade keeps legacy order and supports mixed normalized writes without clearing old content", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const f = window.headPersistence,
      viewer = f.keypair();
    const head = {
      channelId: "legacy",
      savedAt: Date.now(),
      events: [f.message(viewer, "legacy", "old cache", 10)],
      profiles: [],
    };
    const db = await new Promise((yes, no) => {
      const r = indexedDB.open("buzz-channel-heads-v1", 2);
      r.onupgradeneeded = () => {
        r.result.createObjectStore("heads", { keyPath: "key" });
        r.result.createObjectStore("startup", { keyPath: "key" });
      };
      r.onsuccess = () => yes(r.result);
      r.onerror = () => no(r.error);
    });
    await new Promise((yes, no) => {
      const tx = db.transaction("heads", "readwrite");
      tx.objectStore("heads").put({
        ...head,
        key: `${viewer.pubkey}:relay:legacy`,
        scope: `${viewer.pubkey}:relay`,
        bytes: new TextEncoder().encode(JSON.stringify(head)).byteLength,
      });
      tx.oncomplete = yes;
      tx.onabort = () => no(tx.error);
    });
    db.close();
    const cache = f.createHeadPersistence(viewer.pubkey, "relay");
    try {
      const legacy = await cache.read();
      await cache.write({ ...head, channelId: "new" });
      const mixed = await cache.read();
      await cache.retain(["legacy"]);
      return {
        legacy: legacy.map((h) => h.channelId),
        mixed: mixed.map((h) => h.channelId),
        retained: (await cache.read()).map((h) => h.channelId),
        contents: mixed.map((h) => h.events[0].content),
      };
    } finally {
      await cache.clear();
      cache.close();
    }
  });
  expect(result).toEqual({
    legacy: ["legacy"],
    mixed: ["legacy", "new"],
    retained: ["legacy"],
    contents: ["old cache", "old cache"],
  });
});

test("native blocked upgrade, versionchange and late close failures preserve legacy content", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const f = window.headPersistence,
      viewer = f.keypair();
    const head = {
      channelId: "a",
      savedAt: Date.now(),
      events: [f.message(viewer, "a", "preserved", 10)],
      profiles: [],
    };
    const legacy = await new Promise((yes, no) => {
      const r = indexedDB.open("buzz-channel-heads-v1", 2);
      r.onupgradeneeded = () => {
        r.result.createObjectStore("heads", { keyPath: "key" });
        r.result.createObjectStore("startup", { keyPath: "key" });
      };
      r.onsuccess = () => yes(r.result);
      r.onerror = () => no(r.error);
    });
    await new Promise((yes, no) => {
      const tx = legacy.transaction("heads", "readwrite");
      tx.objectStore("heads").put({
        ...head,
        key: `${viewer.pubkey}:relay:a`,
        scope: `${viewer.pubkey}:relay`,
        bytes: JSON.stringify(head).length,
      });
      tx.oncomplete = yes;
      tx.onabort = () => no(tx.error);
    });
    const blocked = f.createHeadPersistence(viewer.pubkey, "relay");
    let blockedError;
    try {
      await blocked.read();
    } catch (error) {
      blockedError = error.message;
    } finally {
      blocked.close();
      legacy.close();
    }
    const active = f.createHeadPersistence(viewer.pubkey, "relay");
    const before = (await active.read()).map((h) => h.events[0].content);
    const upgrade = await new Promise((yes, no) => {
      const r = indexedDB.open("buzz-channel-heads-v1", 4);
      r.onsuccess = () => yes(r.result);
      r.onerror = () => no(r.error);
    });
    let versionChangedWriteRejected = false;
    try {
      await active.write({ ...head, events: [] });
    } catch {
      versionChangedWriteRejected = true;
    } finally {
      active.close();
      upgrade.close();
    }
    const unavailable = f.createHeadPersistence(viewer.pubkey, "relay");
    let openRejected = false;
    try {
      await unavailable.read();
    } catch {
      openRejected = true;
    } finally {
      unavailable.close();
    }
    const closed = f.createHeadPersistence(viewer.pubkey, "relay");
    closed.close();
    let lateWriteRejected = false;
    try {
      await closed.write(head);
    } catch {
      lateWriteRejected = true;
    }
    const db = await new Promise((yes, no) => {
      const r = indexedDB.open("buzz-channel-heads-v1");
      r.onsuccess = () => yes(r.result);
      r.onerror = () => no(r.error);
    });
    const after = await new Promise((yes, no) => {
      const tx = db.transaction("heads");
      const r = tx.objectStore("heads").get(`${viewer.pubkey}:relay:a`);
      tx.oncomplete = () => yes(r.result.events[0].content);
      tx.onabort = () => no(tx.error);
    });
    db.close();
    return {
      blockedError,
      before,
      versionChangedWriteRejected,
      openRejected,
      lateWriteRejected,
      after,
    };
  });
  expect(result).toEqual({
    blockedError: "Cache blocked",
    before: ["preserved"],
    versionChangedWriteRejected: true,
    openRejected: true,
    lateWriteRejected: true,
    after: "preserved",
  });
});

test("real disk tampering and signed denied membership never become session history", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const f = window.headPersistence,
      viewer = f.keypair(),
      relay = f.keypair();
    const output = [];
    for (const mode of ["signature", "membership"]) {
      const cache = f.createHeadPersistence(viewer.pubkey, mode);
      const event = f.message(viewer, "a", "private cache", 10);
      await cache.writeStartup({
        discovery: {
          savedAt: Date.now(),
          relayAuthor: relay.pubkey,
          events: [
            f.roster(relay, "a", mode === "membership" ? [] : [viewer.pubkey]),
            f.metadata(relay, "a", "A"),
          ],
        },
      });
      await cache.write({
        channelId: "a",
        savedAt: Date.now(),
        events: [
          mode === "signature" ? { ...event, sig: "0".repeat(128) } : event,
          f.bounds(relay, "a", "head", { has_more: false, next_cursor: null }),
        ],
        profiles: [],
      });
      cache.close();
      const restored = f.createHeadPersistence(viewer.pubkey, mode);
      const owner = f.createRelaySession(
        {
          viewer: viewer.pubkey,
          relayAuthor: relay.pubkey,
          query: async () => {
            throw new Error("No network for cached authority");
          },
          media: () => undefined,
        },
        {
          persistence: restored,
          prepared: true,
          cachedOnly: true,
          initialChannelId: "a",
        },
      );
      try {
        await owner.restore();
        owner.session.channels.ensure("a");
        output.push({
          mode,
          rows: owner.session.channels.window("a").rows.map((r) => r.content),
        });
        await restored.clear();
      } finally {
        owner.dispose();
        restored.close();
      }
    }
    return output;
  });
  expect(result).toEqual([
    { mode: "signature", rows: [] },
    { mode: "membership", rows: [] },
  ]);
});

test("logical global head count, UTF8 bytes, expiry and tied order stay bounded with shared wires", async ({
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
      const db = await new Promise((yes, no) => {
        const r = indexedDB.open("buzz-channel-heads-v1");
        r.onsuccess = () => yes(r.result);
        r.onerror = () => no(r.error);
      });
      const counts = await new Promise((yes, no) => {
        const tx = db.transaction(["heads", "payloads", "references"]);
        const requests = ["heads", "payloads", "references"].map((n) =>
          tx.objectStore(n).count(),
        );
        tx.oncomplete = () => yes(requests.map((r) => r.result));
        tx.onabort = () => no(tx.error);
      });
      db.close();
      return { tied, expiry, logicalBytes, before, after, counts };
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
  expect(result.counts).toEqual([2, 1, 2]);
});
