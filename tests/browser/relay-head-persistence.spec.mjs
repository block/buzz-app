import { test, expect } from "./source-fixture.mjs";

test("cached heads keep their global budget through upgrade, rollback, and reopen", async ({
  page,
  context,
  sourceOrigin,
}) => {
  const url = `${sourceOrigin}/relay-head-persistence-test`;
  await context.route(url, (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
  );
  await page.goto(url);
  const result = await page.evaluate(async () => {
    const { createHeadPersistence } = await import(
      "/src/features/relay/persistence.ts"
    );
    const relay = "https://example.org";
    const viewers = ["viewer-a", "viewer-b"];
    const now = Date.now();
    const head = (i) => ({
      channelId: `channel-${i}`,
      events: [{ content: `message-${i}` }],
      profiles: [],
      savedAt: now - 100 + i,
    });
    const scopes = viewers.map((viewer) => `${viewer}:${relay}`);
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("buzz-channel-heads-v1", 2);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("heads", { keyPath: "key" });
        request.result.createObjectStore("startup", { keyPath: "key" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction("heads", "readwrite");
      for (let i = 0; i < 64; i++) {
        const row = head(i);
        const scope = scopes[i % 2];
        tx.objectStore("heads").put({
          ...row,
          scope,
          key: `${scope}:${row.channelId}`,
          bytes: JSON.stringify(row).length,
        });
      }
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error);
    });
    db.close();

    let stores = viewers.map((viewer) => createHeadPersistence(viewer, relay));
    const snapshot = () => Promise.all(stores.map((store) => store.read()));
    const upgraded = await snapshot();
    const prototype = IDBObjectStore.prototype;
    const methods = ["get", "getAll", "openCursor"];
    const read = methods.map((method) => prototype[method]);
    const remove = prototype.delete;
    let saving = false;
    let fullHeadReads = 0;
    let abortSave = true;
    let overlappingRemove;
    for (const [i, method] of methods.entries()) {
      prototype[method] = function (...args) {
        if (saving && this.name === "heads") fullHeadReads++;
        return read[i].apply(this, args);
      };
    }
    prototype.delete = function (key) {
      const request = remove.call(this, key);
      if (this.name === "heads" && key === `${scopes[0]}:channel-0`) {
        if (abortSave) queueMicrotask(() => this.transaction.abort());
        else overlappingRemove = stores[1].remove("channel-1");
      }
      return request;
    };
    try {
      const retry = head(64);
      const aborted = await stores[0].write(retry).then(
        () => false,
        () => true,
      );
      const rolledBack = await snapshot();
      abortSave = false;
      saving = true;
      await stores[0].write(retry);
      await overlappingRemove;
      saving = false;
      for (const store of stores) store.close();
      stores = viewers.map((viewer) => createHeadPersistence(viewer, relay));
      return {
        upgraded,
        rolledBack,
        aborted,
        fullHeadReads,
        reopened: await snapshot(),
      };
    } finally {
      for (const [i, method] of methods.entries()) prototype[method] = read[i];
      prototype.delete = remove;
      for (const store of stores) store.close();
    }
  });
  expect(result.upgraded.map((rows) => rows.length)).toEqual([32, 32]);
  expect(result.upgraded[0][0].events).toEqual([{ content: "message-62" }]);
  expect(result.upgraded[1][0].events).toEqual([{ content: "message-63" }]);
  expect(result.aborted).toBe(true);
  expect(result.rolledBack).toEqual(result.upgraded);
  expect(result.reopened[0][0].events).toEqual([{ content: "message-64" }]);
  expect(result.reopened[0].slice(1)).toEqual(result.upgraded[0].slice(0, -1));
  expect(result.reopened[1]).toEqual(result.upgraded[1].slice(0, -1));
  expect(result.fullHeadReads).toBe(0);
});
