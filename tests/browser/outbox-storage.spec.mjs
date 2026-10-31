import { test, expect } from "./source-fixture.mjs";

// Exercise the actual incremental IndexedDB journal: a full-array memory store
// cannot reproduce a stale window deleting another window's renewed receipt.
test("forgetting a stale receipt relinquishes its journal deletion ownership", async ({
  page,
  context,
  sourceOrigin,
}) => {
  await context.route(`${sourceOrigin}/outbox-storage-test`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Outbox storage boundary</title>",
    }),
  );
  await page.goto(`${sourceOrigin}/outbox-storage-test`);
  const ids = await page.evaluate(async () => {
    const { browserOutboxStorage, purgeOutboxStorage } = await import(
      "/src/features/relay/outbox-storage.ts"
    );
    const scope = `stale-receipt-${crypto.randomUUID()}`;
    const owner = browserOutboxStorage(scope);
    const stale = browserOutboxStorage(scope);
    const old = { event: { id: "old" }, delivery: "failed" };
    const next = { event: { id: "next" }, delivery: "sending" };
    try {
      await owner.load();
      await owner.save([old]);
      await stale.load();
      await owner.save([]);
      if ((await stale.load({ readOnly: true })).length)
        throw new Error("Receipt was not removed");
      const pending = stale.save([old]);
      // save has entered its IndexedDB transaction, which cannot complete in
      // this microtask. Discard must survive that transaction's completion.
      await Promise.resolve();
      stale.forget(old.event.id);
      await pending;
      // A different window renews the same operation after the absence check.
      await owner.save([old]);
      await stale.save([next]);
      return (await owner.load({ readOnly: true }))
        .map((item) => item.event.id)
        .sort();
    } finally {
      owner.close();
      stale.close();
      await purgeOutboxStorage(scope);
    }
  });
  expect(ids).toEqual(["next", "old"]);
});
