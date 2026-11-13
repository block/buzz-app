import { test, expect } from "./fixture.mjs";
import { newChat } from "./navigation.mjs";

const ids = [
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
  "55555555-5555-4555-8555-555555555555",
];
const names = ["Planning", "Archive", "Main Focus"];
test.use({
  productionBroker: true,
  pluginFixtures: true,
  channelIds: ids,
  channelNames: Object.fromEntries(
    ids.map((id, i) => [id, `${names[i]} chat`]),
  ),
  soloChannels: ids,
  ownSoloChannels: ids,
  historyCounts: Object.fromEntries(ids.map((id) => [id, 0])),
});

// Browser hit testing proves header-only activation, insertion edges and
// click suppression; the production broker proves saved order after reload.
for (const composed of [false, true]) {
  test(`dragging workspace titles saves order without collapsing or filing chats (${composed ? "composed" : "ordinary"})`, async ({
    page,
    app,
  }, testInfo) => {
    await page.clock.install();
    await page.goto(
      app.origin +
        (composed
          ? "/?solo-region-fixture&compose-workspaces&workspace-hit-targets"
          : ""),
    );
    await newChat(page);
    const sidebar = page.getByRole("navigation", {
      name: "Solo conversations",
    });
    for (const [i, name] of names.entries()) {
      await sidebar
        .locator(`[data-solo-channel-id="${ids[i]}"]`)
        .click({ button: "right" });
      await page
        .getByRole("menuitem", { name: "Move to", exact: true })
        .hover();
      await page
        .getByRole("menuitem", { name: "New workspace", exact: true })
        .click();
      const dialog = page.getByRole("dialog");
      const field = dialog.getByRole("textbox", { name: "Workspace name" });
      await expect(field).toBeFocused();
      await field.fill(name);
      await dialog
        .getByRole("button", { name: "Create and move", exact: true })
        .click();
      await expect(dialog).not.toBeVisible();
      await expect
        .poll(() => app.report.sidebarPublications?.length ?? 0)
        .toBe(i + 1);
      // Replaceable catalog writes require distinct seconds.
      await page.clock.runFor(1100);
    }
    const handles = sidebar.locator(
      "[data-project] [data-workspace-drag-handle]",
    );
    const handle = (name) => handles.filter({ hasText: name });
    const workspace = (name) =>
      handle(name).locator("xpath=ancestor::*[@data-project][1]");
    const order = (expected) => expect(handles).toHaveText(expected);
    await order(names);
    const assignments =
      app.report.sidebarPublications.at(-1).blob.value.assignments;
    const publicationCount = () => app.report.sidebarPublications.length;
    let count = publicationCount();

    // An ordinary title click still collapses; composed titles select, and
    // their independent disclosure still collapses. Neither saves an order.
    const disclosure = composed
      ? sidebar.getByRole("button", {
          name: "Hide tasks and chats in Main Focus",
          exact: true,
        })
      : handle("Main Focus");
    await disclosure.click();
    await expect(
      sidebar.locator(`[data-solo-channel-id="${ids[2]}"]`),
    ).not.toBeVisible();
    await (composed
      ? sidebar.getByRole("button", {
          name: "Show tasks and chats in Main Focus",
          exact: true,
        })
      : handle("Main Focus")
    ).click();
    await expect(
      sidebar.locator(`[data-solo-channel-id="${ids[2]}"]`),
    ).toBeVisible();
    expect(publicationCount()).toBe(count);

    async function drag(name, target, expected) {
      const from = await handle(name).boundingBox();
      const to = await handle(target).boundingBox();
      const start = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
      const end = { x: to.x + to.width / 2, y: to.y + to.height / 2 };
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      for (let step = 1; step <= 8; step++)
        await page.mouse.move(
          start.x + ((end.x - start.x) * step) / 8,
          start.y + ((end.y - start.y) * step) / 8,
        );
      await expect(workspace(name)).toHaveAttribute(
        "data-section-dragging",
        "true",
      );
      await expect(workspace(target)).toHaveAttribute(
        "data-drop-edge",
        expected.indexOf(name) < expected.indexOf(target) ? "before" : "after",
      );
      await page.mouse.up();
      await order(expected);
      await expect.poll(publicationCount).toBe(++count);
      const saved = app.report.sidebarPublications.at(-1).blob.value;
      expect(saved.groups.map((group) => group.name)).toEqual(expected);
      expect(saved.assignments).toEqual(assignments);
      for (const id of ids)
        await expect(
          sidebar.locator(`[data-solo-channel-id="${id}"]`),
        ).toBeVisible();
      await expect(sidebar.getByRole("alert")).toHaveCount(0);
      await page.clock.runFor(1100);
    }
    await drag("Main Focus", "Planning", ["Main Focus", "Planning", "Archive"]);
    await drag("Main Focus", "Archive", ["Planning", "Archive", "Main Focus"]);
    await drag("Main Focus", "Planning", ["Main Focus", "Planning", "Archive"]);

    await sidebar
      .getByRole("button", { name: "Actions for Main Focus", exact: true })
      .click();
    await expect(
      page.getByRole("menuitem", { name: "Workspace settings", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: /^Move (to top|up|down)$/ }),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");
    expect(publicationCount()).toBe(count);
    await page.reload();
    await expect(sidebar).toBeVisible();
    await order(["Main Focus", "Planning", "Archive"]);
    await expect(sidebar.getByRole("alert")).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath("saved-drag-order.png"),
    });
  });
}
