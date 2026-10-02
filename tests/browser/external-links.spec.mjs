import { openPage } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";
import { end, settle } from "./timeline.mjs";
import { apcaContrast, wcagRatio } from "../../scripts/design-system/apca.mjs";

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
    panel.getByRole("heading", { name: "A useful change #1" }),
  ).toBeVisible();
  expect(context.pages()).toHaveLength(1);
  expect(
    await popup(page, panel.getByRole("link", { name: "A useful change #1" })),
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
    panel.getByRole("heading", { name: "A useful change #1" }),
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
    await expect(
      page
        .getByRole("complementary", { name: "GitHub", exact: true })
        .getByRole("heading", {
          name: kind === "Pull request" ? "GitHub object #1" : "GitHub object",
          exact: true,
        }),
    ).toBeVisible();
    const identity = page
      .getByRole("complementary", { name: "GitHub", exact: true })
      .getByText(new RegExp(`^${kind}(?: |$)`))
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
    github,
    "https://github.com/block",
    "https://github.com/block/buzz",
    "https://github.com/sample-author",
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
    panel.getByRole("heading", { name: "A small improvement #1" }),
  ).toBeVisible();
  const title = panel.getByRole("heading", { name: "A small improvement #1" });
  const byline = panel
    .getByRole("link", { name: "sample-author", exact: true })
    .locator("../..");
  const titleBox = await title.boundingBox();
  const bylineBox = await byline.boundingBox();
  expect(titleBox).not.toBeNull();
  expect(bylineBox).not.toBeNull();
  expect(bylineBox.y - (titleBox.y + titleBox.height)).toBeCloseTo(8, 0);
  const factsBox = await panel.locator("dl").boundingBox();
  expect(factsBox).not.toBeNull();
  expect(factsBox.y - (bylineBox.y + bylineBox.height)).toBeCloseTo(24, 0);
  expect(
    await popup(
      page,
      panel.getByRole("link", { name: "sample-author", exact: true }),
    ),
  ).toBe("https://github.com/sample-author");
  for (const [name, url] of [
    ["block", "https://github.com/block"],
    ["buzz", "https://github.com/block/buzz"],
  ]) {
    const repositoryLink = panel.getByRole("link", { name, exact: true });
    await expect(repositoryLink).toHaveCSS("font-size", "16px");
    expect(await popup(page, repositoryLink)).toBe(url);
  }
  await expect(panel.getByText("Pull request", { exact: true })).toBeVisible();
  await expect(panel.getByText("Pull request #1", { exact: true })).toHaveCount(
    0,
  );
  await expect(panel.getByRole("link", { name: "Open on GitHub" })).toHaveCount(
    0,
  );
  expect(
    await popup(
      page,
      panel.getByRole("link", { name: "A small improvement #1" }),
    ),
  ).toBe(github);
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
  await panel.getByRole("heading", { name: "A small improvement #1" }).hover();
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
        subtle: "--text-subtle",
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
    await expect(
      panel.getByRole("link", { name: "sample-author", exact: true }),
    ).toHaveCSS("color", colors.link);
    await expect(
      panel.getByRole("link", { name: "A small improvement #1" }),
    ).toHaveCSS("color", colors.standard);
    await expect(panel.getByText("#1", { exact: true })).toHaveCSS(
      "color",
      colors.subtle,
    );
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
    for (const count of ["+174", "−28"]) {
      await expect(changes.getByText(count, { exact: true })).toHaveCSS(
        "font-size",
        "12px",
      );
      await expect(changes.getByText(count, { exact: true })).toHaveCSS(
        "font-weight",
        "700",
      );
    }
    await expect(changes.locator("dd")).toHaveCSS("font-size", "14px");
    await expect(changes.locator("dd")).toHaveCSS("font-weight", "400");
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

// The browser resolves plugin aliases through the real CSS cascade. Unit tests
// cover state precedence; this case covers paint, themes and shared-role updates.
// Contrast is diagnostic here, not a new threshold gate or accessibility audit.
test("GitHub owns status mappings while shared colors and accent stay independent", async ({
  page,
  app,
}, testInfo) => {
  const samples = [
    { id: 2, label: "Draft", state: "open", draft: true },
    { id: 3, label: "open", state: "open" },
    { id: 4, label: "closed", state: "closed", draft: true },
    { id: 5, label: "Merged", state: "closed", merged: true },
  ];
  await page.route(
    "https://api.github.com/repos/block/buzz/pulls/*",
    (route) => {
      const id = Number(
        new URL(route.request().url()).pathname.split("/").at(-1),
      );
      const sample = samples.find((item) => item.id === id);
      if (!sample) throw new Error(`Unknown sample PR ${id}`);
      return route.fulfill({
        json: {
          ...sample,
          title: "A small improvement",
          user: { login: "sample-author" },
          additions: 174,
          deletions: 28,
        },
      });
    },
  );
  await page.goto(app.origin);
  await openMessages(page);
  app.append(
    "primary",
    "alpha",
    samples.map(({ id }) => `${github.slice(0, -1)}${id}`).join(" "),
  );
  const panel = page.getByRole("complementary", {
    name: "GitHub",
    exact: true,
  });
  const measurements = [];
  for (const mode of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: mode });
    await expect(page.locator("html")).toHaveAttribute("data-color-mode", mode);
    for (const sample of samples) {
      await link(page, `${github.slice(0, -1)}${sample.id}`).click();
      const badge = panel.getByText(sample.label, { exact: true });
      await expect(badge).toHaveAttribute(
        "data-pr-state",
        sample.label.toLowerCase(),
      );
      const expected = await panel.evaluate((node, state) => {
        const probe = document.createElement("span");
        node.querySelector("[data-pr-state]").parentElement.append(probe);
        const resolved = (token) => {
          probe.style.color = `var(${token})`;
          return getComputedStyle(probe).color;
        };
        const result = {
          text: resolved(`--github-${state}-text`),
          fill: resolved(`--github-${state}-bg`),
        };
        probe.remove();
        return result;
      }, sample.label.toLowerCase());
      await expect(badge).toHaveCSS("color", expected.text);
      await expect(badge).toHaveCSS("background-color", expected.fill);
      await expect(badge.locator("svg")).toHaveAttribute("aria-hidden", "true");
      await expect(badge.locator("svg")).toHaveCSS("width", "12px");
      await expect(badge.locator("svg")).toHaveCSS("color", expected.text);
      const pairs = await panel.evaluate((node) => {
        const badge = node.querySelector("[data-pr-state]");
        const facts = node.querySelector("dl");
        const counts = [...facts.querySelectorAll("dd span")];
        return [
          {
            name: badge.textContent,
            text: getComputedStyle(badge).color,
            fill: getComputedStyle(badge).backgroundColor,
          },
          ...counts.map((count) => ({
            name: count.textContent,
            text: getComputedStyle(count).color,
            fill: getComputedStyle(facts).backgroundColor,
          })),
        ];
      });
      for (const pair of pairs) {
        const hex = (rgb) => {
          const channels = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(rgb);
          if (!channels)
            throw new Error(`Expected opaque resolved color: ${rgb}`);
          return `#${channels
            .slice(1)
            .map((channel) => Number(channel).toString(16).padStart(2, "0"))
            .join("")}`;
        };
        measurements.push({
          mode,
          ...pair,
          wcag: wcagRatio(hex(pair.text), hex(pair.fill)),
          apca: Math.abs(apcaContrast(hex(pair.text), hex(pair.fill))),
        });
      }
      if (sample.merged) {
        await page.evaluate(() => {
          document.documentElement.style.setProperty(
            "--text-accent",
            "var(--text-danger)",
          );
          document.documentElement.style.setProperty(
            "--affordance-accent",
            "var(--affordance-danger)",
          );
        });
        await expect(badge).toHaveCSS("color", expected.text);
        await expect(badge).toHaveCSS("background-color", expected.fill);
        await panel.screenshot({
          path: testInfo.outputPath(`github-merged-${mode}.png`),
        });
        await page.evaluate(() => {
          document.documentElement.style.removeProperty("--text-accent");
          document.documentElement.style.removeProperty("--affordance-accent");
        });
      } else if (sample.label === "open") {
        await page.evaluate(() => {
          document.documentElement.style.setProperty(
            "--text-success",
            "var(--text-link)",
          );
          document.documentElement.style.setProperty(
            "--affordance-success",
            "var(--affordance-link-hover)",
          );
          document.documentElement.style.setProperty(
            "--text-danger",
            "var(--text-link)",
          );
        });
        const changed = await panel.evaluate((node) => {
          const probe = document.createElement("span");
          node.append(probe);
          probe.style.color = "var(--text-link)";
          const text = getComputedStyle(probe).color;
          probe.style.color = "var(--affordance-link-hover)";
          const fill = getComputedStyle(probe).color;
          probe.remove();
          return { text, fill };
        });
        await expect(badge).toHaveCSS("color", changed.text);
        await expect(badge).toHaveCSS("background-color", changed.fill);
        await expect(panel.getByText("+174", { exact: true })).toHaveCSS(
          "color",
          changed.text,
        );
        await expect(panel.getByText("−28", { exact: true })).toHaveCSS(
          "color",
          changed.text,
        );
        await page.evaluate(() => {
          for (const token of [
            "--text-success",
            "--affordance-success",
            "--text-danger",
          ])
            document.documentElement.style.removeProperty(token);
        });
      } else if (sample.draft && sample.state === "open") {
        await panel.screenshot({
          path: testInfo.outputPath(`github-draft-${mode}.png`),
        });
      }
    }
  }
  await testInfo.attach("github-contrast-diagnostic", {
    body: JSON.stringify(measurements, null, 2),
    contentType: "application/json",
  });
});

// Real tooltip portals, keyboard dismissal and semantic paint require a browser;
// aggregation/error/pagination matrices remain in colocated unit tests.
test("PR check summaries expose counts and relative update time in the built pane", async ({
  page,
  app,
}, testInfo) => {
  const samples = [
    {
      id: 6,
      label: "Some not successful",
      state: "failure",
      token: "--text-danger",
      conclusions: [
        "failure",
        "failure",
        "cancelled",
        "skipped",
        ...Array(17).fill("success"),
      ],
      counts: "2 failing, 1 cancelled, 1 skipped, 17 successful checks",
    },
    {
      id: 7,
      label: "Pending",
      state: "pending",
      token: "--text-warning",
      conclusions: [null, "success"],
      counts: "1 pending, 1 successful checks",
    },
    {
      id: 8,
      label: "Successful",
      state: "success",
      token: "--text-success",
      conclusions: ["skipped", "success", "success"],
      counts: "1 skipped, 2 successful checks",
    },
  ];
  const now = new Date("2026-10-02T00:00:00Z");
  await page.clock.setFixedTime(now);
  const updatedAt = new Date(now.getTime() - 180_000).toISOString();
  await page.route("https://api.github.com/repos/block/buzz/**", (route) => {
    const url = new URL(route.request().url());
    const id = Number(
      url.pathname.match(/(?:pulls\/|commits\/head-)(\d+)/)?.[1],
    );
    const sample = samples.find((item) => item.id === id);
    if (!sample) throw new Error(`Unknown fixture ${url}`);
    if (url.pathname.includes("/pulls/"))
      return route.fulfill({
        json: {
          title: "A small improvement",
          state: "open",
          updated_at: updatedAt,
          head: { sha: `head-${id}` },
          additions: 174,
          deletions: 28,
          changed_files: 6,
        },
      });
    if (url.pathname.endsWith("/status"))
      return route.fulfill({
        json: { state: "pending", total_count: 0, statuses: [] },
      });
    return route.fulfill({
      json: {
        total_count: sample.conclusions.length,
        check_runs: sample.conclusions.map((conclusion) => ({
          status: conclusion === null ? "in_progress" : "completed",
          conclusion,
        })),
      },
    });
  });
  await page.goto(app.origin);
  await openMessages(page);
  app.append(
    "primary",
    "alpha",
    samples
      .map(({ id }) => `https://github.com/block/buzz/pull/${id}`)
      .join(" "),
  );
  const panel = page.getByRole("complementary", {
    name: "GitHub",
    exact: true,
  });
  for (const sample of samples) {
    await link(page, `https://github.com/block/buzz/pull/${sample.id}`).click();
    const summary = panel.getByText(sample.label, { exact: true });
    await expect(summary).toBeVisible();
    await expect(summary).toHaveAttribute("data-check-state", sample.state);
    await expect(summary.locator("svg")).toHaveAttribute("aria-hidden", "true");
    await expect(panel.locator("time")).toHaveText("3 minutes ago");
    await expect(panel.locator("time")).toHaveAttribute("datetime", updatedAt);
    for (const mode of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme: mode });
      await expect(page.locator("html")).toHaveAttribute(
        "data-color-mode",
        mode,
      );
      const color = await panel.evaluate((node, token) => {
        const probe = document.createElement("span");
        node.append(probe);
        probe.style.color = `var(${token})`;
        const result = getComputedStyle(probe).color;
        probe.remove();
        return result;
      }, sample.token);
      await expect(summary).toHaveCSS("color", color);
      await summary.hover();
      const tooltip = page.getByRole("tooltip");
      await expect(tooltip).toContainText(sample.counts);
      await expect(tooltip).toContainText("PR head commit");
      await expect(summary).toHaveAttribute(
        "aria-describedby",
        await tooltip.getAttribute("id"),
      );
      await expect(tooltip).not.toHaveAttribute("data-starting-style");
      await page.screenshot({
        path: testInfo.outputPath(`github-checks-${sample.state}-${mode}.png`),
      });
      // Pointer exit dismisses a hover hint. Escape is exercised below with
      // focus on its trigger; outside focus retains the host's close-pane action.
      await panel.getByRole("heading").hover();
      await expect(tooltip).toHaveCount(0);
    }
    await panel
      .getByRole("link", { name: `A small improvement #${sample.id}` })
      .focus();
    await page.keyboard.press("Tab");
    await expect(summary).toBeFocused();
    await expect(page.getByRole("tooltip")).toContainText(sample.counts);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    await expect(panel).toBeVisible();
  }
  await page.setViewportSize({ width: 900, height: 950 });
  await page
    .locator("html")
    .evaluate((node) => node.style.setProperty("--buzz-text-scale", "2"));
  await expect(panel.getByText("Successful", { exact: true })).toBeVisible();
  const facts = panel.locator("dl");
  await expect
    .poll(() => facts.evaluate((node) => node.scrollWidth <= node.clientWidth))
    .toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("github-checks-enlarged.png"),
  });
});
