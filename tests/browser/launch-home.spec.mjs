import { test, expect } from "./fixture.mjs";

test.use({ pluginFixtures: true });

const home = { version: 1, kind: "home" };
const settings = { version: 1, kind: "settings" };
const address = (origin, target) =>
  `${origin}/#buzz=${encodeURIComponent(JSON.stringify(target))}`;
const pages = (page) =>
  page.getByRole("navigation", { name: "Pages", exact: true });
const messages = (page) =>
  page.getByRole("textbox", { name: "Message #Alpha", exact: true });

// Browser-only contract: startup/hash/history share production composition and
// no Home content may flash on a visible frame. Both build-time switch states
// use the same real app, not a fixture replacement of its navigation.
test("launch opens Messages without exposing Home across responsive navigation, search and history", async ({
  page,
  app,
}, testInfo) => {
  await page.addInitScript(() => {
    window.homeFrames = [];
    function observe() {
      const main = document.getElementById("main-content");
      if (main?.textContent.includes("Make yourself at home."))
        window.homeFrames.push(main.textContent);
      requestAnimationFrame(observe);
    }
    requestAnimationFrame(observe);
  });
  await page.goto(app.origin);
  await expect(messages(page)).toBeVisible();
  for (const width of [390, 820, 1440]) {
    await page.setViewportSize({ width, height: 950 });
    await expect(
      pages(page).getByRole("button", { name: "Messages", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    await expect(
      pages(page).getByRole("button", { name: "Home", exact: true }),
    ).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
  }
  await page.screenshot({ path: testInfo.outputPath("launch-messages.png") });
  await page.getByRole("button", { name: "Search Buzz" }).click();
  const dialog = page.getByRole("dialog", { name: "Search Buzz" });
  await expect(
    dialog.getByRole("option", { name: "Messages", exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("option", { name: "Home", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await pages(page)
    .getByRole("button", { name: "Projects", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Projects", exact: true }),
  ).toBeVisible();
  const result = await page.evaluate(async (target) => {
    const nav = window.fixtureNavigation;
    const pending = nav.open(target);
    const visit = nav.snapshot().entry.id;
    return { result: await pending, visit, resolved: nav.snapshot().entry.id };
  }, home);
  expect(result.result).toEqual({ status: "opened" });
  expect(result.resolved).toBe(result.visit);
  await expect(messages(page)).toBeVisible();
  await page.goBack();
  await expect(
    page.getByRole("heading", { name: "Projects", exact: true }),
  ).toBeVisible();
  await page.goForward();
  await expect(messages(page)).toBeVisible();
  expect(await page.evaluate(() => window.homeFrames)).toEqual([]);

  await page.goto(address(app.origin, home));
  await expect(messages(page)).toBeVisible();
  await page.reload();
  await expect(messages(page)).toBeVisible();
  expect(await page.evaluate(() => window.homeFrames)).toEqual([]);
});

test("Channels stays enabled despite saved disabled settings and has no switch", async ({
  page,
  app,
}) => {
  await page.goto(address(app.origin, settings));
  await page.getByRole("button", { name: "Plugins", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Channels", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("switch", { name: "Enable Channels", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("switch", { name: "Enable Projects", exact: true }),
  ).toBeVisible();
  // Older disabled preferences cannot turn off the required launch destination.
  await page.evaluate(() => {
    const key = "buzzodz.plugins.v1";
    const saved = JSON.parse(localStorage.getItem(key)) ?? {
      version: 2,
      enabled: {},
    };
    saved.enabled["buzz.channels"] = false;
    localStorage.setItem(key, JSON.stringify(saved));
  });
  await page.goto(address(app.origin, home));
  await expect(messages(page)).toBeVisible();
  await page.reload();
  await expect(messages(page)).toBeVisible();
  await page.goto(address(app.origin, settings));
  await page.getByRole("button", { name: "Plugins", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Channels", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("switch", { name: "Enable Channels", exact: true }),
  ).toHaveCount(0);
  await pages(page)
    .getByRole("button", { name: "Messages", exact: true })
    .click();
  await expect(messages(page)).toBeVisible();
});

test("launch retains plugin-configuration recovery without Home", async ({
  page,
  app,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("buzzodz.plugins.v1", "invalid"),
  );
  await page.goto(app.origin);
  await expect(
    page.getByRole("heading", { name: "Couldn’t open Buzz", exact: true }),
  ).toBeVisible();
  await expect(
    pages(page).getByRole("button", { name: "Home", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Your profile", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Display name", exact: true }),
  ).toBeVisible();
  await page.goBack();
  await page
    .getByRole("button", { name: "Back up & reset settings", exact: true })
    .click();
  await expect(
    pages(page).getByRole("button", { name: "Messages", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Retry navigation", exact: true })
    .click();
  await expect(messages(page)).toBeVisible();
});
