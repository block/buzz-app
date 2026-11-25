import { test, expect } from "./fixture.mjs";
import {
  clickSidebarHeadingAction,
  openPage,
  settleShellToggle,
} from "./navigation.mjs";

// The roster can paint before the saved stars and workspaces arrive. Alpha then
// starts in its default section and leaves it, inert, while its saved copy
// enters. Name the saved section so a gesture waits for the row it means.
const starredAlpha =
  '[data-sidebar-section="starred"] [data-channel-id="alpha"]';

// Browser ownership: real pointer collision/activation, menu-to-modal focus,
// relocation and cold reload through the production preference broker.
// Input/error permutations remain in the colocated component/store tests.
test.use({ productionBroker: true, savedSidebar: true, largeSidebar: false });

test("Team offers empty-workspace creation with keyboard focus, emoji and confirmed persistence", async ({
  page,
  app,
}, testInfo) => {
  await page.goto(app.origin);
  await openPage(page, "Messages");
  const trigger = page.getByRole("button", {
    name: "More actions for Team",
    exact: true,
  });
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(
    page
      .getByRole("menu", { name: "More actions for Team", exact: true })
      .getByRole("menuitem"),
  ).toHaveText(["Sort", "Filter", "Create workspace", "Move up", "Move down"]);
  await page
    .getByRole("menuitem", { name: "Create workspace", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "New workspace" });
  const field = dialog.getByRole("textbox", { name: "Name" });
  await expect(field).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  expect(app.report.sidebarPublications ?? []).toHaveLength(0);
  await clickSidebarHeadingAction(trigger);
  await page
    .getByRole("menuitem", { name: "Create workspace", exact: true })
    .click();
  await expect(field).toBeFocused();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expectIconCentered(dialog);
  await dialog.screenshot({
    path: testInfo.outputPath("create-section-empty-light.png"),
  });
  const placeholder = dialog.getByRole("button", {
    name: "Choose section emoji",
  });
  await placeholder.click();
  const search = page.getByRole("searchbox", { name: "Search emoji" });
  await expect(search).toBeFocused();
  const picker = page.getByRole("dialog", {
    name: "Emoji picker",
    exact: true,
  });
  await expect(picker).toHaveAttribute("data-side", "bottom");
  await expect(
    picker.getByRole("button", { name: "Remove emoji" }),
  ).toHaveCount(0);
  await expect(dialog.getByText("Emoji is optional")).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("create-section-picker-below-light.png"),
    clip: { x: 480, y: 270, width: 520, height: 665 },
  });
  await search.press("Escape");
  await expect(search).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(placeholder).toBeFocused();
  await placeholder.click();
  await search.fill("exclamation");
  await page.getByRole("button", { name: "❗", exact: true }).click();
  await expect(search).toHaveCount(0);
  const exclamation = dialog.getByRole("button", {
    name: "Change section emoji, currently ❗",
  });
  await expect(exclamation).toBeFocused();
  await expectIconCentered(dialog);
  await exclamation.press("Enter");
  await expect(search).toBeFocused();
  await expectIconCentered(dialog);
  await search.press("Escape");
  await expect(exclamation).toBeFocused();
  await expectIconCentered(dialog);
  await exclamation.click();
  await search.fill("bus");
  await page.getByRole("button", { name: "🚌", exact: true }).click();
  await expect(search).toHaveCount(0);
  const selected = dialog.getByRole("button", {
    name: "Change section emoji",
  });
  await expect(selected).toBeFocused();
  await expect(selected).toHaveAttribute("aria-expanded", "false");
  await field.fill("Launch");
  await expectIconCentered(dialog);
  await dialog.screenshot({
    path: testInfo.outputPath("create-section-unicode-light.png"),
  });
  await expect(field).toHaveValue("Launch");
  const creations = [];
  let lostResponse = false;
  let awaitingReconciliation = false;
  let failWriterRead = false;
  let writerReads = 0;
  await page.route("**/query", async (route) => {
    const filters = route.request().postDataJSON();
    if (
      awaitingReconciliation &&
      Array.isArray(filters) &&
      filters.length === 5 &&
      filters.some((filter) => filter["#d"]?.includes("channel-workspaces"))
    ) {
      if (filters.every((filter) => filter.consistency === "strong")) {
        writerReads++;
        if (failWriterRead) {
          // Relay recovery retries a transient failure such as a 502 about a
          // second later, which can remove Retry preferences while a slow
          // click is still landing. A denial leaves the retry to the user.
          // Keep denying until the test retries: the accepted creation's live
          // invalidation can land after the first denial and owe one more
          // strong read, which must not recover preferences on its own.
          app.report.relayFailures ??= [];
          app.report.relayFailures.push(route.request().url());
          await route.fulfill({
            status: 403,
            contentType: "application/json",
            body: JSON.stringify({ error: "Preference read unavailable" }),
          });
          return;
        }
        awaitingReconciliation = false;
      } else {
        // A replica is still behind the accepted write. Only writer routing
        // can reconcile this creation before the dialog discards its ID.
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: "[]",
        });
        return;
      }
    }
    await route.continue();
  });
  const loseCreationResponse = async (route) => {
    creations.push(route.request().postDataJSON().intent);
    // API forwarding pools sockets across the reload. Close each response so
    // the next mutation cannot reuse one as the fixture broker expires it.
    const response = await route.fetch({
      headers: { ...(await route.request().allHeaders()), connection: "close" },
    });
    expect(response.headers().connection).toBe("close");
    if (!lostResponse && response.ok()) {
      // The real broker accepts and persists the write, but its response never
      // reaches the dialog. The retry must reconcile that exact creation.
      lostResponse = true;
      awaitingReconciliation = true;
      app.report.sidebarAssignmentFailures ??= [];
      app.report.sidebarAssignmentFailures.push(route.request().url());
      await route.fulfill({
        status: 502,
        contentType: "application/json",
        body: JSON.stringify({ error: "Section confirmation unavailable" }),
      });
    } else await route.fulfill({ response });
  };
  await page.route("**/sidebar-assignment", loseCreationResponse);
  await field.press("Enter");
  await expect(dialog.getByRole("alert")).toContainText(
    "Relay request failed (502)",
  );
  expect(writerReads).toBe(1);
  await expect.poll(() => app.report.sidebarPublications?.length ?? 0).toBe(1);
  await expect(field).toBeFocused();
  await expect(field).toHaveAttribute("readonly", "");
  await expect(selected).toBeDisabled();
  await page.keyboard.type("es");
  await expect(field).toHaveValue("Launch");
  await page.keyboard.press("Tab");
  await expect(
    dialog.getByRole("button", { name: "Close", exact: true }).last(),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    dialog.getByRole("button", { name: "Retry", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  expect(creations).toHaveLength(2);
  expect(creations[1]).toEqual(creations[0]);
  await page.unroute("**/sidebar-assignment");
  await expect(trigger).toBeFocused();
  const createdId = creations[0].createSection.id;
  expect(creations[0].createSection.icon).toBe("🚌");
  const created = page.locator(`[data-sidebar-section="group:${createdId}"]`);
  await expect(created.locator("summary")).toHaveAccessibleName("Launch");
  await expect(created.locator("summary")).toContainText("🚌");
  await expect.poll(() => app.report.sidebarPublications?.length ?? 0).toBe(1);
  const { blob } = app.report.sidebarPublications[0];
  expect(blob.assignments).toEqual({ beta: "work" });
  expect(blob.sections.find(({ id }) => id === createdId)?.icon).toBe("🚌");
  expect(Object.keys(blob.assignments)).not.toContain("undefined");
  await page.reload();
  await openPage(page, "Messages");
  await expect(created.locator("summary")).toHaveAccessibleName("Launch");
  await expect(created.locator("summary")).toContainText("🚌");
  await expect(
    page.locator(
      '[data-sidebar-section="group:work"] [data-channel-id="beta"]',
    ),
  ).toBeVisible();
  // An accepted creation must also appear if the user cancels instead of
  // retrying. Reopening the form must not hide that confirmed section.
  lostResponse = false;
  failWriterRead = true;
  await page.route("**/sidebar-assignment", loseCreationResponse);
  await clickSidebarHeadingAction(trigger);
  await page
    .getByRole("menuitem", { name: "Create workspace", exact: true })
    .click();
  await field.fill("Cancel check");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Relay request failed (502)",
  );
  expect(writerReads).toBeGreaterThanOrEqual(2);
  await expect(
    dialog.getByRole("button", { name: "Retry", exact: true }),
  ).toBeDisabled();
  await expect(dialog.getByRole("alert")).not.toContainText("403");
  // Recover preferences without replaying creation, then Cancel/reopen.
  const deniedReads = writerReads;
  failWriterRead = false;
  await dialog.getByRole("button", { name: "Retry preferences" }).click();
  await expect(field).toBeFocused();
  await expect(
    dialog.getByRole("button", { name: "Retry", exact: true }),
  ).toBeEnabled();
  expect(writerReads).toBe(deniedReads + 1);
  expect(creations).toHaveLength(3);
  const accepted = page
    .locator("summary")
    .filter({ hasText: /^Cancel check$/ });
  await expect(accepted).toHaveCount(1);
  await dialog
    .getByRole("button", { name: "Close", exact: true })
    .last()
    .click();
  await expect(trigger).toBeFocused();
  await expect(accepted).toBeVisible();
  await clickSidebarHeadingAction(trigger);
  await page
    .getByRole("menuitem", { name: "Create workspace", exact: true })
    .click();
  await expect(field).toHaveValue("");
  await expect(accepted).toHaveCount(1);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(creations).toHaveLength(3);
  expect(app.report.sidebarPublications).toHaveLength(2);
  await page.unroute("**/sidebar-assignment");
  await page.reload();
  await openPage(page, "Messages");
  await expect(accepted).toHaveCount(1);
  await expect(created.locator("summary")).toHaveAccessibleName("Launch");
});

test("New options → New workspace keeps selected artwork centered at enlarged text", async ({
  page,
  app,
}, testInfo) => {
  await page.setViewportSize({ width: 480, height: 800 });
  await page.goto(app.origin);
  await page.evaluate(() => {
    localStorage.setItem("buzz-font-scale.v1", "2");
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "buzz-font-scale.v1",
        newValue: "2",
        storageArea: localStorage,
      }),
    );
  });
  await openPage(page, "Messages");
  await settleShellToggle(page);
  await page
    .getByRole("button", { name: "Show navigation", exact: true })
    .click();
  await page.getByRole("button", { name: "New options", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "New workspace", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "New workspace" });
  const field = dialog.getByRole("textbox", { name: "Name" });
  await expect(field).toBeFocused();
  await expectIconCentered(dialog);
  await dialog.getByRole("button", { name: "Choose section emoji" }).click();
  await page.getByRole("searchbox", { name: "Search emoji" }).fill("bus");
  await page.getByRole("button", { name: "🚌", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Emoji picker", exact: true }),
  ).toHaveCount(0);
  await field.fill("From New");
  await dialog.getByRole("button", { name: "Change section emoji" }).click();
  const search = page.getByRole("searchbox", { name: "Search emoji" });
  const picker = page.getByRole("dialog", {
    name: "Emoji picker",
    exact: true,
  });
  await expect(search).toBeFocused();
  await expect(
    picker.getByRole("button", { name: "Remove emoji" }),
  ).toBeVisible();
  await expect
    .poll(async () => {
      const bounds = await picker.boundingBox();
      return (
        bounds.x >= 0 &&
        bounds.y >= 0 &&
        bounds.x + bounds.width <= 480 &&
        bounds.y + bounds.height <= 800
      );
    })
    .toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("create-section-picker-narrow-enlarged.png"),
  });
  await search.press("Escape");
  await expect(
    dialog.getByRole("button", { name: "Change section emoji" }),
  ).toBeFocused();
  await expectIconCentered(dialog);
  await dialog.screenshot({
    path: testInfo.outputPath("create-section-narrow-enlarged.png"),
  });
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => app.report.sidebarPublications?.length ?? 0).toBe(1);
  const { blob } = app.report.sidebarPublications[0];
  const saved = blob.sections.find(({ name }) => name === "From New");
  expect(saved?.icon).toBe("🚌");
  const section = page.locator(`[data-sidebar-section="group:${saved.id}"]`);
  // Creating a workspace opens no chat, so the narrow drawer stays open on it.
  await expect(section.locator("summary")).toHaveAccessibleName("From New");
  await page.reload();
  await openPage(page, "Messages");
  await settleShellToggle(page);
  await page
    .getByRole("button", { name: "Show navigation", exact: true })
    .click();
  await expect(section.locator("summary")).toHaveAccessibleName("From New");
});

test("Move to… → Create new saves the selected icon and assignment atomically", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Messages");
  await page.locator(starredAlpha).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to…", exact: true }).hover();
  await page
    .getByRole("menuitem", { name: "Create new…", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Move to new workspace" });
  const field = dialog.getByRole("textbox", { name: "Name" });
  await expect(field).toBeFocused();
  await dialog.getByRole("button", { name: "Choose section emoji" }).click();
  await page.getByRole("searchbox", { name: "Search emoji" }).fill("bus");
  await page.getByRole("button", { name: "🚌", exact: true }).click();
  await field.fill("Moved");
  await dialog
    .getByRole("button", { name: "Create and move", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  // Moving a starred row also publishes its independent Star removal.
  await expect.poll(() => app.report.sidebarPublications?.length ?? 0).toBe(2);
  const { blob } = app.report.sidebarPublications.find(
    ({ coordinate }) => coordinate === "channel-workspaces",
  );
  const saved = blob.sections.find(({ name }) => name === "Moved");
  expect(saved?.icon).toBe("🚌");
  expect(blob.assignments.alpha).toBe(saved.id);
  const section = page.locator(`[data-sidebar-section="group:${saved.id}"]`);
  await expect(section.locator("summary")).toHaveAccessibleName("Moved");
  await expect(section.locator('[data-channel-id="alpha"]')).toBeVisible();
});

async function expectIconCentered(dialog) {
  const artwork = dialog.locator("[data-sidebar-group-icon]");
  if (await artwork.count()) {
    await expect(artwork).toBeVisible();
    const image = artwork.locator("img");
    if (await image.count()) {
      await expect(image).toBeVisible();
      await expect
        .poll(() =>
          image.evaluate((img) => img.complete && img.naturalWidth > 0),
        )
        .toBe(true);
    }
  }
  const metrics = await dialog
    .getByRole("button", {
      name: /^(?:Choose section emoji|Change section emoji, currently .+)$/,
    })
    .evaluate((button) => {
      const artwork = button.querySelector("[data-sidebar-group-icon], svg");
      const input = button.closest(".buzz-input-group")?.querySelector("input");
      if (!artwork || !input) throw new Error("Section emoji geometry missing");
      const control = button.getBoundingClientRect();
      const icon = artwork.getBoundingClientRect();
      // The fixed slot can be centered while its implicit grid track overflows.
      // Range measures text advance, not the painted emoji's optical bounds.
      const range = document.createRange();
      range.selectNodeContents(artwork);
      const content =
        artwork.firstChild?.nodeType === Node.TEXT_NODE
          ? range.getBoundingClientRect()
          : (
              artwork.querySelector("img, svg") ?? artwork
            ).getBoundingClientRect();
      const name = input.getBoundingClientRect();
      return {
        // The modest CSS nudge is Unicode-only, not a universal ink-centering gate.
        unicode: artwork.firstChild?.nodeType === Node.TEXT_NODE,
        nudge: new DOMMatrixReadOnly(
          getComputedStyle(artwork.parentElement).transform,
        ).m41,
        contentX: Math.abs(
          control.x + control.width / 2 - (content.x + content.width / 2),
        ),
        x: Math.abs(control.x + control.width / 2 - (icon.x + icon.width / 2)),
        y: Math.abs(
          control.y + control.height / 2 - (icon.y + icon.height / 2),
        ),
        nameY: Math.abs(
          control.y + control.height / 2 - (name.y + name.height / 2),
        ),
      };
    });
  expect(metrics.nudge).toBe(metrics.unicode ? 0.5 : 0);
  expect(metrics.contentX).toBeLessThanOrEqual(1);
  expect(metrics.x).toBeLessThanOrEqual(1);
  expect(metrics.y).toBeLessThanOrEqual(1);
  expect(metrics.nameY).toBeLessThanOrEqual(1);
}
