import { test, expect } from "./fixture.mjs";
import { activate, clickRow, open } from "./timeline.mjs";

// Browser-only, as inline-openings.spec: real history events and sheet
// layout. The fixture plugins add a third-party link panel that matches
// every link and drills into a child, and a Solo chat to link to.
test.use({
  threadPlacement: "inline",
  pluginFixtures: true,
  productionBroker: true,
  dmLabels: true,
  agentPeers: true,
  soloChannels: ["beta"],
  channelWriteKinds: [9, 9000, 9007],
  historyCounts: { alpha: 2, beta: 2 },
});

const sheets = (page) => page.locator("[data-details-sheet-surface]");
const titled = (page, name) =>
  sheets(page).and(page.getByRole("dialog", { name, exact: true }));
const side = (page) => page.locator("[data-panel-workspace]");
// The visit's target, as the browser history entry records it.
const address = (page) =>
  page.evaluate(() => history.state.buzzNavigationV1.entry.target);

async function chooseModel(page, panel) {
  const model = panel.getByRole("combobox", { name: "Model", exact: true });
  await panel.evaluate((sheet) => {
    window.inlinePanelScrolls = [];
    // The pane can scroll and snap back within one paint. Capture the scroll
    // event so the check also covers movement that has already settled.
    document.addEventListener(
      "scroll",
      (event) => {
        const scroller = event.target;
        if (
          scroller instanceof Element &&
          scroller.contains(sheet) &&
          scroller.scrollLeft
        ) {
          window.inlinePanelScrolls.push(scroller.scrollLeft);
        }
      },
      true,
    );
  });
  await model.click();
  await page
    .getByRole("option", { name: "GPT-6.3 Codex", exact: true })
    .click();
  await expect(model).toContainText("GPT-6.3 Codex");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  expect(await page.evaluate(() => window.inlinePanelScrolls)).toEqual([]);
}

test.describe("Inline thread", () => {
  test.use({ threadUnread: true });
  test("opening a Model picker over an inline thread keeps the thread in place", async ({
    page,
    app,
  }) => {
    await page.setViewportSize({ width: 1200, height: 747 });
    await open(page, app);
    const root = app.histories
      .get("primary/alpha")
      .find((row) => row.content === "Thread root 0");
    app.append(
      "primary",
      "alpha",
      "See [model settings](https://example.org/model-settings)",
      false,
      true,
      root.id,
    );
    await clickRow(
      page,
      page
        .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
        .getByRole("button", { name: /^View thread:/ }),
    );
    await activate(
      titled(page, "Thread").getByRole("link", { name: "model settings" }),
    );
    await chooseModel(page, titled(page, "Wrong panel"));
  });
});

test("a plugin's link panel opens inline and drills in with a visit of its own", async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 1200, height: 747 });
  await open(page, app);
  const target = "https://example.org/model-settings";
  app.append("primary", "alpha", `See [model settings](${target})`);
  await activate(page.getByRole("link", { name: "model settings" }));
  const panel = titled(page, "Wrong panel");
  await expect(panel).toBeVisible();
  await expect(side(page).getByRole("tab")).toHaveCount(0);
  await chooseModel(page, panel);
  await panel
    .getByRole("textbox", { name: "Panel draft" })
    .fill("Parent draft");
  const visiblePanel = await panel.elementHandle();
  try {
    await panel.getByRole("button", { name: "Open child detail" }).click();
    await expect
      .poll(async () => (await address(page)).layer?.target)
      .toBe(`${target}:detail`);
    await expect(
      panel.getByRole("textbox", { name: "Panel draft" }),
    ).toHaveValue("");
    // The destination changes without folding the sheet back into the composer.
    expect(await visiblePanel.evaluate((element) => element.isConnected)).toBe(
      true,
    );
    await expect(panel).toBeFocused();
  } finally {
    await visiblePanel.dispose();
  }
  await page.goBack();
  await expect
    .poll(async () => (await address(page)).layer?.target)
    .toBe(target);
  await expect(titled(page, "Wrong panel")).toBeVisible();
  await page.goBack();
  await expect(sheets(page)).toHaveCount(0);
  // The panel has no address, so Open as tab returns to the visit beneath
  // it, which had no tabs. Its tab still opens, selected.
  await page.goForward();
  await titled(page, "Wrong panel")
    .getByRole("button", { name: "Open as tab", exact: true })
    .click();
  await expect(sheets(page)).toHaveCount(0);
  await expect(
    side(page).getByRole("tab", { name: "Wrong panel", selected: true }),
  ).toBeVisible();
  await expect(
    side(page).getByRole("button", { name: "Open child detail" }),
  ).toBeVisible();
});

test("a Solo chat link goes to the chat instead of opening its tab", async ({
  page,
  app,
}) => {
  await open(page, app);
  app.append(
    "primary",
    "alpha",
    "Please review [the chat](buzz://channel/beta)",
  );
  await activate(page.getByRole("link", { name: "the chat" }));
  await expect.poll(async () => (await address(page)).channelId).toBe("beta");
  await expect(
    page.getByRole("article", { name: "Conversation", exact: true }),
  ).not.toContainText("Please review the chat");
  await expect(side(page).getByRole("tab")).toHaveCount(0);
  await page.goBack();
  await expect.poll(async () => (await address(page)).channelId).toBe("alpha");
});
