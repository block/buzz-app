import { test, expect } from "./fixture.mjs";
import { activate, open } from "./timeline.mjs";

test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  historyCounts: { alpha: 20, beta: 1 },
});

// Browser-only: prove opener → retained portal → native editor focus, including
// pointer tab selection and the main pane's inert transition.
for (const pane of ["side", "main"]) {
  test(`opening and reopening a ${pane} thread resumes typing`, async ({
    page,
    app,
  }) => {
    await page.addInitScript(
      (pane) => localStorage.setItem("buzz-thread-placement.v1", pane),
      pane,
    );
    await open(page, app);
    const roots = app.histories
      .get("primary/alpha")
      .filter((row) => row.content.startsWith("Thread root"));
    const main = page.locator("[data-main-workspace]");
    const host = page.locator(
      pane === "main" ? "[data-main-workspace]" : "[data-panel-workspace]",
    );
    const reply = host.getByRole("textbox", {
      name: "Reply to thread",
      exact: true,
    });
    const tab = (root) =>
      host.locator(`[role="tab"][data-tab-value="thread:alpha:${root.id}"]`);
    const showConversation = async () => {
      if (pane === "main")
        await main.getByRole("tab", { name: "Alpha", exact: true }).click();
    };
    const openThread = async (root, keyboard = false) => {
      await showConversation();
      const trigger = page
        .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
        .getByRole("button", { name: /^View thread:/ });
      if (keyboard) await activate(trigger);
      else await trigger.click();
      await expect(reply).toBeFocused();
    };
    await openThread(roots[0]);
    await page.keyboard.type("First thread draft");
    await expect(reply).toHaveText("First thread draft");
    for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowLeft");
    const selection = () =>
      reply.evaluate((editor) => [editor.selectionStart, editor.selectionEnd]);
    await expect.poll(selection).toEqual([12, 12]);
    await openThread(roots[1], true);
    await page.keyboard.type("Second thread draft");
    await expect(reply).toHaveText("Second thread draft");
    await tab(roots[0]).click();
    await expect(reply).toBeFocused();
    await expect(reply).toHaveText("First thread draft");
    await expect.poll(selection).toEqual([12, 12]);
    await openThread(roots[1]);
    await expect(reply).toHaveText("Second thread draft");
    // Reopen the selected thread too, without relying on a selection change.
    await openThread(roots[1], true);
    await expect(reply).toHaveText("Second thread draft");
    await expect(
      host.locator('[role="tab"][data-tab-value^="thread:"]'),
    ).toHaveCount(2);
    await openThread(roots[0]);
    await expect.poll(selection).toEqual([12, 12]);
    await page.keyboard.type("X");
    await expect(reply).toHaveText("First threadX draft");
    // Reopening the selected thread also keeps its existing caret.
    await openThread(roots[0], true);
    await expect.poll(selection).toEqual([13, 13]);
  });
}

// The delayed read crosses the real broker/reader boundary. Hold its root until
// another owner has focus, then prove completion cannot reclaim that focus.
for (const owner of ["main draft", "menu", "dialog"]) {
  test(`a loading thread leaves focus with a later ${owner}`, async ({
    page,
    app,
  }) => {
    await open(page, app);
    const root = app.histories
      .get("primary/alpha")
      .find((row) => row.content === "Thread root 0");
    let release;
    let started;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const pending = new Promise((resolve) => {
      started = resolve;
    });
    await page.route("**/api/relay/**/query", async (route) => {
      if (
        route
          .request()
          .postDataJSON()
          .some((filter) => filter.ids?.includes(root.id))
      ) {
        started();
        await held;
      }
      await route.continue().catch(() => {});
    });
    try {
      await page
        .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
        .getByRole("button", { name: /^View thread:/ })
        .click();
      await pending;
      let target;
      if (owner === "main draft") {
        target = page.getByRole("textbox", {
          name: "Message #Alpha",
          exact: true,
        });
        await target.fill("Keep my main draft");
      } else if (owner === "menu") {
        await page.getByRole("button", { name: "New", exact: true }).click();
        target = page.getByRole("menuitem", { name: "New chat", exact: true });
        await target.focus();
      } else {
        await page
          .getByRole("button", { name: "Search Buzz", exact: true })
          .click();
        target = page.getByRole("combobox", {
          name: "Search Buzz",
          exact: true,
        });
        await expect(target).toBeFocused();
      }
      release();
      // The dialog correctly hides the workspace from the accessibility tree;
      // observe the retained editor DOM as the read-completion barrier.
      const reply = page.locator(
        '[aria-label="Reply to thread"][role="textbox"]',
      );
      await expect(reply).toHaveCount(1);
      await expect(target).toBeFocused();
      if (owner === "main draft")
        await expect(target).toHaveText("Keep my main draft");
    } finally {
      release();
    }
  });
}
