import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({
  developmentReact: true,
  historyCounts: { alpha: 1, beta: 0 },
});

const button = (page, name) => page.getByRole("button", { name, exact: true });

test("Developer opens through App routing and restores from history", async ({
  page,
  app,
}) => {
  await page.route("**/api/relay/stats", (route) =>
    route.fulfill({ json: { queries: 0, errors: 0, media: 0, connects: 0 } }),
  );
  await open(page, app);
  await button(page, "Your profile").click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  const sections = page.getByRole("navigation", { name: "Settings sections" });
  const profile = sections.getByRole("button", {
    name: "Profile",
    exact: true,
  });
  const developer = sections.getByRole("button", {
    name: "Developer",
    exact: true,
  });
  await developer.click();
  await expect(developer).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("heading", { name: "Developer", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(developer).toHaveAttribute("aria-current", "page");
  await button(page, "Go back").click();
  await expect(profile).toHaveAttribute("aria-current", "page");
});
