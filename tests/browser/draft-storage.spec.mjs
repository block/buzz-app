import { test, expect } from "./fixture.mjs";
import { test as storageTest } from "./source-fixture.mjs";
import { open } from "./timeline.mjs";

const alphaComposer = (page) =>
  page.getByRole("textbox", { name: "Message #Alpha", exact: true });

test("a composer draft survives reload when localStorage is full", async ({
  page,
  app,
}) => {
  await open(page, app);
  const composer = alphaComposer(page);
  const peer = await page.context().newPage();
  await open(peer, app);
  await expect(composer).toBeVisible();
  const quotaError = await page.evaluate(() => {
    const key = "test-storage-pad";
    let low = 0;
    let high = 8 * 1024 * 1024;
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      try {
        localStorage.setItem(key, "x".repeat(middle));
        low = middle;
      } catch (error) {
        if (error.name !== "QuotaExceededError") throw error;
        high = middle;
      }
    }
    localStorage.setItem(key, "x".repeat(low));
    try {
      localStorage.setItem("test-quota-probe", "x");
    } catch (error) {
      return error.name;
    }
  });
  expect(quotaError).toBe("QuotaExceededError");
  await composer.fill("A draft saved with a full local store");
  // Reload before the debounce can persist the latest keystroke.
  await open(page, app);
  await expect(composer).toHaveJSProperty(
    "value",
    "A draft saved with a full local store",
  );
  await expect(alphaComposer(peer)).toHaveJSProperty(
    "value",
    "A draft saved with a full local store",
  );
  await peer.close();
  await open(page, app);
  await expect(composer).toHaveJSProperty(
    "value",
    "A draft saved with a full local store",
  );
});

storageTest(
  "migrated drafts support transactional edits and deletion across windows",
  async ({ page, context, sourceOrigin }) => {
    const url = `${sourceOrigin}/draft-storage-test`;
    await context.route(url, (route) =>
      route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
    );
    const peer = await context.newPage();
    await page.goto(url);
    const initial = JSON.stringify({ text: "Legacy draft", recipients: [] });
    await page.evaluate((initial) => {
      localStorage.setItem(
        'buzz-view.v1:["example:viewer","draft:room"]',
        initial,
      );
    }, initial);
    await peer.goto(url);
    const read = (target) =>
      target.evaluate(async () => {
        const { initializeDraftStorage, viewRevision } = await import(
          "/src/shared/view-state.ts"
        );
        await initializeDraftStorage();
        return viewRevision("example:viewer", "draft:room");
      });
    expect(await Promise.all([read(page), read(peer)])).toEqual([
      initial,
      initial,
    ]);

    const write = (target, expected, text) =>
      target.evaluate(
        async ({ expected, text }) => {
          const { saveDraftRevision, viewScopePurgeToken } = await import(
            "/src/shared/view-state.ts"
          );
          const scope = "example:viewer";
          return saveDraftRevision(
            scope,
            "draft:room",
            expected,
            JSON.stringify({ text, recipients: [] }),
            viewScopePurgeToken(scope),
          );
        },
        { expected, text },
      );
    const results = await Promise.all([
      write(page, initial, "First edit"),
      write(peer, initial, "Second edit"),
    ]);
    expect(results.toSorted()).toEqual(["changed", "saved"]);
    const winner = JSON.stringify({
      text: results[0] === "saved" ? "First edit" : "Second edit",
      recipients: [],
    });
    await expect.poll(() => read(page)).toBe(winner);
    await expect.poll(() => read(peer)).toBe(winner);

    await peer.evaluate(async (revision) => {
      const { draftRetirementCursor, stageDraftHandoff, viewScopePurgeToken } =
        await import("/src/shared/view-state.ts");
      const scope = "example:viewer";
      const key = "draft:room";
      stageDraftHandoff(
        scope,
        key,
        null,
        revision,
        viewScopePurgeToken(scope),
        draftRetirementCursor(scope, key),
      );
    }, winner);

    await page.evaluate(async () => {
      const { clearView, initializeDraftStorage } = await import(
        "/src/shared/view-state.ts"
      );
      await initializeDraftStorage();
      await clearView("example:viewer", "draft:room", "draft:room:files");
    });
    expect(await read(page)).toBeNull();
    expect(await write(peer, winner, "Stale edit after deletion")).toBe(
      "changed",
    );
    await expect.poll(() => read(peer)).toBeNull();

    await page.evaluate((initial) => {
      localStorage.setItem(
        'buzz-view.v1:["example:viewer","draft:room"]',
        initial,
      );
    }, initial);
    await peer.reload();
    expect(await read(peer)).toBeNull();
    await peer.close();
  },
);
