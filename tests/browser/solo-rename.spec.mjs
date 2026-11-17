import { test, expect } from "./fixture.mjs";
import { newChat } from "./navigation.mjs";
import { soloRow } from "./rail-helpers.mjs";

// Chats are renamed in Chat settings (solo-chats.spec.mjs); the rail has no
// inline editor. A chat a plugin's Solo source classifies stays in the rail's
// Solo card, and its lifecycle keeps the shell in Solo.
test.use({
  pluginFixtures: true,
  productionBroker: true,
  hasTouch: true,
});

// Real shell scope and page fallback after roster removal require app wiring.
test.describe("plugin-owned Solo lifecycle", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  test.use({
    channelLifecycle: true,
    soloChannels: [id],
    ownSoloChannels: [id],
  });

  test("deleting a plugin-owned chat keeps the shell in Solo", async ({
    page,
    app,
  }) => {
    await page.goto(`${app.origin}/?solo-region-fixture`);
    await newChat(page);
    const row = soloRow(page, id);
    await expect(row).toBeVisible();
    await page.evaluate((id) => window.fixtureSoloRegion.classify(id), id);
    await row.click();
    await expect(row).toHaveAttribute("aria-current", "page");
    const solo = page.getByRole("main").getByRole("region", {
      name: "Solo",
      exact: true,
    });
    await expect(solo).toBeVisible();
    await expect(
      page.getByRole("textbox", { name: "Message your agents", exact: true }),
    ).toBeEnabled();
    await row.click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "Delete chat", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Delete Lifecycle channel?",
    });
    await dialog
      .getByRole("button", { name: "Delete chat", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    await expect(row).toHaveCount(0);
    await expect(solo).toBeVisible();
    await expect(page).toHaveURL(/solo-draft/);
    expect(
      app.report.lifecyclePublications.map((event) => [event.kind, event.tags]),
    ).toEqual([[9008, [["h", id]]]]);
    expect(app.report.unexpected).toEqual([]);
  });
});
