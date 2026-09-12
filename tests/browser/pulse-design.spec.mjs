import { generateSecretKey, finalizeEvent, getPublicKey } from "nostr-tools";
import { test, expect } from "./fixture.mjs";

test.use({ dmLabels: true });
test("Pulse fixture composition, bubble geometry, theme and feed return", async ({
  page,
  app,
}, info) => {
  const key = generateSecretKey();
  const alice = getPublicKey(key);
  const sign = (kind, tags, content, time = 1700001000) =>
    finalizeEvent({ kind, tags, content, created_at: time }, key);
  const profile = sign(0, [], JSON.stringify({ name: "Alice Fixture" }));
  const roots = [
    sign(
      9,
      [["h", "alpha"]],
      "What if catching up felt more like reading a conversation?\n\nTrying a single feed for channels, DMs, and the agents working alongside us. Everything stays in its original place.",
    ),
    sign(
      9,
      [["h", "beta"]],
      "Finished reviewing the relay changes. All checks passed, and the branch is ready for a human review.\n\nThe only follow-up: decide whether we want the new timeout as the default.",
      1700000990,
    ),
    sign(
      9,
      [["h", "dm-peer"]],
      "Got a few minutes to look at the Pulse prototype together? I have some thoughts on the private conversation cards.",
      1700001010,
    ),
  ];
  for (const root of roots)
    app.histories.get(`primary/${root.tags[0][1]}`).push(root);
  await page.route("**/api/relay/primary/query", async (route) => {
    const [filter] = route.request().postDataJSON();
    if (filter.kinds?.includes(9) && filter["#h"]?.length > 1) {
      app.report.queries.push({ community: "primary", filter });
      return route.fulfill({ json: roots });
    }
    if (filter.kinds?.includes(0) && filter.authors?.includes(alice)) {
      const response = await route.fetch();
      return route.fulfill({ json: [...(await response.json()), profile] });
    }
    return route.continue();
  });
  await page.goto(app.origin);
  const pulse = page
    .getByRole("navigation", { name: "Pages", exact: true })
    .getByRole("button", { name: "Pulse", exact: true });
  await pulse.click();
  await expect(page.getByRole("article")).toHaveCount(3);
  await expect(page.getByRole("article").first()).toContainText(
    "Alice Fixture",
  );
  const main = page.getByRole("region", { name: "Pulse", exact: true });
  const bubble = main.locator('[data-direction="incoming"]').first();
  const anchor = bubble.locator('[class*="bubbleAnchor"]');
  const body = anchor.locator(":scope > :first-child");
  const avatar = anchor.locator(":scope > :last-child");
  const bodyBounds = await body.boundingBox();
  const avatarBounds = await avatar.boundingBox();
  expect(
    Math.abs(
      bodyBounds.y + bodyBounds.height - avatarBounds.y - avatarBounds.height,
    ),
  ).toBeLessThan(2);
  await page.mouse.move(0, 0);
  await page.screenshot({ path: info.outputPath("result-light.png") });
  await page
    .getByRole("article")
    .first()
    .getByRole("button", { name: "Open conversation ↗" })
    .click();
  await expect(
    page.getByRole("region", { name: "Channel message history" }),
  ).toBeVisible();
  const draft = page.getByRole("textbox", { name: /Message #/ });
  await draft.fill("A local fixture draft — not sent");
  await page.mouse.move(0, 0);
  await page.screenshot({ path: info.outputPath("result-conversation.png") });
  await page.getByRole("button", { name: "Back to Pulse" }).click();
  await expect(
    page
      .getByRole("article")
      .first()
      .getByRole("button", { name: "Open conversation ↗" }),
  ).toBeFocused();
  // Navigation/filter changes use the same aggregate owner, not new feed requests.
  const aggregateCount = () =>
    app.report.queries.filter(
      ({ filter }) => filter.kinds?.includes(9) && filter["#h"]?.length > 1,
    ).length;
  const count = aggregateCount();
  const streams = app.report.streamConnections.length;
  await page
    .getByRole("navigation", { name: "Pulse views" })
    .getByRole("button", { name: "For you", exact: true })
    .click();
  await expect(page.getByRole("article")).toHaveCount(1);
  await page
    .getByRole("navigation", { name: "Pulse views" })
    .getByRole("button", { name: "All messages", exact: true })
    .click();
  expect(aggregateCount()).toBe(count);
  expect(app.report.streamConnections).toHaveLength(streams);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: info.outputPath("result-mobile-light.png") });
  await page.getByRole("button", { name: "Your profile" }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await page.getByRole("radio", { name: "Dark", exact: true }).check();
  await pulse.click();
  await page.mouse.move(0, 0);
  await page.screenshot({ path: info.outputPath("result-mobile-dark.png") });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 1440, height: 950 });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: info.outputPath("result-dark.png") });
  // Main's shared Markdown and attachment rendering must survive bubble styling.
  app.append(
    "primary",
    "alpha",
    "## Fixture heading\n\nA **bold** reply with [a safe link](https://example.com), `inline code` and:\n\n```js\nconst fixture = true;\n```",
    true,
    true,
  );
  const outgoing = main.locator('[data-direction="outgoing"]').first();
  await expect(
    outgoing.getByRole("heading", { name: "Fixture heading" }),
  ).toBeVisible();
  await expect(
    outgoing.getByRole("link", { name: "a safe link" }),
  ).toHaveAttribute("href", "https://example.com/");
  await page.screenshot({ path: info.outputPath("result-markdown-dark.png") });
});
