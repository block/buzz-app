import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";
import { hoverMessage } from "./message-actions.mjs";

// Real app wiring, menu portals/focus and browser history cannot be established
// by protocol tests. The shared fixture supplies only a local signed relay.
test.use({
  productionBroker: true,
  dmLabels: true,
  dmMembers: { "dm-convert": [0] },
  historyCounts: { alpha: 1, beta: 1 },
});

test("DM conversion dialog follows history and remains usable in both themes and narrow layouts", async ({
  page,
  app,
}) => {
  const selected = app.sign({
    kind: 9,
    created_at: Math.floor(Date.now() / 1000) - 10,
    content: "Range starts here",
    tags: [["h", "dm-convert"]],
  });
  app.histories.set("primary/dm-convert", [selected]);
  await open(page, app);
  await page.locator('[data-channel-id="dm-convert"]').first().click();
  await page
    .getByRole("button", { name: "Channel actions", exact: true })
    .click();
  const convert = page.getByRole("menuitem", {
    name: "Convert to thread",
    exact: true,
  });
  await expect(convert).toBeVisible();
  await convert.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", {
    name: "Convert to thread",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText("Whole conversation", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("combobox", { name: "Messages", exact: true }),
  ).toHaveCount(0);
  await expect(
    dialog.getByText(
      "To start later, open a message’s menu and choose Convert to thread from here.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Request approval" }),
  ).toBeDisabled();
  const request = dialog.getByRole("button", { name: "Request approval" });
  await request.hover();
  await expect(page.getByRole("tooltip")).toHaveText(
    "Choose a destination channel first.",
  );
  await page.mouse.move(0, 0);
  await request.focus();
  await expect(page.getByRole("tooltip")).toHaveText(
    "Choose a destination channel first.",
  );
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("combobox", { name: "Channel", exact: true }).focus();
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await expect(
    dialog.getByRole("spinbutton", { name: "Approval window (hours)" }),
  ).toHaveValue("24");
  await dialog
    .getByRole("spinbutton", { name: "Approval window (hours)" })
    .fill("12");
  await page.goBack();
  await expect(dialog).toHaveCount(0);
  await page.goForward();
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("spinbutton", { name: "Approval window (hours)" }),
  ).toHaveValue("12");
  for (const theme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: theme });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 850 });
      await expect(dialog).toBeVisible();
      const bounds = await dialog.boundingBox();
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      await page.screenshot({
        path: test.info().outputPath(`conversion-${theme}-${width}.png`),
      });
    }
  }
  await page.evaluate(() => {
    document.body.style.zoom = "1.25";
  });
  await expect(
    dialog.getByRole("spinbutton", { name: "Approval window (hours)" }),
  ).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("conversion-enlarged.png"),
  });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.goBack();
  await page.goForward();
  await expect(dialog).toHaveCount(0);
  await page.evaluate(() => {
    document.body.style.zoom = "";
  });
  await page.setViewportSize({ width: 1280, height: 850 });
  await page.getByText("Range starts here", { exact: true }).hover();
  await page
    .getByRole("button", { name: "More message actions", exact: true })
    .click();
  const fromHere = page.getByRole("menuitem", {
    name: "Convert to thread from here",
    exact: true,
  });
  await expect(fromHere.locator("svg")).toHaveCount(1);
  await fromHere.click();
  await expect(
    dialog.getByText("From this message onward", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("combobox", { name: "Messages", exact: true }),
  ).toHaveCount(0);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

// The real card must resolve its exact-message preview through the session and
// navigate back to that message; DOM component tests do not prove that wiring
// or the preview's geometry inside a narrow conversation bubble.
test("partial conversion requests show their starting message and jump to it", async ({
  page,
  app,
}) => {
  const now = Math.floor(Date.now() / 1000);
  const selected = app.sign({
    kind: 9,
    created_at: now - 20,
    content: "A different starting message for this conversion.",
    tags: [["h", "dm-convert"]],
  });
  const move = "00000000-0000-4000-8000-000000000001";
  const request = app.sign({
    kind: 9,
    created_at: now - 10,
    tags: [
      ["h", "dm-convert"],
      ["t", "buzz:dm-move:v1"],
      ["d", move],
    ],
    content: JSON.stringify({
      type: "request",
      move,
      worker: "00000000-0000-4000-8000-000000000002",
      target: "alpha",
      expires: now + 3600,
      authors: [
        [selected.pubkey, selected.pubkey],
        [app.participants[0], app.participants[0]],
      ],
      from: { id: selected.id, ms: selected.created_at * 1000 },
    }),
  });
  const cancelledMove = "00000000-0000-4000-8000-000000000003";
  const cancelledRequest = app.sign({
    kind: 9,
    created_at: now - 15,
    tags: [
      ["h", "dm-convert"],
      ["t", "buzz:dm-move:v1"],
      ["d", cancelledMove],
    ],
    content: JSON.stringify({
      ...JSON.parse(request.content),
      move: cancelledMove,
    }),
  });
  const cancellation = app.sign({
    kind: 9,
    created_at: now - 14,
    tags: [
      ["h", "dm-convert"],
      ["t", "buzz:dm-move:v1"],
      ["d", cancelledMove],
    ],
    content: JSON.stringify({
      type: "cancel",
      move: cancelledMove,
      request: cancelledRequest.id,
    }),
  });
  app.histories.set("primary/dm-convert", [
    selected,
    cancelledRequest,
    cancellation,
    request,
  ]);
  await open(page, app);
  await page.locator('[data-channel-id="dm-convert"]').first().click();
  const card = page
    .locator(`[data-message-id="${request.id}"]`)
    .getByRole("region", {
      name: "Convert DM to #Alpha",
      exact: true,
    });
  await expect(card.getByText(selected.content, { exact: true })).toBeVisible();
  await expect(card.locator("time")).toHaveAttribute(
    "datetime",
    new Date(selected.created_at * 1000).toISOString(),
  );
  // Request cards are not valid message-range starting points, regardless of
  // whether they are still pending or have been cancelled.
  for (const id of [request.id, cancelledRequest.id]) {
    const row = page.locator(`[data-message-id="${id}"]`);
    await row.hover();
    await row
      .getByRole("button", { name: "More message actions", exact: true })
      .click();
    await expect(page.getByRole("menu")).toBeVisible();
    await expect(
      page.getByRole("menuitem", {
        name: "Convert to thread from here",
        exact: true,
      }),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
  }
  for (const theme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: theme });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 850 });
      await card.scrollIntoViewIfNeeded();
      const bounds = await card.boundingBox();
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      const jump = await card
        .getByRole("button", { name: "View message", exact: true })
        .boundingBox();
      expect(jump.x + jump.width).toBeLessThanOrEqual(bounds.x + bounds.width);
      await page.screenshot({
        path: test.info().outputPath(`starting-message-${theme}-${width}.png`),
      });
    }
  }
  await page.evaluate(() =>
    document.documentElement.style.setProperty("--buzz-text-scale", "1.3"),
  );
  const enlargedCard = await card.boundingBox();
  const enlargedLink = await card
    .getByRole("button", { name: "View message", exact: true })
    .boundingBox();
  expect(enlargedLink.x + enlargedLink.width).toBeLessThanOrEqual(
    enlargedCard.x + enlargedCard.width,
  );
  await card.getByRole("button", { name: "View message", exact: true }).click();
  await expect
    .poll(() => decodeURIComponent(new URL(page.url()).hash))
    .toContain(`"messageId":"${selected.id}"`);
});

// The shared row menu also renders inside a DM's thread panel. Verify the
// registered action is absent there without removing ordinary reply actions.
test("DM thread replies cannot start a conversion", async ({ page, app }) => {
  const root = app.sign({
    kind: 9,
    created_at: Math.floor(Date.now() / 1000) - 20,
    content: "Main DM message",
    tags: [["h", "dm-convert"]],
  });
  const reply = app.sign({
    kind: 9,
    created_at: root.created_at + 1,
    content: "Reply inside the DM thread",
    tags: [
      ["h", "dm-convert"],
      ["e", root.id, "", "reply"],
    ],
  });
  app.histories.set("primary/dm-convert", [root, reply]);
  await open(page, app);
  await page.locator('[data-channel-id="dm-convert"]').first().click();
  const main = page.locator(
    `[data-channel-timeline] [data-message-id="${root.id}"]`,
  );
  await hoverMessage(main);
  await main.getByRole("button", { name: "Reply", exact: true }).click();
  const row = page
    .getByRole("complementary", { name: "Thread", exact: true })
    .locator(`[data-message-id="${reply.id}"]`);
  await expect(row).toBeVisible();
  await hoverMessage(row);
  const more = row.getByRole("button", {
    name: "More message actions",
    exact: true,
  });
  await more.focus();
  await more.press("Enter");
  await expect(page.getByRole("menu")).toBeVisible();
  await expect(
    page.getByRole("menuitem", {
      name: "Convert to thread from here",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("menuitem", { name: "Copy message", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("dm-thread-reply-menu.png"),
  });
});
