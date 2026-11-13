import { test, expect } from "./fixture.mjs";
import { newChat } from "./navigation.mjs";

const alpha = "33333333-3333-4333-8333-333333333333";
const beta = "44444444-4444-4444-8444-444444444444";
const gamma = "55555555-5555-4555-8555-555555555555";
test.use({
  pluginFixtures: true,
  productionBroker: true,
  channelIds: [alpha, beta, gamma],
  channelNames: { [alpha]: "Alpha", [beta]: "Beta", [gamma]: "Gamma" },
  soloChannels: [alpha, beta, gamma],
  ownSoloChannels: [alpha, beta, gamma],
  historyCounts: { [alpha]: 1, [beta]: 1, [gamma]: 1 },
});

const sidebar = (page) =>
  page.getByRole("navigation", { name: "Solo conversations" });
const row = (page, name) =>
  sidebar(page).getByRole("button", { name, exact: true });

// Real time passing, collapsible geometry and saved view state across a reload.
test("Solo folds chats quiet for 72 hours into Inactive and remembers it open", async ({
  page,
  app,
}) => {
  await page.clock.install();
  await page.goto(app.origin);
  await newChat(page);
  await expect(row(page, "Gamma")).toBeVisible();
  const inactive = sidebar(page).getByRole("button", {
    name: /^Inactive for 72 hours/,
  });
  await expect(inactive).toHaveCount(0);

  await page.clock.fastForward(72 * 3_600_000);
  await expect(inactive).toHaveAccessibleName(
    /^Inactive for 72 hours\s*\(3\)$/,
  );
  await expect(inactive).toHaveAttribute("aria-expanded", "false");
  await expect(row(page, "Alpha")).toBeHidden();

  await inactive.click();
  await expect(inactive).toHaveAttribute("aria-expanded", "true");
  await row(page, "Beta").click();
  // The open chat leaves Inactive for its workspace.
  await expect(inactive).toHaveAccessibleName(
    /^Inactive for 72 hours\s*\(2\)$/,
  );
  await expect(
    sidebar(page).locator("[data-solo-inactive]").getByRole("button", {
      name: "Beta",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(row(page, "Beta")).toBeVisible();

  await page.reload();
  await expect(inactive).toHaveAttribute("aria-expanded", "true");
  await expect(row(page, "Alpha")).toBeVisible();
});
