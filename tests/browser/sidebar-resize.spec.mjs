import { test, expect } from "./fixture.mjs";

// Browser-only: CSS cascade and grid placement cannot be verified in jsdom.
test("resizing the app rail keeps the conversation in the first grid row", async ({
  page,
  app,
}) => {
  await page.goto(app.origin, { waitUntil: "domcontentloaded" });
  const rail = page.getByRole("navigation", { name: "Apps", exact: true });
  const handle = page.getByRole("separator", { name: "Resize app sidebar" });
  const body = page.locator(".shell-body");
  await expect(rail).toBeVisible();
  await expect(handle).toBeVisible();
  const aligned = async () => {
    const [railBox, bodyBox] = await Promise.all([
      rail.boundingBox(),
      body.boundingBox(),
    ]);
    return Math.abs(railBox.y - bodyBox.y) < 2;
  };
  await expect.poll(aligned).toBe(true);
  await expect(handle).toHaveCSS("position", "absolute");
  const box = await handle.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 160, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(
    page.getByRole("button", { name: "Hide sidebar", exact: true }),
  ).toBeVisible();
  await expect.poll(aligned).toBe(true);
  await expect(rail).toHaveCSS("width", "240px");
  await handle.dblclick();
  await expect(
    page.getByRole("button", { name: "Hide sidebar", exact: true }),
  ).toBeVisible();
  await expect.poll(aligned).toBe(true);
});

test("compact Pins opens with its master list visible", async ({
  page,
  app,
}) => {
  await page.goto(app.origin, { waitUntil: "domcontentloaded" });
  const rail = page.getByRole("navigation", { name: "Apps", exact: true });
  await page.getByRole("button", { name: "Hide sidebar", exact: true }).click();
  for (const title of ["Pins"]) {
    const tile = rail.getByRole("button", { name: title, exact: true });
    const railContent = rail.locator(".buzz-sidebar-navigation").locator("..");
    await expect(railContent).toBeVisible();
    await expect(tile).toBeVisible();
    const railBounds = await railContent.boundingBox();
    const tileBounds = await tile.boundingBox();
    expect(tileBounds.x).toBeGreaterThanOrEqual(railBounds.x);
    expect(tileBounds.x + tileBounds.width).toBeLessThanOrEqual(
      railBounds.x + railBounds.width,
    );
    await tile.click();
    const workspace = page.getByRole("region", {
      name: `${title} workspace`,
      exact: true,
    });
    await expect(workspace).toBeVisible();
    await expect(workspace.locator('[data-list-open="true"]')).toBeVisible();
    await expect(
      workspace.getByRole("heading", { name: title, exact: true }),
    ).toBeVisible();
  }
});
