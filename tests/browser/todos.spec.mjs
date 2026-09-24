import { verifyEvent } from "nostr-tools";
import { test, expect } from "./fixture.mjs";

// Browser-only boundary: real plugin Settings/launcher/drawer wiring, Canvas
// outbox -> signed HTTP receipt -> readback, native focus and drawer geometry.
// Markdown/recovery permutations belong in colocated Vitest tests.
test("opt-in Todos saves ordinary Canvas and disabling leaves it editable", async ({
  page,
  app,
}) => {
  const original =
    "# Notes\nKeep this prose.\n\n## Todos\n\n- [ ] First\n\n## Decisions\nKeep these too.\n";
  let head = app.sign({
    kind: 40100,
    content: original,
    tags: [["h", "alpha"]],
    created_at: 1700000000,
  });
  const writes = [];
  await page.route("**/api/relay/primary/session", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      json: { ...(await response.json()), writeKinds: [9, 9007, 40100] },
    });
  });
  await page.route("**/api/relay/primary/query", async (route) => {
    const filters = route.request().postDataJSON();
    if (
      filters.every((f) => f.kinds?.includes(40100) || f.ids?.includes(head.id))
    )
      return route.fulfill({ json: [head] });
    return route.continue();
  });
  await page.route("**/api/relay/primary/sign", async (route) => {
    const template = route.request().postDataJSON();
    expect(template.kind).toBe(40100);
    await route.fulfill({ json: app.sign(template) });
  });
  await page.route("**/api/relay/primary/publish", async (route) => {
    const event = route.request().postDataJSON();
    expect(verifyEvent(event)).toBe(true);
    expect(event.kind).toBe(40100);
    expect(event.pubkey).toBe(app.viewer);
    expect(event.tags).toContainEqual(["h", "alpha"]);
    head = event;
    writes.push(event);
    await route.fulfill({ json: { accepted: true, event_id: event.id } });
  });
  const button = (name) => page.getByRole("button", { name, exact: true });
  const plugins = async () => {
    await button("Your profile").click();
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await button("Plugins").click();
  };
  const messages = async () => {
    await page
      .getByRole("navigation", { name: "Pages", exact: true })
      .getByRole("button", { name: "Messages", exact: true })
      .click();
    await expect(
      page
        .getByRole("article", { name: "Conversation" })
        .getByRole("heading", { name: "Alpha", exact: true }),
    ).toBeVisible();
  };
  await page.goto(app.origin);
  await messages();
  const launcher = button("Toggle channel todos");
  await expect(launcher).toHaveCount(0);
  await plugins();
  const enabled = page.getByRole("switch", {
    name: "Enable Todos",
    exact: true,
  });
  await expect(enabled).not.toBeChecked();
  await enabled.click();
  await expect(enabled).toBeChecked();
  await messages();
  await launcher.click();
  const drawer = page.getByRole("region", {
    name: "Todos drawer",
    exact: true,
  });
  const input = drawer.getByRole("textbox", { name: "New todo" });
  await input.fill("Ship it");
  await input.press("Enter");
  const todo = drawer.getByRole("checkbox", { name: "Ship it", exact: true });
  await todo.focus();
  await todo.press("Space");
  await expect(todo).toBeChecked();
  await expect(todo).toBeFocused();
  await drawer.getByRole("button", { name: "Save", exact: true }).click();
  await expect(drawer.getByRole("status")).toHaveText("Saved in Canvas");
  expect(writes).toHaveLength(1);
  expect(head.content).toBe(
    original.replace("## Todos", "## Todos\n\n- [x] Ship it\n"),
  );
  await page.screenshot({
    path: test.info().outputPath("todos-light-wide.png"),
  });
  // A shorter real drawer at narrow width with enlarged text; no second layout.
  await page.setViewportSize({ width: 600, height: 800 });
  await page.evaluate(() => {
    document.documentElement.dataset.colorMode = "dark";
    document.documentElement.style.setProperty("--buzz-text-scale", "1.25");
  });
  await expect(drawer).toBeVisible();
  await expect(
    drawer.getByRole("button", { name: "Refresh" }),
  ).toBeInViewport();
  await expect(
    drawer.getByRole("button", { name: "Save", exact: true }),
  ).toBeInViewport();
  expect(await drawer.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: test.info().outputPath("todos-dark-narrow.png"),
  });
  await drawer.getByRole("button", { name: "Hide todos" }).click();
  await expect(launcher).toBeFocused();
  await plugins();
  await enabled.click();
  await expect(enabled).not.toBeChecked();
  await messages();
  await expect(launcher).toHaveCount(0);
  await expect(drawer).toHaveCount(0);
  await button("Channel settings").click();
  await button("Canvas").click();
  const canvas = page.getByRole("textbox", {
    name: "Canvas Markdown",
    exact: true,
  });
  await expect(canvas).toHaveValue(head.content);
  await expect(canvas).toBeEditable();
});
