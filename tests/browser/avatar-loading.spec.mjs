import { expect, test } from "@playwright/test";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

test("shared avatars defer offscreen artwork, omit the referrer and recover from failure", async ({
  page,
}) => {
  const server = await createServer({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    configFile: false,
    envFile: false,
    plugins: [react()],
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await server.listen();
  try {
    const requests = [];
    await page.route("https://images.example/avatar.png", async (route) => {
      requests.push(route.request().headers());
      await route.fulfill({
        path: fileURLToPath(
          new URL(
            "../fixtures/design-system/assets/avatar.png",
            import.meta.url,
          ),
        ),
        contentType: "image/png",
      });
    });
    const port = server.httpServer.address().port;
    await page.goto(
      `http://127.0.0.1:${port}/tests/fixtures/agents.html?external-avatar&offscreen-avatar`,
    );
    await expect(
      page.getByRole("region", { name: "Agents", exact: true }),
    ).not.toBeInViewport();
    await page.waitForTimeout(300);
    expect(requests).toHaveLength(0);
    await page.evaluate(() =>
      window.scrollTo(0, document.documentElement.scrollHeight),
    );
    await expect(
      page.getByRole("region", { name: "Agents", exact: true }),
    ).toBeInViewport();
    await expect.poll(() => requests.length).toBe(1);
    expect(requests[0].referer).toBeUndefined();

    await page.route("https://images.example/avatar.png", (route) =>
      route.abort(),
    );
    await page.reload();
    await page.evaluate(() =>
      window.scrollTo(0, document.documentElement.scrollHeight),
    );
    const avatar = page
      .getByRole("article")
      .filter({
        has: page.getByRole("button", { name: "A Brain: 2 identities" }),
      })
      .getByRole("img", { name: "A Brain", exact: true });
    await expect(avatar).toContainText("A");
    await expect(avatar.locator("img")).toHaveCount(0);
  } finally {
    await server.close();
  }
});
