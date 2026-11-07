import { test, expect } from "./source-fixture.mjs";
import { finalizeEvent, getPublicKey } from "nostr-tools";

async function fixture({ page, context, sourceOrigin }) {
  const secret = new Uint8Array(32).fill(9);
  const viewer = getPublicKey(secret);
  const scope = `chat-owner-${crypto.randomUUID()}`;
  const key = "solo-task:draft";
  await context.route(`${sourceOrigin}/chat-owner`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Chat ownership</title>",
    }),
  );
  await context.route(`${sourceOrigin}/chat-sign`, async (route) => {
    const event = finalizeEvent(route.request().postDataJSON(), secret);
    await route.fulfill({ json: event });
  });
  const peer = await context.newPage();
  async function open(owner) {
    await owner.goto(`${sourceOrigin}/chat-owner`);
    await owner.evaluate(
      async ({ viewer, scope, key }) => {
        const { browserOutboxStorage } = await import(
          "/src/features/relay/outbox-storage.ts"
        );
        const { createOutbox } = await import("/src/features/relay/outbox.ts");
        const store = browserOutboxStorage(scope);
        let release;
        const gate = new Promise((resolve) => {
          release = resolve;
        });
        const state = {
          entered: false,
          signs: 0,
          publications: [],
          release,
          gate,
          store,
          key,
        };
        const handle = createOutbox(
          viewer,
          {
            sign: async (template) => {
              state.signs++;
              const response = await fetch("/chat-sign", {
                method: "POST",
                body: JSON.stringify(template),
              });
              return response.json();
            },
            publish: async (event) => {
              state.publications.push(event.id);
              await gate;
            },
          },
          store,
        );
        Object.assign(state, handle);
        window.owner = state;
        await handle.outbox.ready();
      },
      { viewer, scope, key },
    );
  }
  return {
    peer,
    open,
    close: async () => {
      for (const owner of [page, peer])
        await owner.evaluate(async () => {
          const h = window.owner;
          if (!h) return;
          h.release();
          h.dispose();
          await h.submission?.catch(() => {});
        });
      await page.evaluate(async (scope) => {
        const { purgeOutboxStorage } = await import(
          "/src/features/relay/outbox-storage.ts"
        );
        await purgeOutboxStorage(scope);
      }, scope);
    },
  };
}

// Two pages are needed to exercise the browser's shared lock and journal.
test("a waiting chat owner keeps accepted event identities from the shared journal", async ({
  page,
  context,
  sourceOrigin,
}) => {
  const f = await fixture({ page, context, sourceOrigin }),
    { peer } = f;
  await f.open(page);
  await f.open(peer);
  try {
    await page.evaluate(() => {
      const h = window.owner;
      h.submission = h.outbox.withChat(h.key, async (active) => {
        h.entered = true;
        await h.outbox.stageChat(
          { kind: 9007, content: "", tags: [["h", "chat"]] },
          { kind: 9, content: "One request", tags: [["h", "chat"]] },
          { key: h.key, value: "submission" },
        );
        h.ids = h.outbox.snapshot().map((row) => row.event.id);
        for (const id of h.ids) await h.outbox.resume(id, active);
      });
    });
    await expect
      .poll(() => page.evaluate(() => window.owner.publications.length))
      .toBe(1);
    await peer.evaluate(() => {
      const h = window.owner;
      h.submission = h.outbox.withChat(h.key, async (active) => {
        h.entered = true;
        h.ids = h.outbox.snapshot().map((row) => row.event.id);
        for (const id of h.ids) await h.outbox.resume(id, active);
      });
    });
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const locks = await navigator.locks.query();
          return locks.pending.filter((lock) =>
            lock.name.endsWith(":chat:solo-task:draft"),
          ).length;
        }),
      )
      .toBe(1);
    expect(await peer.evaluate(() => window.owner.entered)).toBe(false);
    await page.evaluate(async () => {
      window.owner.release();
      await window.owner.submission;
    });
    await peer.evaluate(() => window.owner.submission);
    const a = await page.evaluate(() => ({
      ids: window.owner.ids,
      publications: window.owner.publications,
    }));
    const b = await peer.evaluate(async () => ({
      ids: window.owner.ids,
      signs: window.owner.signs,
      publications: window.owner.publications,
      rows: (await window.owner.store.load({ readOnly: true })).map((row) => ({
        id: row.event.id,
        delivery: row.delivery,
      })),
    }));
    expect(a.publications).toEqual(a.ids);
    expect([...b.ids].sort()).toEqual([...a.ids].sort());
    expect(b.signs).toBe(0);
    expect(b.publications).toEqual([]);
    expect(b.rows).toEqual(b.ids.map((id) => ({ id, delivery: "accepted" })));
  } finally {
    await f.close();
  }
});

// A stale adapter cache can overwrite a peer even before it takes a lock.
test("an unrelated save cannot restore a task pair that another page completes", async ({
  page,
  context,
  sourceOrigin,
}) => {
  const f = await fixture({ page, context, sourceOrigin }),
    { peer } = f;
  await f.open(page);
  try {
    await page.evaluate(() => {
      const h = window.owner;
      h.submission = h.outbox.withChat(h.key, async (active) => {
        await h.outbox.stageChat(
          { kind: 9007, content: "", tags: [["h", "chat"]] },
          { kind: 9, content: "One request", tags: [["h", "chat"]] },
          { key: h.key, value: "submission" },
        );
        h.ids = h.outbox.snapshot().map((row) => row.event.id);
        for (const id of h.ids) await h.outbox.resume(id, active);
        for (const id of h.ids) await h.outbox.acknowledge(id);
      });
    });
    await expect
      .poll(() => page.evaluate(() => window.owner.publications.length))
      .toBe(1);
    await f.open(peer);
    expect(
      await peer.evaluate(() =>
        window.owner.outbox.snapshot().map((row) => row.delivery),
      ),
    ).toEqual(["unknown", "unknown"]);
    await page.evaluate(async () => {
      window.owner.release();
      await window.owner.submission;
    });
    const ids = await page.evaluate(() => window.owner.ids);
    const complete = await page.evaluate(() =>
      window.owner.store.load({ readOnly: true }),
    );
    expect(
      complete.every((row) => !row.recovery && row.delivery === "accepted"),
    ).toBe(true);
    await peer.evaluate(() => {
      const h = window.owner;
      h.release();
      h.other = h.outbox.send({
        kind: 9,
        content: "Other chat",
        tags: [["h", "other"]],
      });
    });
    await expect
      .poll(() =>
        peer.evaluate(async () => {
          const h = window.owner;
          return (await h.store.load({ readOnly: true })).find(
            (row) => row.event.id === h.other,
          )?.delivery;
        }),
      )
      .toBe("accepted");
    await peer.evaluate(async (ids) => {
      const h = window.owner;
      const owned = (await h.store.load({ readOnly: true })).filter(
        (row) => !ids.includes(row.event.id),
      );
      await h.store.save(owned, { skip: ids });
    }, ids);
    const rows = await peer.evaluate(() =>
      window.owner.store.load({ readOnly: true }),
    );
    const pair = rows.filter((row) => ids.includes(row.event.id));
    expect(pair).toHaveLength(2);
    expect(
      pair.every((row) => !row.recovery && row.delivery === "accepted"),
    ).toBe(true);
    await peer.evaluate(async () => {
      const h = window.owner;
      await h.outbox.withChat(h.key, async () => {
        h.recoveries = h.outbox
          .snapshot()
          .filter((row) => row.recovery?.key === h.key).length;
      });
    });
    expect(await peer.evaluate(() => window.owner.recoveries)).toBe(0);
    await peer.evaluate(async () => {
      const h = window.owner;
      await h.outbox.dismiss(h.other);
      h.other = h.outbox.send({
        kind: 9,
        content: "Next chat",
        tags: [["h", "other"]],
      });
    });
    await expect
      .poll(() =>
        peer.evaluate(async () => {
          const h = window.owner;
          return (await h.store.load({ readOnly: true })).find(
            (row) => row.event.id === h.other,
          )?.delivery;
        }),
      )
      .toBe("accepted");
    const final = await peer.evaluate(() =>
      window.owner.store.load({ readOnly: true }),
    );
    expect(final.filter((row) => ids.includes(row.event.id))).toEqual(pair);
    expect(final).toHaveLength(3);
    expect(await peer.evaluate(() => window.owner.publications)).toHaveLength(
      2,
    );
  } finally {
    await f.close();
  }
});
