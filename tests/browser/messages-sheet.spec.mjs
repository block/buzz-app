import { test, expect } from "./fixture.mjs";
import { animationsSettled } from "./animations.mjs";
test.use({
  productionBroker: true,
  readState: true,
  inboxDm: true,
  historyCounts: { alpha: 3, beta: 2 },
});

// Built-app routing, native editing, responsive pane geometry and history must
// agree while the list remains mounted and interactive beside its reader.
test("Messages keeps its list beside conversations and preserves drafts and history", async ({
  page,
  app,
}, testInfo) => {
  await page.setViewportSize({ width: 1920, height: 950 });
  app.append("primary", "dm-peer", "[Open Beta](buzz://channel/beta)", false);
  await page.goto(app.origin);
  const rail = page.getByRole("navigation", { name: "Apps", exact: true });
  await rail.getByRole("button", { name: "Team", exact: true }).click();
  const index = page.getByRole("region", { name: "Team", exact: true });
  const detail = index.getByRole("region", {
    name: "Conversation detail",
    exact: true,
  });
  const alpha = index.locator(
    '[data-activity-row="alpha"] [data-conversation-row]',
  );
  const beta = index.locator(
    '[data-activity-row="beta"] [data-conversation-row]',
  );
  await expect(alpha).toBeVisible();
  await alpha.click();
  const timeline = detail.locator('[data-channel-timeline="alpha"]');
  await expect(timeline).toBeVisible();
  await expect(alpha).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("dialog", { name: "Alpha", exact: true }),
  ).toHaveCount(0);
  const listBox = await alpha.boundingBox();
  const detailBox = await detail.boundingBox();
  expect(listBox.x + listBox.width).toBeLessThanOrEqual(detailBox.x);
  const editor = detail.getByRole("textbox", { name: /^Message/ });
  await page.evaluate(() => document.fonts.ready);
  await alpha.evaluate(async (element) => {
    await Promise.all(
      element.getAnimations().map((animation) => animation.finished),
    );
  });
  // Pane chrome fills the workspace while the editor retains its reading width.
  const back = detail.getByRole("button", {
    name: "Hide Team list",
    exact: true,
  });
  const tools = detail.getByRole("button", {
    name: "Conversation actions",
    exact: true,
  });
  const header = back.locator("xpath=ancestor::header[1]");
  const headerBox = await header.boundingBox();
  const readerBox = await detail
    .getByRole("article", { name: "Conversation", exact: true })
    .boundingBox();
  expect(headerBox.x).toBeCloseTo(readerBox.x, 0);
  expect(headerBox.width).toBeCloseTo(readerBox.width, 0);
  const backBox = await back.boundingBox();
  const toolsBox = await tools.boundingBox();
  expect(backBox.x - detailBox.x).toBeLessThan(backBox.width);
  expect(
    detailBox.x + detailBox.width - toolsBox.x - toolsBox.width,
  ).toBeLessThan(toolsBox.width);
  const composer = editor.locator(
    "xpath=ancestor::*[@data-composer-surface][1]",
  );
  expect((await composer.boundingBox()).width).toBeLessThan(headerBox.width);

  // Heading, filters and avatar content share one leading edge in the list.
  const contentLeft = await alpha.evaluate(
    (element) =>
      element.getBoundingClientRect().left +
      parseFloat(getComputedStyle(element).paddingInlineStart),
  );
  const headingBox = await index
    .getByRole("heading", { name: "Team", exact: true })
    .boundingBox();
  const filterBox = await index
    .getByRole("button", { name: "Filter and sort conversations", exact: true })
    .boundingBox();
  expect(headingBox.x).toBeCloseTo(contentLeft, 0);
  expect(filterBox.x).toBeCloseTo(contentLeft, 0);
  const allBox = await index
    .getByRole("tab", { name: "All", exact: true })
    .boundingBox();
  expect(filterBox.x + filterBox.width).toBeLessThan(allBox.x);
  const create = index.getByRole("button", {
    name: "New message",
    exact: true,
  });
  await expect(create).toHaveCount(1);
  const createBox = await create.boundingBox();
  expect(createBox.y).toBeLessThan(headingBox.y + headingBox.height);
  expect(createBox.y + createBox.height).toBeGreaterThan(headingBox.y);
  const rowInsets = await alpha.evaluate((element) => {
    const pane = element.closest(".shell-body").getBoundingClientRect();
    const divider = element
      .closest("[data-detail-workspace]")
      .querySelector('[aria-label="Conversation detail"]')
      .getBoundingClientRect().left;
    const row = element.getBoundingClientRect();
    const padding = getComputedStyle(element);
    return {
      left: row.left - pane.left,
      right: divider - row.right,
      contentLeft:
        row.left - pane.left + parseFloat(padding.paddingInlineStart),
      contentRight: divider - row.right + parseFloat(padding.paddingInlineEnd),
    };
  });
  expect(rowInsets.right).toBeCloseTo(rowInsets.left, 0);
  expect(rowInsets.contentRight).toBeCloseTo(rowInsets.contentLeft, 0);
  await editor.fill("Keep the list conversation draft");
  await beta.click();
  await expect(detail.locator('[data-channel-timeline="beta"]')).toBeVisible();
  await page.goBack();
  await expect(editor).toHaveText("Keep the list conversation draft");
  await page.goForward();
  await expect(detail.locator('[data-channel-timeline="beta"]')).toBeVisible();
  await alpha.click();
  await expect(editor).toHaveText("Keep the list conversation draft");
  await expect
    .poll(() => decodeURIComponent(new URL(page.url()).hash))
    .toContain('"channelId":"alpha"');
  await page.reload();
  await expect(editor).toHaveText("Keep the list conversation draft");
  await expect(alpha).toBeHidden();
  await detail
    .getByRole("button", { name: "Show Team list", exact: true })
    .click();
  await expect(alpha).toBeVisible();
  await animationsSettled(index, { subtree: true });
  await page.screenshot({
    path: testInfo.outputPath("messages-master-detail-wide.png"),
  });
  const selectedUrl = page.url();
  await detail
    .getByRole("button", { name: "Hide Team list", exact: true })
    .click();
  await expect(page).toHaveURL(selectedUrl);
  await expect(alpha).toBeHidden();
  // A collapsed list must not stack shell gutters around the pane's own inset.
  const canvasBox = await page.locator(".shell-body").boundingBox();
  const fullBackBox = await detail
    .getByRole("button", { name: "Show Team list", exact: true })
    .boundingBox();
  const fullToolsBox = await tools.boundingBox();
  expect(fullBackBox.x - canvasBox.x).toBeCloseTo(backBox.x - readerBox.x, 0);
  expect(
    canvasBox.x + canvasBox.width - fullToolsBox.x - fullToolsBox.width,
  ).toBeCloseTo(readerBox.x + readerBox.width - toolsBox.x - toolsBox.width, 0);
  await page.screenshot({
    path: testInfo.outputPath("messages-full-width.png"),
  });
  await page.setViewportSize({ width: 480, height: 950 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "125%";
  });
  await expect(alpha).toBeHidden();
  await expect(editor).toBeInViewport();
  const narrow = await detail.boundingBox();
  expect(narrow.x).toBeGreaterThanOrEqual(0);
  expect(narrow.x + narrow.width).toBeLessThanOrEqual(480);
  await page.screenshot({
    path: testInfo.outputPath("messages-master-detail-narrow.png"),
  });
  await detail
    .getByRole("button", { name: "Show Team list", exact: true })
    .click();
  await expect(alpha).toBeVisible();
  await index
    .getByRole("button", { name: "Hide Team list", exact: true })
    .first()
    .click();
  await expect(alpha).toBeHidden();
  await expect(
    detail.getByRole("button", { name: "Show Team list", exact: true }),
  ).toBeFocused();
  await expect(editor).toHaveText("Keep the list conversation draft");
  await page.setViewportSize({ width: 1440, height: 950 });
  await rail.getByRole("button", { name: "Team", exact: true }).click();
  await expect(alpha).toBeVisible();
  await index.getByRole("button", { name: "New message", exact: true }).click();
  const newMessage = index.getByRole("region", {
    name: "New message",
    exact: true,
  });
  const recipients = newMessage.getByRole("combobox", {
    name: "Message recipients",
  });
  await expect(recipients).toBeVisible();
  await expect(
    newMessage.getByRole("tab", { name: "Team", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await recipients.fill(app.participants[0]);
  await page.getByRole("option", { name: /Alice Fixture/ }).click();
  await expect(
    newMessage.getByText("Inbox DM fixture reply", { exact: true }),
  ).toBeVisible();
  await newMessage
    .getByRole("link", { name: "Open Beta", exact: true })
    .click();
  await expect(page.locator('[data-channel-timeline="beta"]')).toBeVisible();
  await expect(index).toBeVisible();
  await detail
    .getByRole("button", { name: "Show Team list", exact: true })
    .click();
  await expect(alpha).toBeVisible();
  await detail
    .getByRole("button", { name: "Close Beta tab", exact: true })
    .click();
  await expect(detail.locator('[data-channel-timeline="beta"]')).toHaveCount(0);
  await expect(newMessage.getByRole("textbox")).toBeVisible();
  await detail
    .getByRole("button", { name: "Hide Team list", exact: true })
    .click();
  await page.setViewportSize({ width: 480, height: 950 });
  await expect(newMessage.getByRole("textbox")).toBeInViewport();
  await expect(newMessage.getByRole("textbox")).toHaveAttribute(
    "contenteditable",
    "true",
  );
});

// Pin and sidebar entry points must override an already expanded current visit.
test("conversation lists default closed for direct opens and open for View more", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  const rail = page.getByRole("navigation", { name: "Apps", exact: true });
  await rail.getByRole("button", { name: "Alpha", exact: true }).click();
  const messages = page.getByRole("region", { name: "Team", exact: true });
  const detail = messages.getByRole("region", {
    name: "Conversation detail",
    exact: true,
  });
  const row = messages.locator(
    '[data-activity-row="alpha"] [data-conversation-row]',
  );
  await expect(row).toBeHidden();
  await expect(
    detail.getByRole("button", { name: "Show Team list", exact: true }),
  ).toHaveAttribute("aria-expanded", "false");
  await detail
    .getByRole("button", { name: "Show Team list", exact: true })
    .click();
  await expect(row).toBeVisible();
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Pin", exact: true }).click();
  await rail
    .locator('[data-rail-section="pins"]')
    .getByRole("button", { name: "Alpha", exact: true })
    .click();
  await expect(row).toBeHidden();
  await rail.getByRole("button", { name: "Team", exact: true }).click();
  await expect(row).toBeVisible();
  await row.click();
  await expect(row).toBeVisible();
  await detail
    .getByRole("button", { name: "Hide Team list", exact: true })
    .click();
  await expect(row).toBeHidden();
  await rail.getByRole("button", { name: "Team", exact: true }).click();
  await expect(row).toBeVisible();
  await page.goBack();
  await expect(row).toBeHidden();
  await expect(detail.locator('[data-channel-timeline="alpha"]')).toBeVisible();
  await page.goForward();
  await expect(row).toBeVisible();
  await rail.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("menuitem", { name: /^New message/ }).click();
  await expect(
    detail.getByRole("button", { name: "Show Team list", exact: true }),
  ).toBeVisible();
  await expect(
    detail.getByRole("textbox", { name: "New message", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("combobox", { name: "Message recipients" }),
  ).toBeVisible();
  await expect(
    page.getByRole("tab", { name: "Team", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page
    .getByRole("combobox", { name: "Message recipients" })
    .fill(app.participants[0]);
  await page.getByRole("option", { name: /Alice Fixture/ }).click();
  await expect(
    detail.getByRole("textbox", { name: /^Message/ }),
  ).toBeEditable();
  await page.keyboard.press("ControlOrMeta+n");
  await expect(
    page.getByRole("combobox", { name: "Message recipients" }),
  ).toBeVisible();
  await expect(
    page.getByRole("tablist", { name: "Conversation", exact: true }),
  ).toBeVisible();
});

// Real rail membership, navigation history and the reader must agree on the
// collection; the DOM owner tests do not run this shell/page composition.
test("a conversation opens the list of its sidebar section and retains it through history", async ({
  page,
  app,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 950 });
  await page.addInitScript(
    ({ viewer }) => {
      const scope = { viewer, communityOrigin: "https://primary.example" };
      localStorage.setItem(
        `buzz-view.v1:${JSON.stringify([`${scope.communityOrigin}:${viewer}`, "navigation-layout:v1"])}`,
        JSON.stringify({
          sections: [{ id: "custom:project", title: "Project chats" }],
          placements: ["alpha", "beta"].map((channelId) => ({
            section: "custom:project",
            entry: {
              id: `channel:${channelId}`,
              label: channelId === "alpha" ? "Alpha" : "Beta",
              kind: "channel",
              target: { version: 1, kind: "conversation", scope, channelId },
            },
          })),
        }),
      );
    },
    { viewer: app.viewer },
  );
  await page.goto(app.origin);
  const rail = page.getByRole("navigation", { name: "Apps", exact: true });
  const card = rail.locator('[data-rail-section="custom:project"]');
  await card.getByRole("button", { name: "Alpha", exact: true }).click();
  const reader = page.getByRole("region", {
    name: "Conversation detail",
    exact: true,
  });
  const toggle = reader.getByRole("button", {
    name: "Show Project chats list",
    exact: true,
  });
  await expect(toggle).toBeVisible();
  await toggle.click();
  const list = page.getByRole("region", { name: "Project chats", exact: true });
  await expect(
    list.getByRole("heading", { name: "Project chats", exact: true }),
  ).toBeVisible();
  await expect(
    list.locator('[data-activity-row="alpha"] [data-conversation-row]'),
  ).toBeVisible();
  await expect(
    list.locator('[data-activity-row="beta"] [data-conversation-row]'),
  ).toBeVisible();
  await expect(list.locator('[data-activity-row="dm-peer"]')).toHaveCount(0);
  const previewText = "Section preview stays on a single line. "
    .repeat(12)
    .trim();
  app.append("primary", "beta", previewText, true, false);
  const preview = list.getByText(/^Section preview stays on a single line\./);
  await expect(preview).toBeVisible();
  expect(
    await preview.evaluate(
      (element) =>
        element.getBoundingClientRect().height /
        parseFloat(getComputedStyle(element).lineHeight),
    ),
  ).toBeLessThanOrEqual(1.05);
  const editor = reader.getByRole("textbox", { name: /^Message/ });
  await editor.fill("Keep the section conversation draft");
  await list
    .locator('[data-activity-row="beta"] [data-conversation-row]')
    .click();
  await expect(reader.locator('[data-channel-timeline="beta"]')).toBeVisible();
  await expect(list).toBeVisible();
  await page.goBack();
  await expect(editor).toHaveText("Keep the section conversation draft");
  await expect(list).toBeVisible();
  const railBox = await rail.boundingBox();
  const canvasBox = await page.locator(".shell-body").boundingBox();
  expect(railBox.x + railBox.width).toBeCloseTo(canvasBox.x, 0);
  await page.screenshot({
    path: testInfo.outputPath("section-conversation-list.png"),
  });
  await page.reload();
  await reader
    .getByRole("button", { name: "Show Project chats list", exact: true })
    .click();
  await expect(
    list.locator('[data-activity-row="beta"] [data-conversation-row]'),
  ).toBeVisible();
  await expect(list.locator('[data-activity-row="dm-peer"]')).toHaveCount(0);
  await list
    .locator('[data-activity-row="beta"] [data-conversation-row]')
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Pin", exact: true }).click();
  await rail
    .locator('[data-rail-section="pins"]')
    .getByRole("button", { name: "Beta", exact: true })
    .click();
  await reader
    .getByRole("button", { name: "Show Pins list", exact: true })
    .click();
  const pins = page.getByRole("region", { name: "Pins", exact: true });
  await expect(
    pins.getByText(/^Section preview stays on a single line\./),
  ).toBeVisible();
  await expect(pins.locator('[data-activity-row="alpha"]')).toHaveCount(0);
  await animationsSettled(
    page.getByRole("region", { name: "Pins workspace", exact: true }),
    { subtree: true },
  );
  await page.screenshot({
    path: testInfo.outputPath("pins-conversation-previews.png"),
  });
});

// Native transitions and layout measurement prove intermediate paint and reversal;
// DOM emulation cannot establish either, or honor real input/motion preferences.
test("hamburger motion reverses smoothly and skips keyboard and reduced motion", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  const rail = page.getByRole("navigation", { name: "Apps", exact: true });
  await rail.getByRole("button", { name: "Alpha", exact: true }).click();
  const messages = page.getByRole("region", { name: "Team", exact: true });
  const reader = messages.getByRole("region", {
    name: "Conversation detail",
    exact: true,
  });
  const show = reader.getByRole("button", {
    name: "Show Team list",
    exact: true,
  });
  const controls = await show.getAttribute("aria-controls");
  const list = page.locator(`[id=${JSON.stringify(controls)}]`);
  const panes = list.locator("..");
  const holdNextToggle = (halfway) =>
    panes.evaluate((element, half) => {
      const observer = new MutationObserver(() => {
        for (const pane of element.children) {
          getComputedStyle(pane).transform;
          for (const animation of pane.getAnimations()) {
            animation.pause();
            animation.currentTime = half
              ? Number(animation.effect.getTiming().duration) / 2
              : 0;
          }
        }
        observer.disconnect();
      });
      observer.observe(element, {
        attributes: true,
        attributeFilter: ["data-list-open"],
      });
    }, halfway);
  await holdNextToggle(true);
  await show.click();
  await expect
    .poll(() =>
      list.evaluate(
        (element) =>
          element
            .getAnimations()
            .filter((animation) => animation.playState === "paused").length,
      ),
    )
    .toBeGreaterThan(0);
  const intermediate = await list.evaluate((element) => ({
    opacity: Number(getComputedStyle(element).opacity),
    x: new DOMMatrixReadOnly(getComputedStyle(element).transform).m41,
    width: element.getBoundingClientRect().width,
  }));
  expect(intermediate.opacity).toBeGreaterThan(0);
  expect(intermediate.opacity).toBeLessThan(1);
  expect(intermediate.x).toBeGreaterThan(-intermediate.width);
  expect(intermediate.x).toBeLessThan(0);
  const readerMatrix = await reader.evaluate((element) => {
    const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
    return { x: matrix.m41, scaleX: matrix.m11, scaleY: matrix.m22 };
  });
  expect(readerMatrix.x).toBeLessThan(0);
  expect(readerMatrix.scaleX).toBe(1);
  expect(readerMatrix.scaleY).toBe(1);
  const before = await reader.boundingBox();
  await holdNextToggle(false);
  await reader
    .getByRole("button", { name: "Hide Team list", exact: true })
    .click();
  await expect
    .poll(() =>
      reader.evaluate((element) =>
        element
          .getAnimations()
          .some((animation) => animation.playState === "paused"),
      ),
    )
    .toBe(true);
  expect((await reader.boundingBox()).x).toBeCloseTo(before.x, 0);
  await panes.evaluate((element) => {
    for (const pane of element.children)
      for (const animation of pane.getAnimations()) animation.play();
  });
  await animationsSettled(panes, { subtree: true });
  await expect(list).toBeHidden();
  await show.focus();
  await page.keyboard.press("Enter");
  await expect(list).toBeVisible();
  expect(await list.evaluate((element) => element.getAnimations().length)).toBe(
    0,
  );
  expect(
    await reader.evaluate((element) => element.getAnimations().length),
  ).toBe(0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await reader
    .getByRole("button", { name: "Hide Team list", exact: true })
    .click();
  await expect(list).toBeHidden();
  expect(await list.evaluate((element) => element.getAnimations().length)).toBe(
    0,
  );
  expect(
    await reader.evaluate((element) => element.getAnimations().length),
  ).toBe(0);
});

// The divider must resize the mounted list, without navigating or remounting its reader.
test("collection list resizing preserves the conversation and saved width", async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 1600, height: 650 });
  await page.goto(app.origin);
  const rail = page.getByRole("navigation", { name: "Apps", exact: true });
  await rail.getByRole("button", { name: "Team", exact: true }).click();
  const team = page.getByRole("region", { name: "Team", exact: true });
  await team
    .locator('[data-activity-row="alpha"] [data-conversation-row]')
    .click();
  const editor = team.getByRole("textbox", { name: /^Message/ });
  const composer = editor.locator(
    "xpath=ancestor::*[@data-composer-surface][1]",
  );
  await expect(composer).toBeInViewport({ ratio: 1 });
  await editor.fill("Keep this draft while resizing");
  const divider = team.getByRole("separator", {
    name: "Resize sidebar",
    exact: true,
  });
  await expect(divider).toBeVisible();
  const initial = Number(await divider.getAttribute("aria-valuenow"));
  const box = await divider.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2, {
    steps: 8,
  });
  await page.mouse.up();
  await expect(divider).toHaveAttribute("aria-valuenow", String(initial + 80));
  await expect(editor).toHaveText("Keep this draft while resizing");
  await team
    .getByRole("button", { name: "Hide Team list", exact: true })
    .click();
  await expect(divider).toBeHidden();
  await expect(composer).toBeInViewport({ ratio: 1 });
  await team
    .getByRole("button", { name: "Show Team list", exact: true })
    .click();
  await expect(divider).toHaveAttribute("aria-valuenow", String(initial + 80));
  await expect(composer).toBeInViewport({ ratio: 1 });
  await divider.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(divider).toHaveAttribute("aria-valuenow", String(initial + 64));
  await page.reload();
  await rail.getByRole("button", { name: "Team", exact: true }).click();
  await expect(divider).toHaveAttribute("aria-valuenow", String(initial + 64));
  await divider.dblclick();
  await expect(divider).toHaveAttribute("aria-valuenow", String(initial));
});

// dnd-kit collision detection and the clipped scrollport require a layout engine.
test("rail cards can drop at the top without adding a gap", async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 1600, height: 1100 });
  await page.goto(app.origin);
  const rail = page.getByRole("navigation", { name: "Apps", exact: true });
  const cards = rail.locator("[data-rail-section]");
  await expect(cards.first()).toBeVisible();
  const firstId = await cards.first().getAttribute("data-rail-section");
  const source = cards.nth(1);
  const movedId = await source.getAttribute("data-rail-section");
  const grabber = source.getByRole("button", { name: /^Move .* section$/ });
  const grab = await grabber.boundingBox();
  const first = await cards.first().boundingBox();
  await page.mouse.move(grab.x + grab.width / 2, grab.y + grab.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    grab.x + grab.width / 2 + 10,
    grab.y + grab.height / 2,
    { steps: 3 },
  );
  await page.mouse.move(first.x + first.width / 2, first.y + 2, { steps: 12 });
  const target = rail.locator('[aria-hidden="true"][data-drop-target]');
  await expect(target).toBeVisible();
  expect((await target.locator("..").boundingBox()).y).toBe(first.y);
  await expect
    .poll(() =>
      target.evaluate((node) =>
        Number(getComputedStyle(node, "::after").opacity),
      ),
    )
    .toBe(1);
  await page.mouse.up();
  await expect(cards.first()).toHaveAttribute("data-rail-section", movedId);
  await expect(cards.nth(1)).toHaveAttribute("data-rail-section", firstId);
  await page.reload();
  await expect(cards.first()).toHaveAttribute("data-rail-section", movedId);
  await cards
    .first()
    .getByRole("button", { name: "Pins", exact: true })
    .click();
  await expect(
    page
      .getByRole("region", { name: "Pins", exact: true })
      .getByRole("heading", { name: "Pins", exact: true }),
  ).toBeVisible();
});

// The collection must mount the same saved Solo draft and settings as its card's +.
test("Solo collection and card plus share the new-chat composer", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  const rail = page.getByRole("navigation", { name: "Apps", exact: true });
  const card = rail.locator('[data-rail-section="solo"]');
  await card.getByRole("button", { name: "Solo", exact: true }).click();
  const solo = page.getByRole("region", { name: "Solo", exact: true });
  const draft = solo.getByRole("region", { name: "New chat", exact: true });
  const editor = draft.getByRole("textbox", {
    name: "Message your agents",
    exact: true,
  });
  await editor.fill("Keep the same Solo draft");
  await expect(
    draft.getByRole("button", { name: "Chat settings", exact: true }),
  ).toBeVisible();
  await expect(
    solo.getByRole("combobox", { name: "Message recipients" }),
  ).toHaveCount(0);
  await solo
    .getByRole("button", { name: "Hide Solo list", exact: true })
    .click();
  await expect(editor).toHaveText("Keep the same Solo draft");
  await card
    .getByRole("button", { name: "New Solo chat", exact: true })
    .click();
  await expect(editor).toHaveText("Keep the same Solo draft");
  await card.getByRole("button", { name: "Solo", exact: true }).click();
  await expect(editor).toHaveText("Keep the same Solo draft");
});
