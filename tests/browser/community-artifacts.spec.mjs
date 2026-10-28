import { test, expect } from "./source-fixture.mjs";

// Real storage events and IndexedDB ordering need separate browser windows.
for (const { delayedEvent, purge } of [
  { delayedEvent: false, purge: true },
  { delayedEvent: true, purge: true },
  { delayedEvent: false, purge: false },
]) {
  test(`leave fences artifact storage across windows with ${delayedEvent ? "delayed" : "normal"} storage events and purge=${purge}`, async ({
    page,
    context,
  }) => {
    await page.goto("/tests/fixtures/community-artifacts.html");
    await page.waitForFunction(
      () => window.communityArtifacts?.snapshot().status === "ready",
    );
    await page.evaluate(() => window.communityArtifacts.join());
    const other = await context.newPage();
    await other.addInitScript(() => {
      window.addEventListener("storage", (event) => {
        if (window.pauseStorage) event.stopImmediatePropagation();
      });
    });
    await other.goto(page.url());
    await other.waitForFunction(
      () =>
        window.communityArtifacts?.snapshot().selected ===
        "https://fixture.example",
    );
    await other.evaluate((delay) => {
      window.handle = window.communityArtifacts.open();
      window.pauseStorage = delay;
      return window.handle.importBatch({
        records: [{ id: "task", local: { title: "saved" } }],
      });
    }, delayedEvent);
    await page.evaluate(
      (purge) => window.communityArtifacts.leave(purge),
      purge,
    );
    if (!delayedEvent)
      await other.waitForFunction(() => window.communityArtifacts.aborted());
    const result = await other.evaluate(async () => {
      let openError;
      try {
        window.communityArtifacts.open();
      } catch (error) {
        openError = error.message;
      }
      let writeError;
      try {
        await window.handle.importBatch({
          records: [{ id: "task", local: { title: "stale" } }],
        });
      } catch (error) {
        writeError = error.message;
      }
      return {
        snapshot: window.communityArtifacts.snapshot(),
        aborted: window.communityArtifacts.aborted(),
        openError,
        writeError,
        saved: await window.communityArtifacts.saved(),
      };
    });
    expect(result.snapshot.memberships).toEqual([]);
    expect(result.snapshot.selected).toBeNull();
    expect(result.aborted).toBe(true);
    expect(result.openError).toBe(
      "Artifact storage needs a plugin, identity and relay",
    );
    expect(result.writeError).toBe("Artifact storage scope changed");
    if (purge) expect(result.saved).toBeUndefined();
    else expect(result.saved.record.local).toEqual({ title: "saved" });
    await other.evaluate(async () => {
      window.communityArtifacts.join();
      const fresh = window.communityArtifacts.open();
      await fresh.importBatch({
        records: [{ id: "rejoined", local: { title: "rejoined" } }],
      });
    });
    await page.waitForFunction(
      () =>
        window.communityArtifacts.snapshot().selected ===
        "https://fixture.example",
    );
    expect(
      await page.evaluate(
        async () =>
          (await window.communityArtifacts.open().get("rejoined"))?.record
            .local,
      ),
    ).toEqual({ title: "rejoined" });
    await expect(
      other.evaluate(() => window.handle.get("task")),
    ).rejects.toThrow("scope changed");
  });
}

test("rejects an old handle after leave and rejoin before event delivery", async ({
  page,
  context,
}) => {
  await page.goto("/tests/fixtures/community-artifacts.html");
  await page.waitForFunction(
    () => window.communityArtifacts?.snapshot().status === "ready",
  );
  await page.evaluate(() => window.communityArtifacts.join());
  const other = await context.newPage();
  await other.addInitScript(() => {
    window.addEventListener("storage", (event) => {
      if (window.pauseStorage) event.stopImmediatePropagation();
    });
  });
  await other.goto(page.url());
  await other.waitForFunction(
    () => window.communityArtifacts?.snapshot().selected,
  );
  await other.evaluate(async () => {
    window.handle = window.communityArtifacts.open();
    await window.handle.get("task");
    window.pauseStorage = true;
  });
  await page.evaluate(async () => {
    await window.communityArtifacts.leave(true);
    window.communityArtifacts.join();
    await window.communityArtifacts
      .open()
      .importBatch({ records: [{ id: "task", local: { title: "fresh" } }] });
  });
  await expect(
    other.evaluate(() =>
      window.handle.importBatch({ records: [{ id: "stale", local: {} }] }),
    ),
  ).rejects.toThrow("scope changed");
  expect(await other.evaluate(() => window.communityArtifacts.aborted())).toBe(
    true,
  );
  expect(
    await other.evaluate(
      async () =>
        (await window.communityArtifacts.open().get("task"))?.record.local,
    ),
  ).toEqual({ title: "fresh" });
});
