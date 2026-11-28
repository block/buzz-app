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

for (const journal of ["indexeddb", "legacy"])
  test(`a late creation echo respects durable setup removal (${journal})`, async ({
    page,
    context,
    sourceOrigin,
  }) => {
    await context.route(`${sourceOrigin}/outbox-storage-test`, (route) =>
      route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
    );
    await page.goto(`${sourceOrigin}/outbox-storage-test`);
    const { finalizeEvent } = await import("nostr-tools");
    const member = "a".repeat(64);
    const creation = finalizeEvent(
      {
        kind: 9007,
        created_at: 1,
        content: "",
        tags: [
          ["h", "chat"],
          ["p", member],
        ],
      },
      new Uint8Array(32).fill(7),
    );
    const result = await page.evaluate(
      async ({ creation, member, journal }) => {
        const { browserOutboxStorage, purgeOutboxStorage } = await import(
          "/src/features/relay/outbox-storage.ts"
        );
        const { createOutbox } = await import("/src/features/relay/outbox.ts");
        const { soloAdminRecovery } = await import(
          "/src/features/relay/solo-admins.ts"
        );
        const recovery = soloAdminRecovery("chat", [member], [member]);
        const scope = `setup-removal-${crypto.randomUUID()}`;
        const aStore = browserOutboxStorage(scope);
        const bStore = browserOutboxStorage(scope);
        const operation = {
          event: creation,
          signed: creation,
          recovery,
          delivery: "accepted",
        };
        if (journal === "legacy")
          localStorage.setItem(
            `buzz-outbox-v1:${scope}`,
            JSON.stringify([operation]),
          );
        else await aStore.save([operation]);
        const unexpected = async () => {
          throw new Error("Unexpected delivery");
        };
        const writer = { sign: unexpected, publish: unexpected };
        const a = createOutbox(creation.pubkey, writer, aStore);
        const b = createOutbox(creation.pubkey, writer, bStore);
        try {
          await Promise.all([a.ready, b.ready]);
          if (
            !a.outbox.snapshot()[0]?.recovery ||
            !b.outbox.snapshot()[0]?.recovery
          )
            throw new Error("Both windows must hold the saved setup");
          b.observe([creation]);
          await b.outbox.dismiss(creation.id, recovery);
          const afterDismiss = (await bStore.load({ readOnly: true })).length;
          a.observe([creation]);
          let ran = false;
          const publication = await a.outbox
            .withRecovery(creation.id, recovery, async () => {
              ran = true;
            })
            .then(
              () => "completed",
              (error) => error.message,
            );
          const completion = await a.outbox
            .finishRecovery(creation.id, recovery)
            .then(
              () => "completed",
              (error) => error.message,
            );
          return {
            afterDismiss,
            ran,
            publication,
            completion,
            remaining: (await bStore.load({ readOnly: true })).length,
          };
        } finally {
          a.dispose();
          b.dispose();
          await purgeOutboxStorage(scope);
        }
      },
      { creation, member, journal },
    );
    expect(result).toEqual({
      afterDismiss: 0,
      ran: false,
      publication: expect.stringContaining(
        "removed or changed in another window",
      ),
      completion: expect.stringContaining(
        "removed or changed in another window",
      ),
      remaining: 0,
    });
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

test("a window that loaded a legacy journal cannot retire a row another window migrated and replaced", async ({
  page,
  context,
  sourceOrigin,
}) => {
  await context.route(`${sourceOrigin}/outbox-storage-test`, (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
  );
  await page.goto(`${sourceOrigin}/outbox-storage-test`);
  const result = await page.evaluate(async () => {
    const { browserOutboxStorage, purgeOutboxStorage } = await import(
      "/src/features/relay/outbox-storage.ts"
    );
    const scope = `legacy-retire-${crypto.randomUUID()}`;
    const row = (id) => ({ event: { id }, delivery: "failed" });
    localStorage.setItem(
      `buzz-outbox-v1:${scope}`,
      JSON.stringify([row("old"), row("other")]),
    );
    const first = browserOutboxStorage(scope);
    const stale = browserOutboxStorage(scope);
    try {
      await first.load();
      await stale.load();
      await first.save([row("other"), row("first")], { retired: ["old"] });
      const refusal = await stale
        .save([row("other"), row("stale")], { retired: ["old"] })
        .then(
          () => "",
          (error) => error.message,
        );
      const ids = (await first.load({ readOnly: true }))
        .map((item) => item.event.id)
        .sort();
      return { refusal, ids };
    } finally {
      first.close();
      stale.close();
      await purgeOutboxStorage(scope);
    }
  });
  expect(result).toEqual({
    refusal: "This save was replaced in another window. Try again.",
    ids: ["first", "other"],
  });
});

test("a window cannot retire a row another window has since attached recovery to", async ({
  page,
  context,
  sourceOrigin,
}) => {
  await context.route(`${sourceOrigin}/outbox-storage-test`, (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
  );
  await page.goto(`${sourceOrigin}/outbox-storage-test`);
  const result = await page.evaluate(async () => {
    const { browserOutboxStorage, purgeOutboxStorage } = await import(
      "/src/features/relay/outbox-storage.ts"
    );
    const scope = `recovered-retire-${crypto.randomUUID()}`;
    const old = { event: { id: "old" }, delivery: "failed" };
    const first = browserOutboxStorage(scope);
    const stale = browserOutboxStorage(scope);
    try {
      await first.load();
      await first.save([old]);
      await stale.load();
      await first.save([{ ...old, recovery: { key: "k", value: "v" } }]);
      const refusal = await stale
        .save([{ event: { id: "next" }, delivery: "sending" }], {
          retired: ["old"],
        })
        .then(
          () => "",
          (error) => error.message,
        );
      const rows = await first.load({ readOnly: true });
      return {
        refusal,
        rows: rows.map((item) => [item.event.id, item.recovery?.key]),
      };
    } finally {
      first.close();
      stale.close();
      await purgeOutboxStorage(scope);
    }
  });
  expect(result).toEqual({
    refusal: "This save is in progress in another window.",
    rows: [["old", "k"]],
  });
});

test("a failed save can be replaced while its window stays open, but not while it is publishing", async ({
  page,
  context,
  sourceOrigin,
}) => {
  await context.route(`${sourceOrigin}/outbox-storage-test`, (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
  );
  await page.goto(`${sourceOrigin}/outbox-storage-test`);
  const result = await page.evaluate(async () => {
    const { browserOutboxStorage, purgeOutboxStorage } = await import(
      "/src/features/relay/outbox-storage.ts"
    );
    const scope = `publishing-${crypto.randomUUID()}`;
    const first = browserOutboxStorage(scope);
    const second = browserOutboxStorage(scope);
    const retire = () =>
      second
        .save([{ event: { id: "new" }, delivery: "sending" }], {
          retired: ["old"],
        })
        .then(
          () => "",
          (error) => error.message,
        );
    try {
      await first.load();
      await first.save([{ event: { id: "old" }, delivery: "failed" }]);
      await second.load();
      let started;
      const holding = new Promise((resolve) => {
        started = resolve;
      });
      let release;
      const publishing = first.lock(
        "old",
        () =>
          new Promise((resolve) => {
            release = resolve;
            started();
          }),
      );
      await holding;
      const busy = await retire();
      release();
      await publishing;
      const settled = await retire();
      const ids = (await first.load({ readOnly: true })).map(
        (item) => item.event.id,
      );
      return { busy, settled, ids };
    } finally {
      first.close();
      second.close();
      await purgeOutboxStorage(scope);
    }
  });
  expect(result).toEqual({
    busy: "This save is in progress in another window.",
    settled: "",
    ids: ["new"],
  });
});

for (const order of ["replaced-first", "publishing-first"])
  test(`a retry and a replacement in another window never both go out (${order})`, async ({
    page,
    context,
    sourceOrigin,
  }) => {
    await context.route(`${sourceOrigin}/outbox-storage-test`, (route) =>
      route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
    );
    await page.goto(`${sourceOrigin}/outbox-storage-test`);
    const { finalizeEvent } = await import("nostr-tools");
    const event = finalizeEvent(
      {
        kind: 40100,
        created_at: 1,
        content: "Old draft",
        tags: [["h", "chat"]],
      },
      new Uint8Array(32).fill(7),
    );
    const result = await page.evaluate(
      async ({ event, order }) => {
        const { browserOutboxStorage, purgeOutboxStorage } = await import(
          "/src/features/relay/outbox-storage.ts"
        );
        const { createOutbox } = await import("/src/features/relay/outbox.ts");
        const scope = `retry-race-${crypto.randomUUID()}`;
        const peer = browserOutboxStorage(scope);
        await peer.load();
        await peer.save([{ event, signed: event, delivery: "failed" }]);
        let published = 0;
        let started;
        const publishing = new Promise((resolve) => {
          started = resolve;
        });
        let finish;
        const gate = new Promise((resolve) => {
          finish = resolve;
        });
        const writer = {
          sign: async () => {
            throw new Error("Unexpected signing");
          },
          publish: async () => {
            published++;
            started();
            await gate;
          },
        };
        const a = createOutbox(
          event.pubkey,
          writer,
          browserOutboxStorage(scope),
        );
        const replace = () =>
          peer
            .save([{ event: { id: "new" }, delivery: "sending" }], {
              retired: [event.id],
            })
            .then(
              () => "",
              (error) => error.message,
            );
        try {
          await a.ready;
          let refusal;
          if (order === "replaced-first") {
            refusal = await replace();
            a.outbox.retry(event.id);
            while (
              a.outbox.snapshot().some((item) => item.event.id === event.id)
            )
              await new Promise((resolve) => setTimeout(resolve, 10));
          } else {
            a.outbox.retry(event.id);
            await publishing;
            refusal = await replace();
          }
          finish();
          return { refusal, published };
        } finally {
          a.dispose();
          peer.close();
          await purgeOutboxStorage(scope);
        }
      },
      { event, order },
    );
    expect(result).toEqual(
      order === "replaced-first"
        ? { refusal: "", published: 0 }
        : {
            refusal: "This save is in progress in another window.",
            published: 1,
          },
    );
  });

async function openWithSignedMessages(page, sourceOrigin, count) {
  await page
    .context()
    .route(`${sourceOrigin}/outbox-storage-test`, (route) =>
      route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
    );
  await page.goto(`${sourceOrigin}/outbox-storage-test`);
  const { finalizeEvent } = await import("nostr-tools");
  return Array.from({ length: count }, (_, index) =>
    finalizeEvent(
      { kind: 9, created_at: 1, content: `Saved ${index}`, tags: [["h", "c"]] },
      new Uint8Array(32).fill(7),
    ),
  );
}

test("a stale window's save is checked against the row as stored", async ({
  page,
  sourceOrigin,
}) => {
  await openWithSignedMessages(page, sourceOrigin, 0);
  const result = await page.evaluate(async () => {
    const { browserOutboxStorage, purgeOutboxStorage } = await import(
      "/src/features/relay/outbox-storage.ts"
    );
    const scope = `stale-${crypto.randomUUID()}`;
    const a = browserOutboxStorage(scope);
    const b = browserOutboxStorage(scope);
    const pending = (item) => item.delivery !== "seen";
    const budget = {
      fits: (rows) => rows.filter(pending).length <= 2,
      grows: (stored, next) => pending(next) && (!stored || !pending(stored)),
    };
    const row = (id, delivery) => ({ event: { id }, delivery });
    const error = (work) =>
      work.then(
        () => "",
        (reason) => reason.message,
      );
    try {
      await a.load();
      await a.save([row("pin", "failed"), row("q", "failed")]);
      await b.load();
      // A delivers the pin and uses the freed slot.
      await a.save([
        row("pin", "seen"),
        row("q", "failed"),
        row("n", "failed"),
      ]);
      // B still holds the pin as failed and retries it.
      const stale = await error(
        b.save([row("pin", "sending"), row("q", "failed")], { budget }),
      );
      const added = await error(
        b.save([row("pin", "failed"), row("q", "failed"), row("r", "failed")], {
          budget,
        }),
      );
      await a.save([row("pin", "seen"), row("q", "failed")]);
      // The refused row was never saved, so replacing it needs no second try.
      const replaced = await error(
        b.save(
          [row("pin", "failed"), row("q", "failed"), row("r2", "failed")],
          { budget, retired: ["r"] },
        ),
      );
      const stored = await a.load({ readOnly: true });
      return {
        stale,
        added,
        replaced,
        pending: stored.filter(pending).length,
      };
    } finally {
      a.close();
      b.close();
      await purgeOutboxStorage(scope);
    }
  });
  expect(result).toEqual({
    stale: "Outbox storage is full",
    added: "Outbox storage is full",
    replaced: "",
    pending: 2,
  });
});

test("two windows sending at the limit never leave a journal neither can load", async ({
  page,
  sourceOrigin,
}) => {
  const events = await openWithSignedMessages(page, sourceOrigin, 255);
  const result = await page.evaluate(async (events) => {
    const { browserOutboxStorage, purgeOutboxStorage } = await import(
      "/src/features/relay/outbox-storage.ts"
    );
    const { createOutbox } = await import("/src/features/relay/outbox.ts");
    const scope = `overfill-${crypto.randomUUID()}`;
    const seed = browserOutboxStorage(scope);
    await seed.load();
    await seed.save(
      events.map((event) => ({ event, signed: event, delivery: "failed" })),
    );
    seed.close();
    const writer = {
      sign: () => new Promise(() => {}),
      publish: () => new Promise(() => {}),
    };
    const open = () =>
      createOutbox(events[0].pubkey, writer, browserOutboxStorage(scope));
    const a = open();
    const b = open();
    const reader = browserOutboxStorage(scope);
    const send = (session, content) =>
      session.outbox.send({ kind: 9, content, tags: [["h", "c"]] });
    const settled = async (session, id) => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const item = session.outbox.snapshot().find((i) => i.event.id === id);
        if (item?.error) return item.error;
        const stored = await reader.load({ readOnly: true });
        if (stored.some((row) => row.event.id === id)) return "";
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Send ${id} was neither saved nor refused`);
    };
    try {
      await Promise.all([a.ready, b.ready]);
      const first = await settled(a, send(a, "From A"));
      const fromB = send(b, "From B");
      const second = await settled(b, fromB);
      const unsaved = await b.outbox.saved(fromB).then(
        () => "",
        (error) => error.message,
      );
      let next = "";
      try {
        send(b, "From B again");
      } catch (error) {
        next = error.message;
      }
      const c = open();
      await c.ready;
      const loaded = c.outbox.snapshot().length;
      c.dispose();
      const stored = (await reader.load({ readOnly: true })).length;
      return { first, second, unsaved, next, stored, loaded };
    } finally {
      a.dispose();
      b.dispose();
      reader.close();
      await purgeOutboxStorage(scope);
    }
  }, events);
  const full = "Too many outstanding operations; resolve a pending operation";
  expect(result).toEqual({
    first: "",
    second: full,
    unsaved: full,
    next: full,
    stored: 256,
    loaded: 256,
  });
});

for (const journal of ["indexeddb", "legacy"])
  test(`an already overfilled journal loads, and sends wait until it is back under the limit (${journal})`, async ({
    page,
    sourceOrigin,
  }) => {
    const events = await openWithSignedMessages(page, sourceOrigin, 257);
    const result = await page.evaluate(
      async ({ events, journal }) => {
        const { browserOutboxStorage, purgeOutboxStorage } = await import(
          "/src/features/relay/outbox-storage.ts"
        );
        const { createOutbox } = await import("/src/features/relay/outbox.ts");
        const scope = `overfilled-${crypto.randomUUID()}`;
        const rows = events.map((event) => ({
          event,
          signed: event,
          delivery: "failed",
        }));
        if (journal === "legacy")
          localStorage.setItem(`buzz-outbox-v1:${scope}`, JSON.stringify(rows));
        else {
          const seed = browserOutboxStorage(scope);
          await seed.load();
          await seed.save(rows);
          seed.close();
        }
        const writer = {
          sign: () => new Promise(() => {}),
          publish: () => new Promise(() => {}),
        };
        const open = () =>
          createOutbox(events[0].pubkey, writer, browserOutboxStorage(scope));
        const session = open();
        const sendError = () => {
          try {
            session.outbox.send({
              kind: 9,
              content: "New",
              tags: [["h", "c"]],
            });
            return "";
          } catch (error) {
            return error.message;
          }
        };
        try {
          await session.ready;
          const loaded = session.outbox.snapshot().length;
          const blocked = sendError();
          // Recovery adds bytes, so it cannot grow an overfilled journal.
          const recovered = await session.outbox
            .recover(events[2].id, { key: "test:recovery", value: "v" })
            .then(
              () => "",
              (error) => error.message,
            );
          await session.outbox.dismiss(events[0].id);
          const stillBlocked = sendError();
          // The refused entry is still saved, as it was before recovery.
          const reopened = open();
          await reopened.ready;
          const saved = reopened.outbox.snapshot();
          reopened.dispose();
          await session.outbox.dismiss(events[1].id);
          const allowed = sendError();
          return {
            loaded,
            blocked,
            recovered,
            stillBlocked,
            reopened: saved.length,
            kept: saved.some(
              (item) => item.event.id === events[2].id && !item.recovery,
            ),
            allowed,
          };
        } finally {
          session.dispose();
          await purgeOutboxStorage(scope);
        }
      },
      { events, journal },
    );
    const full = "Too many outstanding operations; resolve a pending operation";
    expect(result).toEqual({
      loaded: 257,
      blocked: full,
      recovered: full,
      stillBlocked: full,
      reopened: 256,
      kept: true,
      allowed: "",
    });
  });
