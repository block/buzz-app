import { expect, test } from "@playwright/test";
import { preview } from "vite";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// A real mounted member dialog and shared session, but no relay or external write.
test("confirming an addition returns focus only if the Add row still owns it", async ({
  page,
}) => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const directory = await mkdtemp(join(tmpdir(), "buzz-focus-"));
  let server;
  try {
    const config = {
      root,
      configFile: false,
      envFile: false,
      logLevel: "error",
      plugins: [react()],
      build: {
        rollupOptions: {
          input: join(root, "tests/browser/channel-members-focus.html"),
        },
        outDir: join(directory, "dist"),
        emptyOutDir: true,
      },
    };
    await build(config);
    server = await preview({
      ...config,
      preview: { host: "127.0.0.1", port: 0, strictPort: true },
    });
    const url = `http://127.0.0.1:${server.httpServer.address().port}/tests/browser/channel-members-focus.html`;
    for (const moved of [false, true]) {
      await page.goto(url);
      await page.getByRole("button", { name: "Channel members" }).click();
      const dialog = page.getByRole("dialog", { name: "Channel members" });
      const search = dialog.getByRole("searchbox");
      await search.fill("Morgan");
      const add = dialog.getByRole("button", { name: /Add Morgan/ });
      await expect(add).toBeEnabled();
      await add.focus();
      await page.keyboard.press("Enter");
      await page.evaluate(() => window.focusFixture.published);
      await expect(add).toHaveAttribute("aria-disabled", "true");
      await expect(add).toBeFocused();
      if (moved)
        await dialog
          .getByRole("button", { name: "Close channel members" })
          .focus();
      await page.evaluate(() => window.focusFixture.confirm());
      await expect(dialog.getByText("Morgan is in the channel.")).toBeVisible();
      await expect(
        moved
          ? dialog.getByRole("button", { name: "Close channel members" })
          : search,
      ).toBeFocused();
    }
  } finally {
    if (server)
      await new Promise((resolve) => server.httpServer.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
