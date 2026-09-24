import { finalizeEvent, getPublicKey } from "nostr-tools";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({ historyCounts: { alpha: 1, beta: 1 } });

// Browser-only: rendered message links enter the actual plugin, focus the
// destination, preserve history, and keep its tab/file controls usable when narrow.
// Protocol matrices and real authenticated Git RPC live in colocated tests.
test("entity links open real project content, history and responsive controls", async ({
  page,
  app,
}) => {
  const key = new Uint8Array(32).fill(17);
  const owner = getPublicKey(key);
  const repo = finalizeEvent(
    {
      kind: 30617,
      created_at: 1,
      content: "A repository for the browser journey",
      tags: [
        ["d", "reader"],
        ["name", "Reader"],
        ["buzz-related-channel", "alpha"],
      ],
    },
    key,
  );
  const project = finalizeEvent(
    {
      kind: 30621,
      created_at: 1,
      content: "The Reader project",
      tags: [
        ["d", "reader-project"],
        ["name", "Reader project"],
        ["a", `30617:${owner}:reader`],
      ],
    },
    key,
  );
  const head = "a".repeat(40);
  const git = {
    head,
    commits: [
      {
        hash: head,
        author: "Fixture contributor",
        date: 2,
        subject: "Handle selected destinations",
      },
    ],
    files: [{ path: "src/reader.ts", hash: "b".repeat(40), size: 20 }],
    readme: "# Reader documentation\n\nRead the selected destination.",
    file: null,
    diff: null,
  };
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text) => {
          window.entityClipboard = text;
        },
      },
    });
  });
  await page.route("**/api/relay/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/session")) {
      const response = await route.fetch();
      return route.fulfill({
        response,
        json: { ...(await response.json()), projectGit: true },
      });
    }
    if (url.pathname.endsWith("/project-git")) {
      const input = route.request().postDataJSON();
      return route.fulfill({
        json: {
          ...git,
          ...(input.path
            ? {
                file: {
                  path: input.path,
                  content: "export const reader = true;",
                  size: 27,
                },
              }
            : {}),
          ...(input.commit
            ? {
                diff: "diff --git a/src/reader.ts b/src/reader.ts\n+export const reader = true;",
              }
            : {}),
        },
      });
    }
    if (url.pathname.endsWith("/query")) {
      const filters = route.request().postDataJSON();
      if (
        filters.some(
          (filter) =>
            filter.kinds?.some((kind) => [30617, 30621].includes(kind)) ||
            filter["#a"]?.some((address) => address.includes(owner)) ||
            filter["#e"]?.includes(repo.id) ||
            filter["#e"]?.includes(project.id),
        )
      ) {
        return route.fulfill({
          json: [repo, project].filter((event) =>
            filters.some(
              (filter) =>
                (!filter.kinds || filter.kinds.includes(event.kind)) &&
                (!filter.authors || filter.authors.includes(event.pubkey)) &&
                (!filter["#d"] ||
                  filter["#d"].includes(
                    event.tags.find((tag) => tag[0] === "d")[1],
                  )),
            ),
          ),
        });
      }
    }
    return route.fallback();
  });
  await open(page, app);
  const href = `buzz://project?owner=${owner}&d=reader-project`;
  app.append("primary", "alpha", `[Reader project](${href})`);
  await page.locator(`[data-channel-timeline] a[href="${href}"]`).click();
  await expect(
    page.getByRole("heading", { name: "Reader project", exact: true }),
  ).toBeFocused();
  await page.getByRole("button", { name: "Reader", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Reader documentation" }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Files", exact: true }).click();
  await page
    .getByRole("button", { name: "src/reader.ts", exact: true })
    .click();
  await expect(
    page.getByText("export const reader = true;", { exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Commits", exact: true }).click();
  await page
    .getByRole("button", { name: "Handle selected destinations" })
    .click();
  await expect(
    page.getByRole("region", { name: "Commit changes" }),
  ).toContainText("+export const reader = true;");
  await page.getByRole("button", { name: "Copy link", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.entityClipboard))
    .toBe(`buzz://repo?owner=${owner}&d=reader&tab=commits&commit=${head}`);
  await page.getByRole("button", { name: "Go back", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Handle selected destinations" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Reader", exact: true }),
  ).toBeFocused();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.getByRole("tab", { name: "Files", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "src/reader.ts" }),
    ).toBeVisible();
    expect(
      await page
        .locator(".projects-page")
        .evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    await page.screenshot({
      path: test.info().outputPath(`entity-${width}.png`),
    });
  }
});
