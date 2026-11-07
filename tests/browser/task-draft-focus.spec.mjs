import { test, expect } from "./fixture.mjs";
import { newChat } from "./navigation.mjs";

// Real menu teardown and browser focus determine where keyboard input goes.
test.use({
  pluginFixtures: true,
  largeSidebar: false,
  historyCounts: { alpha: 0, beta: 0 },
});

for (const selection of ["pointer", "keyboard"]) {
  test(`Create New task gives the editor keyboard focus after ${selection} selection`, async ({
    page,
    app,
  }, testInfo) => {
    await page.goto(`${app.origin}/?solo-region-fixture&solo-task-fixture`);
    await newChat(page);
    await page.evaluate(() => {
      window.__taskFocusEvents = [];
      document.addEventListener("focusin", (event) => {
        const node = event.target;
        window.__taskFocusEvents.push({
          tag: node.tagName,
          role: node.getAttribute("role"),
          label: node.getAttribute("aria-label"),
          text: node.textContent?.slice(0, 80),
        });
      });
    });
    const create = page.getByRole("button", { name: "Create", exact: true });
    if (selection === "pointer") await create.click();
    else {
      await create.focus();
      await page.keyboard.press("Enter");
    }
    const menu = page.getByRole("menu", { name: "Create", exact: true });
    const item = menu.getByRole("menuitem", { name: "New task", exact: true });
    if (selection === "pointer") await item.click();
    else {
      await item.focus();
      await page.keyboard.press("Enter");
    }
    const editor = page
      .getByRole("region", { name: "New task", exact: true })
      .getByRole("textbox", { name: "Message your task agent", exact: true });
    await expect(menu).toHaveCount(0);
    try {
      await expect(editor).toBeFocused();
    } finally {
      await testInfo.attach("focus-events", {
        body: JSON.stringify(
          await page.evaluate(() => ({
            events: window.__taskFocusEvents,
            active: document.activeElement?.outerHTML,
          })),
          null,
          2,
        ),
        contentType: "application/json",
      });
    }
    await page.keyboard.type("Review task creation focus");
    await expect(editor).toHaveText("Review task creation focus");
    await expect(editor).toBeFocused();
  });
}

test("Escape restores the Create trigger without opening a task", async ({
  page,
  app,
}) => {
  await page.goto(`${app.origin}/?solo-region-fixture&solo-task-fixture`);
  await newChat(page);
  const create = page.getByRole("button", { name: "Create", exact: true });
  await create.focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("menu", { name: "Create", exact: true });
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(create).toBeFocused();
  await expect(
    page.getByRole("region", { name: "New task", exact: true }),
  ).toHaveCount(0);
});
