import { test, expect } from "./source-fixture.mjs";

test("startup storage batches roster updates and prunes without transferring the roster", async ({
  page,
  context,
  sourceOrigin,
}, info) => {
  const url = `${sourceOrigin}/startup-persistence-test`;
  await context.route(url, (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
  );
  await page.goto(url);
  const replayStart = Date.now();
  await page.clock.install({ time: replayStart });
  await page.clock.pauseAt(replayStart + 60_000);
  await page.evaluate(async () => {
    const { createHeadPersistence } = await import(
      "/src/features/relay/persistence.ts"
    );
    const { createProfileDirectory } = await import(
      "/src/features/relay/profile-directory.ts"
    );
    const { createChannelStore } = await import("/src/features/relay/store.ts");
    const { keypair, metadata, roster } = await import(
      "/src/features/relay/testing.ts"
    );
    const relay = keypair();
    const { pubkey: viewer } = keypair();
    const agents = [keypair().pubkey, keypair().pubkey];
    const origin = "https://example.org";
    const otherOrigin = "https://other.example.org";
    const scope = `${viewer}:${origin}`;
    const otherScope = `${viewer}:${otherOrigin}`;
    const cache = createHeadPersistence(viewer, origin);
    const peer = createHeadPersistence(viewer, origin);
    const other = createHeadPersistence(viewer, otherOrigin);
    const channelId = (index) => `example-channel-${index}`;
    const channelRoster = (index, time, members = [viewer, ...agents]) =>
      roster(relay, channelId(index), members, time);
    const rosterSize = 1876;
    const events = Array.from({ length: rosterSize }, (_, index) => [
      channelRoster(index),
      metadata(relay, channelId(index), `Example task ${index}`, undefined, [
        ["about", "Synthetic task context. ".repeat(42)],
        ["visibility", "private"],
      ]),
    ]).flat();
    const bytes = (value) =>
      new TextEncoder().encode(JSON.stringify(value ?? null)).byteLength;
    const preferences = { savedAt: Date.now(), data: { sections: [] } };
    const saved = {
      discovery: { savedAt: Date.now(), relayAuthor: relay.pubkey, events },
      preferences,
    };
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("buzz-channel-heads-v1", 2);
      request.onupgradeneeded = () => {
        for (const name of ["heads", "startup"])
          request.result.createObjectStore(name, { keyPath: "key" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const writeLegacy = (key, data) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction("startup", "readwrite");
        tx.objectStore("startup").put({
          key,
          data,
          bytes: bytes(data),
          savedAt: Date.now(),
        });
        tx.oncomplete = resolve;
        tx.onabort = () => reject(tx.error);
      });
    await writeLegacy(scope, saved);
    const legacy = await cache.readStartup();
    await cache.writeStartup({ discovery: saved.discovery });
    await cache.writeProfiles([{ content: "m".repeat(2_000_000) }]);
    const otherEvent = channelRoster(3000);
    await other.writeStartup({
      discovery: { ...saved.discovery, events: [otherEvent] },
    });
    await cache.write({
      channelId: channelId(1),
      events: [],
      profiles: [],
      savedAt: Date.now(),
    });
    await other.write({
      channelId: channelId(3000),
      events: [],
      profiles: [],
      savedAt: Date.now(),
    });
    await peer.readStartup();
    const directory = createProfileDirectory(null);
    const channels = createChannelStore(
      {
        viewer,
        relayAuthor: relay.pubkey,
        read: async () => [],
        revokeAccess: (commit) => commit(),
        media: () => undefined,
        visible: (value) => value,
      },
      directory,
      { persistence: cache },
    );

    const counts = () => ({
      rosterWrites: 0,
      rosterReads: 0,
      bulkValueReads: 0,
      readBytes: 0,
      writtenBytes: 0,
    });
    let measured = counts();
    const methods = ["put", "get", "getAll", "getAllKeys", "openCursor"];
    const prototype = IDBObjectStore.prototype;
    const originals = methods.map((method) => prototype[method]);
    const inlineRoster = (value) =>
      Array.isArray(value?.data?.discovery?.events);
    const hasRoster = (value) =>
      inlineRoster(value) ||
      (Array.isArray(value?.data) &&
        value.data.some(
          (event) => event?.kind === 39002 || event?.kind === 39000,
        ));
    for (const [index, method] of methods.entries()) {
      prototype[method] = function (...args) {
        const request = originals[index].apply(this, args);
        if (this.name !== "startup") return request;
        const sample = measured;
        if (method === "put") {
          sample.writtenBytes += bytes(args[0]);
          if (inlineRoster(args[0])) sample.rosterWrites++;
        } else {
          if (method === "getAll" || method === "openCursor")
            sample.bulkValueReads++;
          request.addEventListener("success", () => {
            const value =
              method === "openCursor" ? request.result?.value : request.result;
            sample.readBytes += bytes(value);
            sample.rosterReads += Array.isArray(value)
              ? value.filter(hasRoster).length
              : Number(hasRoster(value));
          });
        }
        return request;
      };
    }
    const settle = () =>
      new Promise((resolve, reject) => {
        const tx = db.transaction("startup");
        tx.objectStore("startup").count();
        tx.oncomplete = resolve;
        tx.onabort = () => reject(tx.error);
      });
    const rawStorage = () =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(["startup", "heads"]);
        const startup = tx.objectStore("startup").getAll();
        const heads = tx.objectStore("heads").getAll();
        tx.oncomplete = () =>
          resolve({
            payloadKeys: startup.result
              .filter((row) => hasRoster(row) || Array.isArray(row.data))
              .map(({ key }) => key),
            headScopes: [...new Set(heads.result.map((row) => row.scope))],
          });
        tx.onabort = () => reject(tx.error);
      });
    channels.acceptDiscovery(events, undefined, undefined, false, false);
    let lastUpdate;
    window.rosterReplay = {
      update(index) {
        lastUpdate = channelRoster(index, 1_700_000_001);
        channels.acceptDiscovery([lastUpdate]);
      },
      repeat: (complete = false) =>
        channels.acceptDiscovery(
          [lastUpdate],
          complete
            ? new Set(
                Array.from({ length: rosterSize - 1 }, (_, index) =>
                  channelId(index + 1),
                ),
              )
            : undefined,
        ),
      unrelated: () => {
        channels.acceptDiscovery([
          metadata(relay, "preview", "Unjoined preview"),
        ]);
      },
      settle,
      async measure() {
        const replay = measured;
        measured = counts();
        await cache.writeProfiles([{ content: "m".repeat(5_000_000) }]);
        const prune = measured;
        measured = counts();
        const mirrorPruned = (await cache.readProfiles()).length === 0;
        measured = counts();
        const statuses = ["old", "newer", "newest"].map((id) => ({
          id,
          content: "s".repeat(1_600_000),
        }));
        await cache.writeProfiles([{ id: "name" }], statuses);
        const profileWrite = measured;
        measured = counts();
        const savedProfiles = (await cache.readProfiles()).map(({ id }) => id);
        return { replay, prune, mirrorPruned, profileWrite, savedProfiles };
      },
      async finish() {
        const current = await cache.readStartup();
        const removed = channelId(0);
        const changedPreferences = { ...preferences, savedAt: Date.now() + 1 };
        const saving = peer.writeStartup({ preferences: changedPreferences });
        channels.acceptDiscovery([channelRoster(0, 1_700_000_002, agents)]);
        await saving;
        const afterRevocation = await cache.readStartup();
        const oversized = await cache
          .writeStartup({
            preferences: {
              ...changedPreferences,
              data: {
                sections: [
                  { id: "oversized", name: "p".repeat(4_600_000), order: 0 },
                ],
              },
            },
          })
          .then(
            () => false,
            () => true,
          );
        await cache.writeProfiles([{ content: "Selected scope" }]);
        await other.writeProfiles([{ content: "Other scope" }]);
        lastUpdate = channelRoster(1, 1_700_000_002);
        channels.acceptDiscovery([lastUpdate]);
        const clear = (name, work) =>
          new Promise((resolve, reject) => {
            const tx = db.transaction(name, "readwrite");
            work(tx.objectStore(name));
            tx.oncomplete = resolve;
            tx.onabort = () => reject(tx.error);
          });
        // The v2 client clears these stores in two transactions.
        await clear("startup", (startup) => {
          startup.delete(scope);
          startup.delete(`${scope}:profiles`);
        });
        await clear("heads", (heads) => {
          const rows = heads.getAll();
          rows.onsuccess = () => {
            for (const row of rows.result)
              if (row.scope === scope) heads.delete(row.key);
          };
        });
        return {
          afterClear: await rawStorage(),
          legacyRestored:
            legacy.discovery.events.length === events.length &&
            legacy.preferences.savedAt === preferences.savedAt,
          initialBytes: bytes(saved),
          oversized,
          latestSaved: current.discovery.events.some(
            (event) =>
              event.kind === 39002 &&
              event.created_at === 1_700_000_001 &&
              event.tags[0][1] === channelId(19),
          ),
          immediatelyRevoked: !afterRevocation.discovery.events.some(
            (event) => event.tags[0][1] === removed,
          ),
          preferencesSaved:
            afterRevocation.preferences.savedAt === changedPreferences.savedAt,
        };
      },
      async cleanup() {
        try {
          return {
            ...(await rawStorage()),
            cleared: (await cache.readStartup()) === undefined,
            otherScope,
            otherEvent:
              (await other.readStartup())?.discovery?.events[0]?.id ===
              otherEvent.id,
          };
        } finally {
          channels.dispose();
          directory.dispose();
          peer.close();
          other.close();
          db.close();
          for (const [index, method] of methods.entries())
            prototype[method] = originals[index];
        }
      },
    };
  });

  let result;
  let remaining;
  try {
    for (let index = 0; index < 20; index++) {
      await page.evaluate((step) => window.rosterReplay.update(step), index);
      await page.clock.runFor(500);
      await page.evaluate(() => window.rosterReplay.settle());
    }
    const replay = await page.evaluate(() => window.rosterReplay.measure());
    await page.clock.runFor(30_000);
    await page.evaluate(() => window.rosterReplay.repeat());
    await page.clock.runFor(500);
    result = {
      ...replay,
      ...(await page.evaluate(() => window.rosterReplay.finish())),
    };
    await page.clock.runFor(30_500);
    await page.evaluate(() => window.rosterReplay.unrelated());
    await page.clock.runFor(500);
    await page.evaluate(() => window.rosterReplay.repeat(true));
    await page.clock.runFor(500);
  } finally {
    remaining = await page.evaluate(() => window.rosterReplay.cleanup());
  }
  await info.attach("roster-replay", {
    body: JSON.stringify(result, null, 2),
    contentType: "application/json",
  });
  const otherPayloads = {
    payloadKeys: [remaining.otherScope, `${remaining.otherScope}:profiles`],
    headScopes: [remaining.otherScope],
  };
  expect(result.afterClear).toEqual(otherPayloads);
  expect(remaining).toMatchObject({
    ...otherPayloads,
    cleared: true,
    otherEvent: true,
  });
  expect(result).toMatchObject({
    legacyRestored: true,
    replay: {
      rosterWrites: 1,
      rosterReads: 1,
      bulkValueReads: 0,
    },
    prune: { rosterReads: 0, rosterWrites: 0, bulkValueReads: 0 },
    mirrorPruned: true,
    profileWrite: { rosterReads: 0, rosterWrites: 0, bulkValueReads: 0 },
    savedProfiles: ["name", "newer", "newest"],
    latestSaved: true,
    immediatelyRevoked: true,
    preferencesSaved: true,
    oversized: true,
  });
  expect(result.initialBytes).toBeGreaterThan(3_500_000);
  expect(result.replay.readBytes + result.replay.writtenBytes).toBeLessThan(
    2.05 * result.initialBytes,
  );
});

test("startup retries honor the roster read before an abort and preserve peer writes", async ({
  page,
  context,
  sourceOrigin,
}) => {
  const url = `${sourceOrigin}/startup-persistence-test`;
  await context.route(url, (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
  );
  await page.goto(url);
  const start = Date.now();
  await page.clock.install({ time: start });
  await page.clock.pauseAt(start + 60_000);
  const firstRetry = await page.evaluate(async () => {
    const { createHeadPersistence } = await import(
      "/src/features/relay/persistence.ts"
    );
    const { createProfileDirectory } = await import(
      "/src/features/relay/profile-directory.ts"
    );
    const { createChannelStore } = await import("/src/features/relay/store.ts");
    const { keypair, roster } = await import("/src/features/relay/testing.ts");
    const relay = keypair();
    const { pubkey: viewer } = keypair();
    const origin = "https://example.org";
    const cache = createHeadPersistence(viewer, origin);
    const peer = createHeadPersistence(viewer, origin);
    const active = roster(relay, "active", [viewer]);
    const updated = roster(relay, "active", [viewer], 1_700_000_001);
    const scheduled = roster(relay, "active", [viewer], 1_700_000_002);
    const whilePending = roster(relay, "active", [viewer], 1_700_000_003);
    const beforeClear = roster(relay, "active", [viewer], 1_700_000_004);
    const afterClearUpdate = roster(relay, "active", [viewer], 1_700_000_005);
    const updates = {
      updated,
      scheduled,
      whilePending,
      beforeClear,
      afterClearUpdate,
    };
    const first = roster(relay, "first", [viewer]);
    const second = roster(relay, "second", [viewer]);
    const retried = roster(relay, "retried", [viewer]);
    const replacement = roster(relay, "peer-only", [viewer]);
    const startup = (events) => ({
      discovery: { savedAt: Date.now(), relayAuthor: relay.pubkey, events },
    });
    const cachedIds = async () =>
      (await peer.readStartup())?.discovery?.events.map((event) => event.id);
    const original = IDBObjectStore.prototype.get;
    let abortNext = false;
    let aborts = 0;
    let writeReads = 0;
    let holdPeerWrite = false;
    IDBObjectStore.prototype.get = function (key) {
      const request = original.call(this, key);
      if (
        this.name === "startup" &&
        this.transaction.mode === "readwrite" &&
        key === `${viewer}:${origin}`
      ) {
        writeReads++;
        if (abortNext) {
          abortNext = false;
          aborts++;
          this.transaction.abort();
        }
      }
      return request;
    };
    const directory = createProfileDirectory(null);
    const openChannels = (persistence, revalidate = false) =>
      createChannelStore(
        {
          viewer,
          relayAuthor: relay.pubkey,
          read: async () => [],
          revokeAccess: (commit) => commit(),
          media: () => undefined,
          visible: (value) => value,
        },
        directory,
        { persistence, prepared: true, revalidate },
      );
    let channels = openChannels(cache);
    const events = [active, first, second, retried];
    window.startupRetry = {
      revoke: async (id) => {
        abortNext = true;
        channels.acceptDiscovery([roster(relay, id, [], 1_700_000_001)]);
        return cachedIds();
      },
      replace: () => peer.writeStartup(startup([replacement])),
      clear: () => peer.clear(),
      repeat: () => channels.acceptDiscovery([active]),
      acceptUpdate: (name) => channels.acceptDiscovery([updates[name]]),
      async holdPeerWrite() {
        const database = await new Promise((resolve, reject) => {
          const request = indexedDB.open("buzz-channel-heads-v1");
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        holdPeerWrite = true;
        await new Promise((resolve) => {
          const transaction = database.transaction("startup", "readwrite");
          const store = transaction.objectStore("startup");
          transaction.oncomplete = () => database.close();
          // Keep both retry transactions behind the same peer transaction.
          const keepOpen = () => {
            if (holdPeerWrite) store.count().onsuccess = keepOpen;
          };
          store.count().onsuccess = () => {
            keepOpen();
            resolve();
          };
        });
      },
      releasePeerWrite() {
        holdPeerWrite = false;
      },
      async reload() {
        channels.dispose();
        await peer.writeStartup(startup([replacement]));
        channels = openChannels(createHeadPersistence(viewer, origin), true);
        await channels.restore();
        const cachedChannel = channels.queries.get("peer-only");
        abortNext = true;
        channels.acceptDiscovery([active]);
        return cachedChannel;
      },
      cachedIds,
      writeReads: () => writeReads,
      cleanup() {
        holdPeerWrite = false;
        IDBObjectStore.prototype.get = original;
        channels.dispose();
        directory.dispose();
        peer.close();
        return aborts;
      },
    };

    // The sidebar reads before the channel store restores the saved roster.
    const sidebarEmpty = (await cache.readStartup()) === undefined;
    const baseline = startup([active]);
    await peer.writeStartup(baseline);
    await channels.restore();
    const restored = channels.queries.get("active")?.cached;
    await peer.readStartup();
    abortNext = true;
    const patch = startup(events);
    const failed = await cache.writeStartup(patch).then(
      () => false,
      () => true,
    );
    const guardedRetry = () =>
      cache.writeStartup(patch, false, true).catch(() => {});
    await guardedRetry();
    const afterRetry = await cachedIds();
    await peer.clear();
    await guardedRetry();
    const clearSurvived = (await cachedIds()) === undefined;
    channels.acceptDiscovery(events);
    return {
      sidebarEmpty,
      restored,
      failed,
      clearSurvived,
      afterRetry,
      originalIds: events.map((event) => event.id),
      replacementId: replacement.id,
      updatedId: updated.id,
      whilePendingId: whilePending.id,
    };
  });

  let afterReplacement;
  let afterClear;
  let afterSecondClear;
  let afterRevocationRetry;
  let duringCooldown;
  let afterCooldown;
  let afterPendingUpdate;
  let cachedOnReload;
  let afterReloadAbort;
  let afterReloadRetry;
  let repeatReads;
  let aborts;
  try {
    await page.clock.runFor(500);
    expect(await page.evaluate(() => window.startupRetry.cachedIds())).toEqual(
      firstRetry.originalIds,
    );
    expect(
      await page.evaluate(() => window.startupRetry.revoke("retried")),
    ).toEqual(firstRetry.originalIds);
    await page.evaluate(() => window.startupRetry.repeat());
    await page.clock.runFor(500);
    afterRevocationRetry = await page.evaluate(() =>
      window.startupRetry.cachedIds(),
    );

    await page.evaluate(() => window.startupRetry.revoke("first"));
    await page.evaluate(() => window.startupRetry.replace());
    await page.evaluate(() => window.startupRetry.holdPeerWrite());
    const readsBeforeRetries = await page.evaluate(() =>
      window.startupRetry.writeReads(),
    );
    await page.evaluate(() => window.startupRetry.repeat());
    await page.clock.runFor(500);
    await page.evaluate(() => window.startupRetry.repeat());
    await page.clock.runFor(500);
    await expect
      .poll(() => page.evaluate(() => window.startupRetry.writeReads()))
      .toBe(readsBeforeRetries + 2);
    await page.evaluate(() => window.startupRetry.releasePeerWrite());
    afterReplacement = await page.evaluate(() =>
      window.startupRetry.cachedIds(),
    );
    const readsAtConflict = await page.evaluate(() =>
      window.startupRetry.writeReads(),
    );
    for (let i = 0; i < 2; i++) {
      await page.evaluate(() => window.startupRetry.repeat());
      await page.clock.runFor(500);
      await page.evaluate(() => window.startupRetry.cachedIds());
    }
    repeatReads =
      (await page.evaluate(() => window.startupRetry.writeReads())) -
      readsAtConflict;

    await page.evaluate(() => window.startupRetry.acceptUpdate("updated"));
    await page.clock.runFor(500);
    duringCooldown = await page.evaluate(() => window.startupRetry.cachedIds());
    await page.clock.runFor(30_000);
    await page.evaluate(() => window.startupRetry.acceptUpdate("updated"));
    await page.clock.runFor(500);
    afterCooldown = await page.evaluate(() => window.startupRetry.cachedIds());

    // Queue a routine save, then accept another version while its read waits.
    await page.evaluate(() => window.startupRetry.acceptUpdate("scheduled"));
    await page.evaluate(() => window.startupRetry.replace());
    await page.evaluate(() => window.startupRetry.holdPeerWrite());
    const readsBeforePending = await page.evaluate(() =>
      window.startupRetry.writeReads(),
    );
    await page.clock.runFor(30_000);
    await page.evaluate(() => window.startupRetry.acceptUpdate("scheduled"));
    await page.clock.runFor(500);
    await expect
      .poll(() => page.evaluate(() => window.startupRetry.writeReads()))
      .toBe(readsBeforePending + 1);
    await page.evaluate(() => window.startupRetry.acceptUpdate("whilePending"));
    await page.evaluate(() => window.startupRetry.releasePeerWrite());
    expect(await page.evaluate(() => window.startupRetry.cachedIds())).toEqual([
      firstRetry.replacementId,
    ]);
    await page.clock.runFor(30_000);
    await page.evaluate(() => window.startupRetry.acceptUpdate("whilePending"));
    await page.clock.runFor(500);
    afterPendingUpdate = await page.evaluate(() =>
      window.startupRetry.cachedIds(),
    );

    await page.evaluate(() => window.startupRetry.revoke("second"));
    await page.evaluate(() => window.startupRetry.replace());
    await page.evaluate(() => window.startupRetry.repeat());
    await page.clock.runFor(500);
    expect(await page.evaluate(() => window.startupRetry.cachedIds())).toEqual([
      firstRetry.replacementId,
    ]);
    await page.evaluate(() => window.startupRetry.acceptUpdate("beforeClear"));
    await page.evaluate(() => window.startupRetry.clear());
    await page.clock.runFor(30_000);
    await page.evaluate(() => window.startupRetry.acceptUpdate("beforeClear"));
    await page.clock.runFor(500);
    afterClear = await page.evaluate(() => window.startupRetry.cachedIds());
    const readsAfterClear = await page.evaluate(() =>
      window.startupRetry.writeReads(),
    );
    await page.evaluate(async () => {
      window.startupRetry.acceptUpdate("afterClearUpdate");
      await window.startupRetry.replace();
      await window.startupRetry.clear();
    });
    await page.clock.runFor(600_500);
    const readsAfterSecondClear = await page.evaluate(() =>
      window.startupRetry.writeReads(),
    );
    expect(readsAfterSecondClear).toBe(readsAfterClear + 1);
    await page.evaluate(() =>
      window.startupRetry.acceptUpdate("afterClearUpdate"),
    );
    await page.clock.runFor(500);
    afterSecondClear = await page.evaluate(() =>
      window.startupRetry.cachedIds(),
    );
    expect
      .soft(await page.evaluate(() => window.startupRetry.writeReads()))
      .toBe(readsAfterSecondClear);

    cachedOnReload = await page.evaluate(() => window.startupRetry.reload());
    await page.clock.runFor(500);
    afterReloadAbort = await page.evaluate(() =>
      window.startupRetry.cachedIds(),
    );
    await page.clock.runFor(30_000);
    await page.evaluate(() => window.startupRetry.repeat());
    await page.clock.runFor(500);
    afterReloadRetry = await page.evaluate(() =>
      window.startupRetry.cachedIds(),
    );
  } finally {
    aborts = await page.evaluate(() => window.startupRetry.cleanup());
  }
  expect(aborts).toBe(5);
  expect(firstRetry.sidebarEmpty).toBe(true);
  expect(firstRetry.restored).toBe(true);
  expect(firstRetry.failed).toBe(true);
  expect.soft(firstRetry.clearSurvived).toBe(true);
  expect.soft(firstRetry.afterRetry).toEqual(firstRetry.originalIds);
  expect(afterRevocationRetry).toEqual(firstRetry.originalIds.slice(0, -1));
  expect.soft(afterReplacement).toEqual([firstRetry.replacementId]);
  expect.soft(repeatReads).toBe(0);
  expect.soft(duringCooldown).toEqual([firstRetry.replacementId]);
  expect
    .soft(afterCooldown)
    .toEqual([firstRetry.updatedId, firstRetry.originalIds[2]]);
  expect
    .soft(afterPendingUpdate)
    .toEqual([firstRetry.whilePendingId, firstRetry.originalIds[2]]);
  expect.soft(afterClear).toBeUndefined();
  expect.soft(afterSecondClear).toBeUndefined();
  expect.soft(cachedOnReload).toBeUndefined();
  expect.soft(afterReloadAbort).toEqual([firstRetry.replacementId]);
  expect.soft(afterReloadRetry).toEqual([firstRetry.originalIds[0]]);
});
