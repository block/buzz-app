import { test, expect } from "@playwright/test";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("statuses edit, synchronize, clear, reject stale traffic and retain failed drafts", async ({
  page,
}) => {
  const cacheDir = await mkdtemp(join(tmpdir(), "buzz-status-vite-"));
  const server = await createServer({
    cacheDir,
    root: fileURLToPath(new URL("../../", import.meta.url)),
    configFile: false,
    envFile: false,
    plugins: [react()],
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  try {
    await page.route("https://emoji.test/**", (route) =>
      route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><circle cx="10" cy="10" r="9" fill="purple"/></svg>',
      }),
    );
    await server.listen();
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/user-status.html`,
    );
    const navigation = page.getByRole("region", {
      name: "Navigation",
      exact: true,
    });
    const chat = page.getByRole("region", { name: "Chat", exact: true });
    const second = page.getByRole("region", {
      name: "Second device",
      exact: true,
    });
    const open = async () => {
      await page
        .getByRole("button", { name: "Your profile", exact: true })
        .click();
      await page
        .getByRole("menu", { name: "Alice" })
        .getByRole("menuitem", { name: "Set a status", exact: true })
        .click();
      await expect(
        page.getByRole("dialog", { name: "Set a status" }),
      ).toBeVisible();
    };
    const editor = page.getByRole("dialog", { name: "Set a status" });
    await open();
    await expect(
      editor.getByRole("button", { name: "Save status", exact: true }),
    ).toBeDisabled();
    await expect(
      editor.getByRole("button", { name: "Duration: Today", exact: true }),
    ).toBeVisible();
    await editor.getByLabel("Status message").fill("Design meeting");
    await expect(editor.getByLabel("Status message")).toHaveValue(
      "Design meeting",
    );
    await editor
      .getByRole("button", { name: "Save status", exact: true })
      .click();
    await expect(editor).toBeVisible();
    await expect(
      editor.getByRole("button", { name: "Save status" }),
    ).toBeDisabled();
    await expect(editor).toBeHidden();
    await expect(
      page.getByRole("button", { name: "Your profile", exact: true }),
    ).toBeFocused();
    await expect(chat.locator('[aria-label="Design meeting"]')).toHaveText(
      "💬",
    );
    await expect(chat.getByText("Design meeting", { exact: true })).toHaveCount(
      0,
    );
    await expect(
      second.getByText("Design meeting", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Reject next save" }).click();
    await open();
    await expect(editor.getByLabel("Status message")).toHaveValue(
      "Design meeting",
    );
    await expect(
      editor.getByRole("button", { name: /^Duration:/ }),
    ).not.toHaveText("1 day");
    await editor.getByLabel("Status message").fill("Draft retained");
    await editor
      .getByRole("button", { name: "Save status", exact: true })
      .click();
    await expect(editor.getByRole("alert")).toContainText(
      "Fixture save rejected",
    );
    await expect(editor.getByLabel("Status message")).toHaveValue(
      "Draft retained",
    );
    await editor.getByRole("button", { name: "Choose a status emoji" }).click();
    await page.getByRole("searchbox", { name: "Search emoji" }).fill("bus");
    await page.getByRole("button", { name: "🚌", exact: true }).click();
    await editor.getByLabel("Status message").fill("");
    await editor
      .getByRole("button", { name: "Save status", exact: true })
      .click();
    await expect(editor).toBeHidden();
    await expect(second.getByText("🚌", { exact: true })).toBeVisible();
    await open();
    await editor.getByRole("button", { name: "Choose a status emoji" }).click();
    await page.getByRole("searchbox", { name: "Search emoji" }).fill("party");
    const custom = page.getByRole("button", { name: ":party:", exact: true });
    await expect(custom).toBeVisible();
    await custom.click();
    await editor
      .getByRole("button", { name: "Save status", exact: true })
      .click();
    await expect(editor).toBeHidden();
    await expect(
      second.getByRole("img", { name: ":party:", exact: true }),
    ).toBeVisible();
    await expect(
      page
        .getByRole("region", { name: "Profile", exact: true })
        .getByRole("img", { name: ":party:", exact: true }),
    ).toBeVisible();
    await expect(
      chat.getByRole("img", { name: ":party:", exact: true }),
    ).toBeVisible();
    await open();
    await editor.getByRole("button", { name: "Clear status" }).click();
    await expect(editor).toBeHidden();
    await expect(second.getByRole("img")).toHaveCount(0);
    await expect(
      chat.getByRole("img", { name: ":party:", exact: true }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Update Bob", exact: true }).click();
    await expect(
      navigation.locator('[aria-label="🏠 Working remotely"]'),
    ).toBeVisible();
    const dmName = navigation.locator(
      '[data-channel-id="status-dm"] .navigation-item-label',
    );
    await expect(dmName).toContainText("Bob");
    await expect(
      dmName.locator('[aria-label="🏠 Working remotely"]'),
    ).toBeVisible();
    await dmName.locator('[aria-label="🏠 Working remotely"]').hover();
    await expect(page.getByRole("tooltip")).toContainText("Working remotely");
    const bobByline = chat
      .locator('[data-message-id="Bob"] strong')
      .locator("..");
    await expect(
      bobByline.locator('[aria-label="🏠 Working remotely"]'),
    ).toBeVisible();
    await bobByline.locator("[data-compact]").hover();
    await expect(page.getByRole("tooltip")).toContainText("Working remotely");
    await page.getByRole("button", { name: "Replay older Bob" }).click();
    await expect(
      page
        .getByRole("region", { name: "Profile", exact: true })
        .getByText("Working remotely", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Stale", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Custom Bob", exact: true }).click();
    await expect(
      dmName.getByRole("img", { name: ":party: Celebrating", exact: true }),
    ).toBeVisible();
    await expect(
      bobByline.getByRole("img", { name: ":party: Celebrating", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Text-only Bob", exact: true })
      .click();
    await expect(dmName.locator('[aria-label="Buzzy"]')).toHaveText("💬");
    await dmName.locator('[aria-label="Buzzy"]').hover();
    await expect(page.getByRole("tooltip")).toContainText("Buzzy");
    await expect(bobByline.locator('[aria-label="Buzzy"]')).toHaveText("💬");
    await expect(navigation.getByText("Buzzy", { exact: true })).toHaveCount(0);
    await expect(
      page
        .getByRole("region", { name: "Profile", exact: true })
        .getByText("Buzzy", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Clear Bob", exact: true }).click();
    await page.getByRole("button", { name: "Replay older Bob" }).click();
    await expect(dmName.locator("[data-compact]")).toHaveCount(0);
    await expect(bobByline.locator("[data-compact]")).toHaveCount(0);
    await expect(page.getByText("Stale", { exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await server.close();
    await rm(cacheDir, { recursive: true, force: true });
  }
});
