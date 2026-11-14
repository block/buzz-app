import { test, expect } from "./source-fixture.mjs";

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
