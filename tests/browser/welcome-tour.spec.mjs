import { expect, test } from "./fixture.mjs";

const solo = "33333333-3333-4333-8333-333333333333";

test.use({
  productionBroker: true,
  channelIds: [solo, "beta"],
  channelNames: { [solo]: "Alpha", beta: "Beta" },
  soloChannels: [solo],
  ownSoloChannels: [solo],
  dmLabels: true,
  historyCounts: { [solo]: 1, beta: 1 },
  enabledPlugins: ["buzz.bestie"],
});

const titles = [
  "Welcome to Buzz",
  "Solo chats",
  "Channels",
  "Direct messages",
  "Activity",
  "Plugins",
  "Questions? Ask here anytime",
];

/** What starting Buzz with no community records for this account. */
async function arriveNew(page, app) {
  await page.addInitScript((viewer) => {
    localStorage.setItem(`buzz.seen.v1:${viewer}:buzz.shell/new-to-buzz`, "1");
  }, app.viewer);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(app.origin);
}

// Where plugins show up: the sidebar's Plugins card, or the apps dock in a
// sidebar without one.
const pluginsHome = (page) =>
  page
    .locator('[data-sidebar-section="pages"]')
    .or(page.getByRole("tablist", { name: "Apps" }));
const searchButton = (page) =>
  page.getByRole("button", { name: "Search Buzz", exact: true });

const ringAround = (page, target) =>
  expect
    .poll(async () => {
      const ring = await page
        .getByTestId("welcome-tour-spotlight")
        .boundingBox();
      const box = await target.boundingBox();
      return (
        !!ring &&
        !!box &&
        ring.x <= box.x &&
        ring.y <= box.y &&
        ring.x + ring.width >= box.x + box.width &&
        ring.y + ring.height >= box.y + box.height
      );
    })
    .toBe(true);

test("someone new to Buzz gets the welcome tour once, which outlines each part it's about", async ({
  page,
  app,
}) => {
  await arriveNew(page, app);
  const card = page.getByRole("dialog", { name: "Welcome to Buzz" });
  const sidebar = page.locator("#shell-navigation");
  // What each card after the welcome moves beside and outlines.
  const outlined = [
    sidebar.locator('[data-sidebar-section="solo"]'),
    sidebar.locator('[data-sidebar-section="channels"]'),
    sidebar.locator('[data-sidebar-section="dms"]'),
    sidebar.getByRole("button", { name: /^Activity/ }),
    pluginsHome(page),
    searchButton(page),
  ];
  await expect(card).toBeVisible();
  for (const [step, title] of titles.entries()) {
    await expect(card.getByRole("heading")).toHaveText(title);
    await expect(card).toContainText(`Step ${step + 1} of ${titles.length}`);
    if (step === 0)
      await expect(page.getByTestId("welcome-tour-spotlight")).toHaveCount(0);
    else await ringAround(page, outlined[step - 1]);
    if (step < titles.length - 1)
      await card.getByRole("button", { name: "Next" }).click();
  }
  await card.getByRole("button", { name: "Back" }).click();
  await expect(card.getByRole("heading")).toHaveText("Plugins");
  await card.getByRole("button", { name: "Close" }).click();
  await expect(card).toBeHidden();
  await expect(page.getByTestId("welcome-tour-spotlight")).toHaveCount(0);
  // Closed counts as seen: it does not come back.
  await page.clock.install();
  await page.reload();
  await expect(searchButton(page)).toBeVisible();
  await page.clock.runFor(3000);
  await expect(card).toHaveCount(0);
});

test("someone already using Buzz does not get the welcome tour", async ({
  page,
  app,
}) => {
  await page.clock.install();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(app.origin);
  await expect(searchButton(page)).toBeVisible();
  await page.clock.runFor(3000);
  await expect(
    page.getByRole("dialog", { name: "Welcome to Buzz" }),
  ).toHaveCount(0);
});

test("search starts the tour again, and its last card leads to setting up an agent", async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(app.origin);
  await searchButton(page).click();
  await page.getByRole("combobox", { name: "Search Buzz" }).fill("tour");
  await page.getByRole("option", { name: /Take the Buzz tour/ }).click();
  const card = page.getByRole("dialog", { name: "Welcome to Buzz" });
  await expect(card.getByRole("heading")).toHaveText("Welcome to Buzz");
  await card.getByRole("button", { name: "Next" }).click();
  for (let step = 2; step < titles.length; step++)
    await page.keyboard.press("ArrowRight");
  await expect(card.getByRole("heading")).toHaveText(titles.at(-1));
  await card.getByRole("button", { name: "Set up your agent" }).click();
  await expect(card).toBeHidden();
  await expect(
    page
      .getByRole("region", { name: "Bestie" })
      .getByRole("heading", { name: "Create your first agent" }),
  ).toBeVisible();
});
