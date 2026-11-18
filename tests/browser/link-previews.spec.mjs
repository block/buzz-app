import { test, expect } from "./playwright-test.mjs";
import { createServer } from "./vite-server.mjs";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

test("link previews draw web cards below messages and let a plugin claim its own links", async ({
  page,
}) => {
  const server = await createServer({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    configFile: false,
    envFile: false,
    plugins: [react()],
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  try {
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/link-previews.html`,
    );
    const rows = page.locator("[data-link-previews]");
    const first = rows.nth(0);
    const launch = first.getByRole("link", {
      name: /Buzz ships link previews/,
    });
    await expect(launch).toBeVisible();
    await expect(first).toContainText("Example News · news.example.com");
    await expect(first.locator("img")).toBeVisible();
    const heights = () =>
      page.evaluate(() => window.linkPreviewFixture.heights);
    expect(await heights()).toHaveLength(1);
    await expect(first.locator("[data-tracker-card]")).toHaveText(
      "Tracker issue 42 · In progress",
    );
    await expect(
      first.getByRole("link", { name: /tracker\.example\.com/ }),
    ).toHaveCount(0);

    const second = rows.nth(1);
    await expect(
      second.getByRole("link", { name: /Docs reached through a redirect/ }),
    ).toBeVisible();
    await expect(
      second.getByRole("link", { name: /evil\.example\.com\// }),
    ).toBeVisible();
    await expect(second.getByRole("link")).toHaveCount(2);
    const asked = await page.evaluate(() => window.linkPreviewFixture.asked);
    expect(asked).not.toContain("https://quiet.example.com/");
    expect(asked).not.toContain("https://code.example.com/");
    expect(asked.some((url) => url.includes("router.local"))).toBe(false);
    expect(asked.some((url) => /github\.com|figma\.com/.test(url))).toBe(false);

    // A page can't push the real domain off its card or reverse it.
    const spoof = rows
      .nth(2)
      .getByRole("link", { name: /Sign in to continue/ });
    await expect(spoof).toBeVisible();
    const domain = spoof.locator("[dir=ltr]");
    await expect(domain).toHaveText("spoof.example.net");
    const fits = await domain.evaluate((element) => {
      const own = element.getBoundingClientRect();
      const card = element.closest("a").getBoundingClientRect();
      return (
        element.scrollWidth <= element.clientWidth &&
        own.left >= card.left &&
        own.right <= card.right
      );
    });
    expect(fits).toBe(true);
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.linkPreviewFixture.images.includes(
            "https://img.example.com/missing.png",
          ),
        ),
      )
      .toBe(true);
    await expect(spoof.locator("img")).toHaveCount(0);
    expect(await spoof.evaluate((card) => card.children.length)).toBe(1);

    const third = rows.nth(3);
    await expect(third.getByRole("link")).toHaveCount(3);
    await third.getByRole("button", { name: "Show 2 more previews" }).click();
    await expect(third.getByRole("link")).toHaveCount(5);
    await third.getByRole("button", { name: "Show fewer previews" }).click();
    await expect(third.getByRole("link")).toHaveCount(3);

    // On a narrow card, the site name and then the subdomains give way, but
    // the registered domain stays whole.
    const narrow = rows
      .nth(4)
      .getByRole("link", { name: /Getting started with the platform/ });
    await expect(narrow).toBeVisible();
    await expect(narrow.locator("img")).toBeVisible();
    const host =
      "docs.platform-engineering.developer-tools.example-company.com";
    const hostname = narrow.locator(`[title="${host}"]`);
    await expect(hostname).toHaveText(host);
    const shown = await hostname.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const site = element.parentElement.getBoundingClientRect();
      const [subdomains, registered] = element.children;
      const kept = registered.getBoundingClientRect();
      return {
        subdomains: subdomains.scrollWidth > subdomains.clientWidth,
        registered: registered.textContent,
        whole: [...registered.children].every(
          (part) => part.scrollWidth <= part.clientWidth,
        ),
        inside: kept.left >= box.left && kept.right <= box.right + 0.5,
        withinSite: box.left >= site.left && box.right <= site.right + 0.5,
      };
    });
    expect(shown).toEqual({
      subdomains: true,
      registered: "example-company.com",
      whole: true,
      inside: true,
      withinSite: true,
    });

    await launch.click();
    await expect(page.getByRole("status")).toHaveText(
      "https://news.example.com/launch",
    );

    // A page Buzz can't open itself goes to the browser.
    await page
      .context()
      .route("https://a.example.org/", (route) =>
        route.fulfill({ contentType: "text/html", body: "<p>a</p>" }),
      );
    const [popup] = await Promise.all([
      page.waitForEvent("popup"),
      third.getByRole("link", { name: /a\.example\.org/ }).click(),
    ]);
    expect(popup.url()).toBe("https://a.example.org/");
    await popup.close();

    await page.getByRole("button", { name: "Disable tracker plugin" }).click();
    await expect(
      first.getByRole("link", { name: /Page at tracker\.example\.com/ }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Disable link previews" }).click();
    await expect(page.locator("[data-link-previews]")).toHaveCount(0);
    const launchReads = () =>
      page.evaluate(
        () =>
          window.linkPreviewFixture.asked.filter(
            (url) => url === "https://news.example.com/launch",
          ).length,
      );
    expect(await launchReads()).toBe(1);
    await page.getByRole("button", { name: "Enable link previews" }).click();
    await expect(launch).toBeVisible();
    await expect(first.locator("img")).toBeVisible();
    expect(await heights()).toHaveLength(1);
    expect(await launchReads()).toBe(2);
    await page.getByRole("button", { name: "Enable tracker plugin" }).click();
    await page.getByRole("button", { name: "Toggle theme" }).click();
    await expect(first.locator("[data-tracker-card]")).toBeVisible();
    await expect(launch).toBeVisible();
  } finally {
    await server.close();
  }
});
