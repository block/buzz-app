import { open } from "./timeline.mjs";
const button = (page, name) => page.getByRole("button", { name, exact: true });
import { test, expect } from "./fixture.mjs";
test.use({ homeEnabled: true, historyCounts: { alpha: 20, beta: 1 } });
const address = (origin, target) =>
  `${origin}/#buzz=${encodeURIComponent(JSON.stringify(target))}`;
const pages = (page) =>
  page.getByRole("navigation", { name: "Pages", exact: true });
test("restores the retained Home page and all its entry points", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await expect(
    page.getByRole("heading", { name: "Make yourself at home." }),
  ).toBeVisible();
  await expect(
    pages(page).getByRole("button", { name: "Home", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("main").getByRole("button")).toHaveText([
    "Messages",
    "Projects",
    "Agents",
    "Sessions",
    "Workflows",
    "Make it yours · Settings",
  ]);
  await page.getByRole("button", { name: "Search Buzz" }).click();
  await page.getByRole("option", { name: "Home", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Make yourself at home." }),
  ).toBeVisible();
  await page.goto(
    address(app.origin, {
      version: 1,
      kind: "page",
      pluginId: "missing.page",
      pageId: "missing",
    }),
  );
  await page.getByRole("button", { name: "Go Home", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Make yourself at home." }),
  ).toBeVisible();
});
test("shared type and spacing reach Home and the real message timeline", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await button(page, "Home").click();
  await expect(
    page.getByRole("heading", { name: "Make yourself at home." }),
  ).toHaveCSS("font-size", "56px");
  await expect(
    page.getByRole("heading", { name: "Make yourself at home." }),
  ).toHaveCSS("line-height", "56px");
  await open(page, app);
  const history = page.getByRole("region", { name: "Channel message history" });
  const message = history.locator("[data-message-id] p").first();
  await expect(message).toHaveCSS("font-size", "14px");
  // WebKit exposes the fractional product of the shared 14px × 1.42857 role.
  await expect
    .poll(async () =>
      message.evaluate((element) =>
        Number.parseFloat(getComputedStyle(element).lineHeight),
      ),
    )
    .toBeCloseTo(20, 3);
  await expect(history).toHaveCSS("padding-left", "24px");
  const sidebar = page.getByRole("complementary", { name: "Channel sidebar" });
  await expect(
    sidebar.getByRole("button", { name: "Alpha", exact: true }),
  ).toHaveCSS("font-size", "14px");
  await expect(
    sidebar.locator("..").getByRole("separator", {
      name: "Resize channel sidebar",
    }),
  ).toHaveCSS("width", "16px");
  const back = button(page, "Go back").locator("svg");
  await expect(button(page, "Search Buzz").locator("svg")).toHaveCSS(
    "width",
    await back.evaluate((element) => getComputedStyle(element).width),
  );
});
