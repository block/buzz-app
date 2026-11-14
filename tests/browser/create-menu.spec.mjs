import { test, expect } from "./fixture.mjs";
test.use({
  productionBroker: true,
  savedSidebar: true,
  readState: true,
  inboxDm: true,
});
// Real menu focus/keyboard dispatch and the two card bounds need a browser.
test("Create menu numbers activate rows and rail controls share one card", async ({
  page,
  app,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(app.origin);
  const rail = page.getByRole("navigation", { name: "Apps", exact: true });
  const create = rail.getByRole("button", { name: "Create", exact: true });
  const search = rail.getByRole("button", { name: "Search", exact: true });
  await expect(create).toBeVisible();
  const community = rail.getByRole("button", { name: /^Community switcher:/ });
  const status = rail.getByRole("button", {
    name: "Your profile",
    exact: true,
  });
  const controls = [community, status, search, create];
  const boxes = await Promise.all(
    controls.map((control) => control.boundingBox()),
  );
  for (const [index, box] of boxes.entries()) {
    expect(box.height).toBe(boxes[0].height);
    expect(box.width).toBe(boxes[0].width);
    expect(box.y).toBe(boxes[0].y);
    if (index) expect(box.x).toBeGreaterThan(boxes[index - 1].x);
  }
  await expect(rail.getByText("Buzz", { exact: true })).toHaveCount(0);
  await expect(
    page
      .locator(".shell-actions")
      .getByRole("button", { name: /^Community switcher:/ }),
  ).toHaveCount(0);
  await create.click();
  await expect(
    page.getByRole("menu", { name: "New", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("1");
  await expect(
    page.getByRole("region", { name: "New chat", exact: true }),
  ).toBeVisible();
  await create.click();
  const menu = page.getByRole("menu", { name: "New", exact: true });
  await expect(menu.locator("kbd")).toHaveCount(5);
  // This fixture has no workspace writer: a shortcut must respect availability.
  await expect(menu.getByRole("menuitem").nth(1)).toBeDisabled();
  await page.keyboard.press("2");
  await expect(menu).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(create).toBeFocused();
  await create.click();
  await expect(menu).toBeVisible();
  await expect
    .poll(() => menu.evaluate((node) => node.contains(document.activeElement)))
    .toBe(true);
  await page.keyboard.press("3");
  await expect(
    page.getByRole("textbox", { name: "New message", exact: true }),
  ).toBeVisible();
  await create.click();
  await expect(menu).toBeVisible();
  await page.keyboard.press("5");
  const section = page.getByRole("dialog", {
    name: "Create new section",
    exact: true,
  });
  await expect(section).toBeVisible();
  const name = section.getByRole("textbox", {
    name: "Section name",
    exact: true,
  });
  await name.fill("12345");
  await expect(name).toHaveValue("12345");
  await name.clear();
  await page.keyboard.press("Escape");
  await expect(section).toBeHidden();
  await expect(create).toBeFocused();
  await create.click();
  await page.keyboard.press("9");
  await expect(
    page.getByRole("menu", { name: "New", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("create-numbered-menu.png"),
  });
});
