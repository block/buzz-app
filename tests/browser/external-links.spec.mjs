import { openPage } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";
import { end, settle } from "./timeline.mjs";

test.use({ historyCounts: { alpha: 1, beta: 0 } });
const github = "https://github.com/block/buzz/pull/1";
const ordinary = "https://example.test/external-link";
const unsupported = "https://github.com/block/buzz/blob/main/README.md";
const button = (page, name) => page.getByRole("button", { name, exact: true });
// Presentation plugins may shorten a raw URL label; the destination remains the contract.
const link = (page, url) => page.locator(`a[href=${JSON.stringify(url)}]`);

async function openMessages(page) {
  await openPage(page, "Messages");
  await page
    .getByRole("textbox", { name: "Message #Alpha", exact: true })
    .waitFor();
  await settle(page);
}

async function popup(page, anchor) {
  const opened = page.waitForEvent("popup");
  await anchor.click();
  const external = await opened;
  await external.waitForLoadState();
  expect(await external.evaluate(() => window.opener === null)).toBe(true);
  const url = external.url();
  await external.close();
  return url;
}

// Runs the built app and real plugin lifecycle. This verifies normal web fallback
// and plugin precedence; native registration/permissions have a separate guard.
test("unhandled links open externally and disabling GitHub restores the fallback", async ({
  page,
  context,
  app,
}) => {
  for (const url of [github, ordinary, unsupported])
    await context.route(url, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>External destination</title>",
      }),
    );
  await page.route("https://api.github.com/repos/block/buzz/pulls/1", (route) =>
    route.fulfill({ json: { title: "A useful change", state: "open" } }),
  );
  await page.goto(app.origin);
  await openMessages(page);
  app.append("primary", "alpha", `${github} ${ordinary} ${unsupported}`);
  await expect(link(page, github)).toBeAttached();
  await end(page);
  await link(page, github).click();
  const panel = page.getByRole("complementary", {
    name: "GitHub",
    exact: true,
  });
  await expect(
    panel.getByRole("heading", { name: "A useful change" }),
  ).toBeVisible();
  expect(context.pages()).toHaveLength(1);
  expect(
    await popup(page, panel.getByRole("link", { name: "Open on GitHub" })),
  ).toBe(github);
  expect(await popup(page, link(page, ordinary))).toBe(ordinary);
  expect(await popup(page, link(page, unsupported))).toBe(unsupported);
  await expect(panel).toBeVisible();

  await button(page, "Your profile").click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await button(page, "Plugins").click();
  await page.getByRole("switch", { name: "Enable GitHub" }).click();
  await openMessages(page);
  await expect(panel).toHaveCount(0);
  expect(await popup(page, link(page, github))).toBe(github);
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();

  await button(page, "Your profile").click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await button(page, "Plugins").click();
  await page.getByRole("switch", { name: "Enable GitHub" }).click();
  await openMessages(page);
  await link(page, github).focus();
  await page.keyboard.press("Enter");
  await expect(
    panel.getByRole("heading", { name: "A useful change" }),
  ).toBeVisible();
  expect(context.pages()).toHaveLength(1);
});

test("GitHub object identities have comparable visible artwork at one size", async ({
  page,
  app,
}, testInfo) => {
  const targets = [
    ["Repository", "https://github.com/block/buzz"],
    ["Pull request", "https://github.com/block/buzz/pull/1"],
    ["Issue", "https://github.com/block/buzz/issues/2"],
    ["Commit", "https://github.com/block/buzz/commit/abcdef1"],
  ];
  await page.route("https://api.github.com/repos/block/buzz**", (route) =>
    route.fulfill({ json: { title: "GitHub object", state: "open" } }),
  );
  await page.goto(app.origin);
  await openMessages(page);
  app.append("primary", "alpha", targets.map(([, target]) => target).join(" "));

  const dimensions = [];
  const icons = [];
  for (const [kind, target] of targets) {
    await expect(link(page, target)).toBeVisible();
    await link(page, target).click();
    const identity = page
      .getByRole("complementary", { name: "GitHub", exact: true })
      .getByText(new RegExp(`^${kind} `))
      .locator("xpath=../..");
    const svg = identity.locator("svg");
    await expect(svg).toHaveCSS("width", "22px");
    await expect(svg).toHaveCSS("height", "22px");
    icons.push(await svg.evaluate((node) => node.outerHTML));
    dimensions.push(
      await svg.evaluate((node) => {
        const { width, height } = node.getBBox();
        return { width, height };
      }),
    );
  }

  for (const { width, height } of dimensions) {
    expect(width).toBeGreaterThanOrEqual(184);
    expect(height).toBeGreaterThanOrEqual(111);
  }
  expect(dimensions[2].width).toBeCloseTo(208, 3);
  expect(dimensions[2].height).toBeCloseTo(208, 3);
  await page.setContent(`
    <main style="display:flex;gap:16px;align-items:center;color:#111">
      ${icons.map((icon, index) => `<figure style="margin:0;display:grid;justify-items:center;gap:8px">${icon}<figcaption>${targets[index][0]}</figcaption></figure>`).join("")}
    </main>
  `);
  await page.locator("main").screenshot({
    path: testInfo.outputPath("github-object-identities.png"),
  });
});

// Computed paint through the actual app's CSS cascade and theme switch needs a browser.
test("PR state, changes and branch links use shared roles in both themes", async ({
  page,
  context,
  app,
}, testInfo) => {
  for (const url of [
    "https://github.com/block/buzz/tree/main",
    "https://github.com/block/buzz/tree/small-improvement",
  ]) {
    await context.route(url, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>Sample branch</title>",
      }),
    );
  }
  await page.route("https://api.github.com/repos/block/buzz/pulls/1", (route) =>
    route.fulfill({
      json: {
        title: "A small improvement",
        state: "open",
        user: { login: "sample-author" },
        head: {
          label: "block:small-improvement",
          ref: "small-improvement",
          repo: { full_name: "block/buzz" },
        },
        base: {
          label: "block:main",
          ref: "main",
          repo: { full_name: "block/buzz" },
        },
        changed_files: 6,
        additions: 174,
        deletions: 28,
        comments: 0,
      },
    }),
  );
  await page.goto(app.origin);
  await openMessages(page);
  app.append("primary", "alpha", github);
  await expect(link(page, github)).toBeVisible();
  await link(page, github).click();
  const panel = page.getByRole("complementary", {
    name: "GitHub",
    exact: true,
  });
  await expect(
    panel.getByRole("heading", { name: "A small improvement" }),
  ).toBeVisible();
  const changes = panel.getByText("Changes", { exact: true }).locator("..");
  expect(
    await popup(page, panel.getByRole("link", { name: "main", exact: true })),
  ).toBe("https://github.com/block/buzz/tree/main");
  expect(
    await popup(
      page,
      panel.getByRole("link", {
        name: "small-improvement",
        exact: true,
      }),
    ),
  ).toBe("https://github.com/block/buzz/tree/small-improvement");
  // Popup clicks leave the pointer on the branch. Assert rest paint off-target.
  await panel.getByRole("heading", { name: "A small improvement" }).hover();
  for (const mode of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: mode });
    await expect(page.locator("html")).toHaveAttribute("data-color-mode", mode);
    const colors = await panel.evaluate((node) => {
      const probe = document.createElement("span");
      node.append(probe);
      const result = {};
      for (const [name, token] of Object.entries({
        success: "--text-success",
        danger: "--text-danger",
        standard: "--text-standard",
        fill: "--affordance-success",
        link: "--text-link",
        linkFill: "--affordance-link-hover",
      })) {
        probe.style.color = `var(${token})`;
        result[name] = getComputedStyle(probe).color;
      }
      probe.remove();
      return result;
    });
    expect(colors.success).not.toBe(colors.standard);
    expect(colors.danger).not.toBe(colors.standard);
    await expect(panel.getByText("open", { exact: true })).toHaveCSS(
      "color",
      colors.success,
    );
    await expect(panel.getByText("open", { exact: true })).toHaveCSS(
      "background-color",
      colors.fill,
    );
    await expect(changes.getByText("+174", { exact: true })).toHaveCSS(
      "color",
      colors.success,
    );
    await expect(changes.getByText("−28", { exact: true })).toHaveCSS(
      "color",
      colors.danger,
    );
    await expect(changes.locator("dd")).toHaveCSS("color", colors.standard);
    await expect(changes.locator("dd")).toHaveText("+174 / −28");
    for (const name of ["small-improvement", "main"]) {
      const branch = panel.getByRole("link", { name, exact: true });
      await expect(branch).toHaveCSS("color", colors.link);
      await expect(branch).toHaveCSS("background-color", colors.linkFill);
      await expect(branch).toHaveCSS("font-size", "12px");
      await expect(branch).toHaveCSS("border-radius", "6px");
      await expect(branch).toHaveCSS("text-decoration-line", "none");
      expect(
        await branch.evaluate((node) => getComputedStyle(node).fontFamily),
      ).toContain("JetBrains Mono");
    }
    await panel.screenshot({
      path: testInfo.outputPath(`github-pr-${mode}.png`),
    });
  }
});
