import { test, expect } from "./source-fixture.mjs";
import { stopRoutes } from "./playwright-test.mjs";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import {
  signReadState,
  decodeReadState,
} from "../../browser-host/read-state.mjs";

// Real IndexedDB connections must reserve the read-start snapshot before the
// owner queue resumes; the Node owner tests cannot establish that browser order.
for (const { alreadyIngested, redeliver } of [
  { alreadyIngested: false, redeliver: true },
  { alreadyIngested: true, redeliver: true },
  { alreadyIngested: false, redeliver: false },
  { alreadyIngested: true, redeliver: false },
]) {
  test(`read-start capture separates peer ingest before invocation: ${alreadyIngested}, redeliver: ${redeliver}`, async ({
    page,
    context,
    sourceOrigin,
  }) => {
    const secret = generateSecretKey();
    const viewer = getPublicKey(secret);
    const key = `msg:${"a".repeat(64)}`;
    const marker = signReadState(
      {
        slot: "b".repeat(32),
        createdAt: 100,
        blob: {
          v: 1,
          client_id: "peer",
          contexts: {
            [`ov_s:${key}`]: 1,
            [`ov_c:${key}`]: 0,
            [`ov_b:${key}`]: 0,
          },
        },
      },
      secret,
      100,
    );
    await context.route(`${sourceOrigin}/read-ordering`, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>Read ordering</title>",
      }),
    );
    const peer = await context.newPage();
    for (const window of [page, peer]) {
      await window.exposeFunction("decodeMarkers", (events) =>
        decodeReadState(events, secret),
      );
      await window.goto(`${sourceOrigin}/read-ordering`);
      await window.evaluate(
        async ({ viewer }) => {
          const { createReadState } = await import(
            "/src/features/relay/read-state.ts"
          );
          const { browserReadStateStorage } = await import(
            "/src/features/relay/read-state-storage.ts"
          );
          window.store = browserReadStateStorage("read-ordering", viewer);
          window.owner = createReadState({
            viewer,
            storage: window.store,
            reader: { read: async () => [] },
            host: {
              decode: window.decodeMarkers,
              sign: async () => {
                throw new Error("No signing in ordering test");
              },
              publish: async () => {},
            },
            lock: async (_signal, work) => work(),
            now: () => 100,
            debounceMs: 60000,
          });
          await window.owner.ready;
        },
        { viewer },
      );
    }
    try {
      // Hold the queue BEFORE reserving an actual save transaction. No
      // broadcast or pre-refresh is allowed to freshen this window's cache.
      await peer.evaluate(async () => {
        const update = window.store.update.bind(window.store);
        let started;
        const held = new Promise((resolve) => {
          started = resolve;
        });
        const gate = new Promise((resolve) => {
          window.releaseHold = resolve;
        });
        window.store.update = async (change) => {
          window.store.update = update;
          started();
          await gate;
          return update(change);
        };
        window.queued = window.owner.learnHomes({}).then(
          () => null,
          (error) => error.message,
        );
        await held;
      });
      const ingest = () =>
        page.evaluate(async (marker) => {
          window.owner.accept([marker]);
          await window.owner.learnHomes({});
        }, marker);
      if (alreadyIngested) await ingest();
      await peer.evaluate((key) => {
        window.reading = window.owner
          .read(key, 11, () => true)
          .then(
            () => null,
            (error) => error.message,
          );
      }, key);
      if (!alreadyIngested) await ingest();
      if (redeliver)
        await peer.evaluate((marker) => window.owner.accept([marker]), marker);
      const result = await peer.evaluate(async (key) => {
        window.releaseHold();
        const errors = await Promise.all([window.queued, window.reading]);
        await window.owner.learnHomes({});
        const journal = await window.store.read();
        const { overrideActive } = await import(
          "/src/features/relay/read-state-model.ts"
        );
        return {
          errors,
          frontier: journal.state.frontiers[key],
          baseline: journal.state.overrides[key].baseline,
          unread: overrideActive(
            journal.state.overrides[key],
            journal.state.frontiers[key],
          ),
          pending: journal.peerOverlaps ?? [],
        };
      }, key);
      expect(result).toEqual({
        errors: [null, null],
        frontier: 11,
        baseline: alreadyIngested ? 0 : 11,
        unread: !alreadyIngested,
        pending: [],
      });
    } finally {
      for (const window of [page, peer])
        await window.evaluate(() => {
          window.releaseHold?.();
          window.owner?.dispose();
        });
      await stopRoutes(context);
      await peer.close();
    }
  });
}

test("capture rejects cold or closed storage instead of deferring its reservation", async ({
  page,
  context,
  sourceOrigin,
}) => {
  await context.route(`${sourceOrigin}/capture-lifecycle`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Capture lifecycle</title>",
    }),
  );
  await page.goto(`${sourceOrigin}/capture-lifecycle`);
  const result = await page.evaluate(async () => {
    const { browserReadStateStorage } = await import(
      "/src/features/relay/read-state-storage.ts"
    );
    const store = browserReadStateStorage("capture-lifecycle", "a".repeat(64));
    const error = (work) =>
      work.then(
        () => null,
        (cause) => cause.message,
      );
    let owner;
    try {
      const cold = await error(store.capture());
      const { createReadState } = await import(
        "/src/features/relay/read-state.ts"
      );
      owner = createReadState({
        viewer: "a".repeat(64),
        storage: store,
        reader: { read: async () => [] },
        host: {
          decode: async () => [],
          sign: async () => {
            throw new Error("No signing in lifecycle test");
          },
          publish: async () => {},
        },
        lock: async (_signal, work) => work(),
        debounceMs: 60000,
      });
      const early = await error(owner.read("msg:early", 11, () => true));
      await owner.ready;
      const untouched = owner.state().frontiers["msg:early"];
      await owner.read("msg:early", 11, () => true);
      const retried = owner.state().frontiers["msg:early"];
      const captured = store.capture();
      await store.update((current) => ({ ...current, revision: 2 }));
      const before = await captured;
      const after = await store.capture();
      owner.dispose();
      const closed = await error(store.capture());
      return {
        cold,
        early,
        untouched,
        retried,
        before: before.revision,
        after: after.revision,
        closed,
      };
    } finally {
      owner?.dispose();
      store.close();
    }
  });
  expect(result).toEqual({
    cold: "Read-state storage not ready",
    early: "Read-state storage not ready",
    untouched: undefined,
    retried: 11,
    before: 1,
    after: 2,
    closed: "Read-state storage not ready",
  });
});

test("browser storage reopens a populated legacy journal with fresh Undo epochs", async ({
  page,
  context,
  sourceOrigin,
}) => {
  const secret = generateSecretKey();
  const viewer = getPublicKey(secret);
  const slot = "a".repeat(32);
  const channel = "room-a";
  const selectedKey = `msg:${"d".repeat(64)}`;
  const retainedKey = `msg:${"b".repeat(64)}`;
  const unreadKey = `msg:${"c".repeat(64)}`;
  const otherUnreadKey = `msg:${"e".repeat(64)}`;
  const reservedKey = `msg:${"f".repeat(64)}`;
  const pending = signReadState(
    {
      slot,
      createdAt: 80,
      blob: { v: 1, client_id: "legacy-client", contexts: { [channel]: 20 } },
    },
    secret,
    80,
  );
  const legacy = {
    version: 1,
    slot,
    clientId: "legacy-client",
    state: {
      frontiers: { [channel]: 20, [retainedKey]: 40 },
      overrides: { [unreadKey]: { set: 7, clear: 0, baseline: 0 } },
    },
    localUnread: { [selectedKey]: 6, [otherUnreadKey]: 5 },
    recent: { [channel]: 7, [retainedKey]: 8 },
    reserve: { [reservedKey]: 30 },
    homes: { [retainedKey.slice(4)]: channel, [reservedKey.slice(4)]: channel },
    floor: 10,
    revision: 10,
    acceptedRevision: 8,
    lastCreatedAt: 80,
    pending: { event: pending, revision: 9 },
  };

  await context.route(`${sourceOrigin}/read-state-restart`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Read-state restart</title>",
    }),
  );
  await page.goto(`${sourceOrigin}/read-state-restart`);
  try {
    const result = await page.evaluate(
      async ({ viewer, channel, legacy, scope, selectedKey }) => {
        const { browserReadStateStorage } = await import(
          "/src/features/relay/read-state-storage.ts"
        );
        const { createReadState } = await import(
          "/src/features/relay/read-state.ts"
        );
        const { overrideActive } = await import(
          "/src/features/relay/read-state-model.ts"
        );
        const seedDatabase = () =>
          new Promise((resolve, reject) => {
            const request = indexedDB.open("buzz-read-state-v1", 1);
            request.onupgradeneeded = () =>
              request.result.createObjectStore("partitions");
            request.onerror = () => reject(request.error);
            request.onblocked = () =>
              reject(new Error("Read-state seed database was blocked"));
            request.onsuccess = () => {
              const db = request.result;
              const tx = db.transaction("partitions", "readwrite");
              tx.objectStore("partitions").put(legacy, scope);
              tx.oncomplete = () => {
                db.close();
                resolve();
              };
              tx.onabort = () => {
                db.close();
                reject(tx.error ?? new Error("Read-state seed aborted"));
              };
              tx.onerror = () => reject(tx.error);
            };
          });
        const makeOwner = (storage) =>
          createReadState({
            viewer,
            storage,
            reader: { read: async () => [] },
            host: {
              decode: async () => [],
              sign: async () => {
                throw new Error("Unexpected read-state signing");
              },
              publish: async () => {
                throw new Error("Unexpected read-state publication");
              },
            },
            lock: async (_signal, work) => work(),
            now: () => 100,
            floor: () => 10,
            debounceMs: 60000,
          });
        const summarize = (journal) => ({
          slot: journal.slot,
          revision: journal.revision,
          acceptedRevision: journal.acceptedRevision,
          lastCreatedAt: journal.lastCreatedAt,
          frontiers: journal.state.frontiers,
          overrides: journal.state.overrides,
          localUnread: journal.localUnread,
          intent: journal.localUnreadIntent,
          recent: journal.recent,
          reserve: journal.reserve,
          homes: journal.homes,
          floor: journal.floor,
          pending: journal.pending && {
            id: journal.pending.event.id,
            revision: journal.pending.revision,
          },
          epoch: journal.capturedReadUndo,
          versions: journal.capturedUndoVersions,
        });

        await seedDatabase();
        const firstStorage = browserReadStateStorage(scope, viewer);
        const first = makeOwner(firstStorage);
        let secondStorage;
        let second;
        let reopenedStorage;
        let reopened;
        try {
          const decodedLegacy = await firstStorage.read();
          const decodedLegacyHasNoUndoMetadata =
            decodedLegacy?.capturedReadUndo === undefined &&
            decodedLegacy?.capturedUndoVersions === undefined &&
            decodedLegacy?.localUnreadIntent === undefined;
          await first.ready;
          const afterFirstStartup = await firstStorage.read();
          if (!afterFirstStartup?.capturedReadUndo)
            throw new Error("Owner startup did not establish an Undo epoch");
          const action = await first.readMessages(
            [{ key: selectedKey, timestamp: 100, channelId: channel }],
            undefined,
            () => true,
            false,
            undefined,
            [],
            {
              preserveCapturedSet: true,
              undo: { keys: new Set([selectedKey]), valid: () => true },
            },
          );
          if (!action.undo) throw new Error("Captured Undo handle was absent");
          const afterAction = await firstStorage.read();

          secondStorage = browserReadStateStorage(scope, viewer);
          second = makeOwner(secondStorage);
          await second.ready;
          const afterSecondStartup = await secondStorage.read();
          const undoError = await action.undo().then(
            () => null,
            (error) => error.message,
          );
          const afterRejectedUndo = await secondStorage.read();

          first.dispose();
          second.dispose();
          firstStorage.close();
          secondStorage.close();
          reopenedStorage = browserReadStateStorage(scope, viewer);
          reopened = makeOwner(reopenedStorage);
          await reopened.ready;
          const afterReopen = await reopenedStorage.read();
          return {
            decodedLegacyHasNoUndoMetadata,
            afterFirstStartup: summarize(afterFirstStartup),
            afterAction: summarize(afterAction),
            afterSecondStartup: summarize(afterSecondStartup),
            undoError,
            afterRejectedUndo: summarize(afterRejectedUndo),
            afterReopen: summarize(afterReopen),
            unreadRemainsActive: overrideActive(
              afterReopen?.state.overrides[`msg:${"c".repeat(64)}`],
              afterReopen?.state.frontiers[`msg:${"c".repeat(64)}`],
            ),
          };
        } finally {
          first.dispose();
          second?.dispose();
          reopened?.dispose();
          firstStorage.close();
          secondStorage?.close();
          reopenedStorage?.close();
        }
      },
      {
        viewer,
        channel,
        legacy,
        scope: "read-state-restart",
        selectedKey,
      },
    );

    expect(result.decodedLegacyHasNoUndoMetadata).toBe(true);
    expect(result.afterFirstStartup).toMatchObject({
      slot,
      revision: 10,
      acceptedRevision: 8,
      lastCreatedAt: 80,
      frontiers: { [channel]: 20, [retainedKey]: 40 },
      overrides: { [unreadKey]: { set: 7, clear: 0, baseline: 0 } },
      localUnread: { [selectedKey]: 6, [otherUnreadKey]: 5 },
      recent: { [channel]: 7, [retainedKey]: 8 },
      reserve: { [reservedKey]: 30 },
      homes: {
        [retainedKey.slice(4)]: channel,
        [reservedKey.slice(4)]: channel,
      },
      floor: 10,
      pending: { id: pending.id, revision: 9 },
      intent: {},
      versions: {},
    });
    expect(result.afterFirstStartup.epoch).toMatch(/^[0-9a-f]{32}$/);
    expect(result.afterAction).toMatchObject({
      slot,
      revision: 11,
      acceptedRevision: 8,
      lastCreatedAt: 80,
      frontiers: {
        [channel]: 20,
        [retainedKey]: 40,
        [selectedKey]: 100,
      },
      localUnread: { [otherUnreadKey]: 5 },
      intent: { [selectedKey]: 11 },
      recent: {
        [channel]: 7,
        [retainedKey]: 8,
        [selectedKey]: 11,
      },
      reserve: { [reservedKey]: 30 },
      homes: {
        [retainedKey.slice(4)]: channel,
        [reservedKey.slice(4)]: channel,
      },
      floor: 10,
      pending: { id: pending.id, revision: 9 },
      versions: { [selectedKey]: expect.stringMatching(/^[0-9a-f]{32}$/) },
    });
    expect(result.afterSecondStartup.epoch).not.toBe(
      result.afterFirstStartup.epoch,
    );
    expect(result.undoError).toBe("Reading observation expired");
    expect(result.afterRejectedUndo).toEqual(result.afterSecondStartup);
    expect(result.afterReopen).toMatchObject({
      slot,
      revision: 11,
      acceptedRevision: 8,
      lastCreatedAt: 80,
      frontiers: {
        [channel]: 20,
        [retainedKey]: 40,
        [selectedKey]: 100,
      },
      overrides: { [unreadKey]: { set: 7, clear: 0, baseline: 0 } },
      localUnread: { [otherUnreadKey]: 5 },
      recent: {
        [channel]: 7,
        [retainedKey]: 8,
        [selectedKey]: 11,
      },
      reserve: { [reservedKey]: 30 },
      homes: {
        [retainedKey.slice(4)]: channel,
        [reservedKey.slice(4)]: channel,
      },
      floor: 10,
      pending: { id: pending.id, revision: 9 },
      intent: {},
      versions: {},
    });
    expect(result.afterReopen.epoch).not.toBe(result.afterSecondStartup.epoch);
    expect(result.unreadRemainsActive).toBe(true);
  } finally {
    await stopRoutes(context);
  }
});
