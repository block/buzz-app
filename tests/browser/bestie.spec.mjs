import { test, expect } from "@playwright/test";
import { createServer } from "./vite-server.mjs";
import config from "../fixtures/agent-control.vite.mjs";

// Browser-only contract: modal focus, keyboard tree disclosures, and narrow layout.
// Authority/state permutations remain in the colocated unit tests.
test("Bestie journey keeps memory disclosures usable in a narrow modal", async ({
  page,
}, info) => {
  const server = await createServer({
    ...config,
    configFile: false,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await server.listen();
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/bestie.html`,
    );
    await page.getByRole("button", { name: "Journey", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Your Bestie journey" });
    await dialog.getByRole("combobox", { name: "Bestie identity" }).click();
    await page.getByRole("option", { name: /Sample Bestie/ }).click();
    await expect(dialog.getByText(/Saved revision 3/)).toBeVisible();
    const alex = dialog.locator("summary").filter({ hasText: /^Alex$/ });
    await alex.focus();
    await alex.press("Enter");
    await expect(
      dialog.locator("p").filter({ hasText: /^Alex is my brother$/ }),
    ).toBeVisible();
    expect(
      await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath("bestie-narrow.png"),
      fullPage: true,
    });
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(
      page.getByRole("button", { name: "Journey", exact: true }),
    ).toBeFocused();
    expect(errors).toEqual([]);
  } finally {
    await server.close();
  }
});
