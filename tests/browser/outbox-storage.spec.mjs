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

for (const mode of ["dismiss-first", "adopt-first", "peer-accepted"])
  test(`receipt adoption serializes queue consumption with dismissal (${mode})`, async ({
    page,
    context,
    sourceOrigin,
  }) => {
    await context.route(`${sourceOrigin}/outbox-adoption-test`, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>Outbox adoption</title>",
      }),
    );
    await page.goto(`${sourceOrigin}/outbox-adoption-test`);
    const { finalizeEvent } = await import("nostr-tools");
    const event = finalizeEvent(
      {
        kind: 9,
        created_at: 1,
        content: "Saved message",
        tags: [["h", "chat"]],
      },
      new Uint8Array(32).fill(7),
    );
    const result = await page.evaluate(
      async ({ event, mode }) => {
        const { browserOutboxStorage, purgeOutboxStorage } = await import(
          "/src/features/relay/outbox-storage.ts"
        );
        const { createOutbox } = await import("/src/features/relay/outbox.ts");
        const recovery = { key: "follow-up:row", value: "row" };
        const scope = `adoption-${crypto.randomUUID()}`;
        const seed = browserOutboxStorage(scope);
        await seed.load();
        await seed.save([
          { event, signed: event, recovery, delivery: "failed" },
        ]);
        seed.close();
        const writer = {
          sign: async () => {
            throw new Error("Unexpected signing");
          },
          publish: async () => {
            throw new Error("Unexpected publishing");
          },
        };
        const a = createOutbox(
          event.pubkey,
          writer,
          browserOutboxStorage(scope),
        );
        const store = browserOutboxStorage(scope);
        let started;
        const saving = new Promise((resolve) => {
          started = resolve;
        });
        let resume;
        const gate = new Promise((resolve) => {
          resume = resolve;
        });
        const b = createOutbox(event.pubkey, writer, {
          ...store,
          load: async (options) => {
            const records = await store.load(options);
            if (options?.readOnly) {
              started();
              await gate;
            }
            return records;
          },
        });
        try {
          await Promise.all([a.ready, b.ready]);
          const order = [];
          if (mode === "dismiss-first") {
            resume();
            await b.outbox.recovery(recovery.key);
            await a.outbox.dismiss(event.id);
            let rejected = false;
            try {
              await b.outbox.recover(event.id, recovery, () =>
                order.push("consumed"),
              );
            } catch {
              rejected = true;
            }
            return {
              order,
              rejected,
              remaining: (await store.load({ readOnly: true })).length,
            };
          }
          const adoption = b.outbox.recover(event.id, recovery, () =>
            order.push("consumed"),
          );
          await saving;
          if (mode === "peer-accepted") {
            const peer = browserOutboxStorage(scope);
            await peer.load();
            await peer.save([
              { event, signed: event, recovery, delivery: "accepted" },
            ]);
            peer.close();
            resume();
            await adoption;
            return {
              order,
              delivery: (await store.load({ readOnly: true }))[0]?.delivery,
            };
          }
          // Dismissal must wait while adoption persists and consumes its source row.
          const dismissal = a.outbox
            .dismiss(event.id)
            .then(() => order.push("dismissed"));
          resume();
          await Promise.all([adoption, dismissal]);
          const after = await store.load({ readOnly: true });
          return { order, remaining: after.length };
        } finally {
          a.dispose();
          b.dispose();
          await purgeOutboxStorage(scope);
        }
      },
      { event, mode },
    );
    expect(result).toEqual(
      mode === "dismiss-first"
        ? { order: [], rejected: true, remaining: 0 }
        : mode === "peer-accepted"
          ? { order: ["consumed"], delivery: "accepted" }
          : { order: ["consumed", "dismissed"], remaining: 0 },
    );
  });

// Whether Retry can work rests on why the last attempt failed. A reload, and
// the journal save that follows it, must keep that cause as it was written.
test("a refused or blocked change keeps its cause across reloads", async ({
  page,
  context,
  sourceOrigin,
}) => {
  await context.route(`${sourceOrigin}/outbox-refusal-test`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Outbox refusal reload</title>",
    }),
  );
  await page.goto(`${sourceOrigin}/outbox-refusal-test`);
  const { finalizeEvent } = await import("nostr-tools");
  const [refused, blocked, removed] = ["Refused", "Blocked", "Removed"].map(
    (content, i) =>
      finalizeEvent(
        { kind: 9, created_at: 1 + i, content, tags: [["h", "chat"]] },
        new Uint8Array(32).fill(7),
      ),
  );
  const result = await page.evaluate(
    async ({ refused, blocked, removed }) => {
      const { browserOutboxStorage, purgeOutboxStorage } = await import(
        "/src/features/relay/outbox-storage.ts"
      );
      const { createOutbox } = await import("/src/features/relay/outbox.ts");
      const { retryable } = await import("/src/features/relay/refusal.ts");
      const scope = `refusal-${crypto.randomUUID()}`;
      const writer = {
        sign: async () => {
          throw new Error("Unexpected signing");
        },
        publish: async () => {
          throw new Error("Unexpected publishing");
        },
      };
      const seed = browserOutboxStorage(scope);
      await seed.load();
      // As outbox.ts records each failure.
      await seed.save([
        {
          event: refused,
          signed: refused,
          delivery: "failed",
          error: "Not a member",
          refused: true,
          reason: "blocked: not a member",
        },
        {
          event: blocked,
          signed: blocked,
          delivery: "failed",
          error: "Buzz can’t send this as written.",
          unsent: "blocked",
        },
        { event: removed, signed: removed, delivery: "failed" },
      ]);
      seed.close();
      const open = async () => {
        const opened = createOutbox(
          refused.pubkey,
          writer,
          browserOutboxStorage(scope),
        );
        await opened.outbox.ready();
        return opened;
      };
      const causes = (items) =>
        items
          .filter((item) => item.event.id !== removed.id)
          .map(({ event, delivery, error, refused, reason, unsent }) => ({
            content: event.content,
            delivery,
            error,
            refused,
            reason,
            unsent,
            retryable: retryable({ error, refused, reason, unsent }),
          }))
          // The journal reads back in key order, not the order it was saved.
          .sort((a, b) => a.content.localeCompare(b.content));
      const first = await open();
      let reloaded;
      try {
        const restored = causes(first.outbox.snapshot());
        // Removing another change saves the journal this window restored.
        await first.outbox.dismiss(removed.id);
        first.dispose();
        reloaded = await open();
        return { restored, saved: causes(reloaded.outbox.snapshot()) };
      } finally {
        first.dispose();
        reloaded?.dispose();
        await purgeOutboxStorage(scope);
      }
    },
    { refused, blocked, removed },
  );
  const expected = [
    {
      content: "Blocked",
      delivery: "failed",
      error: "Buzz can’t send this as written.",
      unsent: "blocked",
      retryable: false,
    },
    {
      content: "Refused",
      delivery: "failed",
      error: "Not a member",
      refused: true,
      reason: "blocked: not a member",
      retryable: false,
    },
  ];
  expect(result.restored).toEqual(expected);
  expect(result.saved).toEqual(expected);
});
