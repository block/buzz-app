import { hoverMessage } from "./message-actions.mjs";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  historyCounts: { alpha: 3, beta: 1 },
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem("buzz-expand-nested-replies.v1", "on"),
  );
});

async function openThread(page, app) {
  await open(page, app);
  const root = app.histories
    .get("primary/alpha")
    .find((event) => event.content === "Thread root 0");
  await page
    .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
    .getByRole("button", { name: /^View thread:/ })
    .click();
  const panel = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  const editor = panel.getByRole("textbox", {
    name: "Reply to thread",
    exact: true,
  });
  const history = panel.getByRole("region", { name: "Thread messages" });
  const row = (text) =>
    panel
      .locator("[data-message-id]")
      .filter({ has: page.getByText(text, { exact: true }) })
      .last();
  await expect(row("Unread reply 0")).toBeVisible();
  const id = (text) => row(text).getAttribute("data-message-id");
  return { root, panel, editor, history, row, id };
}

// Layout effects and the panel's ResizeObserver settle within two frames.
const frames = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );

const eTags = (app, content) =>
  app.report.publications
    .find(({ event }) => event?.content === content)
    ?.event.tags.filter(([key]) => key === "e");

// Browser-only boundary: live nested arrivals against real scroll geometry,
// focus and the panel's follow state, which jsdom cannot lay out.
test("expanded nested replies keep the reader's place, focus and follow", async ({
  page,
  app,
}) => {
  const { root, panel, editor, history, row, id } = await openThread(page, app);
  for (let index = 0; index < 40; index++)
    app.append("primary", "alpha", `Peer reply ${index}`, true, false, root.id);
  await expect(row("Peer reply 39")).toBeVisible();
  const parent = await id("Unread reply 0");
  app.append("primary", "alpha", "Nested reply", true, false, root.id, parent);
  await expect(row("Nested reply")).toBeVisible();
  await expect(history.locator("button[data-thread-summary]")).toHaveCount(0);

  // A reader scrolled up keeps their place, a focused row and a draft.
  await editor.click();
  await editor.pressSequentially("Draft in progress");
  const anchorId = await id("Peer reply 10");
  await history.evaluate((element, anchor) => {
    const target = element.querySelector(`[data-message-id="${anchor}"]`);
    element.scrollTop +=
      target.getBoundingClientRect().top - element.getBoundingClientRect().top;
    target.tabIndex = -1;
    target.focus({ preventScroll: true });
  }, anchorId);
  await frames(page);
  const top = () =>
    page.evaluate(
      (anchor) =>
        document
          .querySelector(`[data-message-id="${anchor}"]`)
          .getBoundingClientRect().top,
      anchorId,
    );
  const before = await top();
  for (const [text, under] of [
    ["Nested above", "Peer reply 3"],
    ["Nested inside", "Peer reply 11"],
    ["Nested below", "Peer reply 30"],
  ])
    app.append("primary", "alpha", text, true, false, root.id, await id(under));
  for (const text of ["Nested above", "Nested inside", "Nested below"])
    await expect(row(text)).toBeAttached();
  await frames(page);
  expect(Math.abs((await top()) - before)).toBeLessThanOrEqual(1);
  await expect(
    history.locator(`[data-message-id="${anchorId}"]`),
  ).toBeFocused();
  await expect(editor).toHaveText("Draft in progress");

  // At the bottom, a tall nested arrival opens and the thread keeps following.
  await history.evaluate(
    (element) => (element.scrollTop = element.scrollHeight),
  );
  await frames(page);
  const tall = `Nested at the end. ${"More detail. ".repeat(60).trim()}`;
  app.append(
    "primary",
    "alpha",
    tall,
    true,
    false,
    root.id,
    await id("Peer reply 39"),
  );
  await expect(row(tall)).toBeAttached();
  await frames(page);
  app.append("primary", "alpha", "Ordinary after nested", true, false, root.id);
  await expect(row("Ordinary after nested")).toBeInViewport({ ratio: 1 });

  // A branch the reader collapses stays collapsed through new arrivals.
  const collapse = history.locator(
    `[data-depth]:has(> div:first-child [data-message-id="${parent}"]) > div > button[aria-label^="Collapse "]`,
  );
  await collapse.click();
  await expect(row("Nested reply")).toHaveCount(0);
  app.append("primary", "alpha", "Second nested", true, false, root.id, parent);
  await expect(
    panel.getByRole("button", { name: /^View 2 replies/ }),
  ).toBeVisible();
  await expect(row("Second nested")).toHaveCount(0);

  // Reply keeps its target and nests under the chosen message.
  const replyParent = await id("Peer reply 38");
  await editor.fill("Nested from Reply");
  await hoverMessage(row("Peer reply 38"));
  await row("Peer reply 38")
    .getByRole("button", { name: "Reply", exact: true })
    .click();
  await expect(
    panel.getByRole("button", { name: "Cancel reply target" }),
  ).toBeVisible();
  await editor.press("Enter");
  await expect.poll(() => eTags(app, "Nested from Reply")).toBeTruthy();
  expect(
    eTags(app, "Nested from Reply").map(([, eventId, , marker]) => [
      eventId.toLowerCase(),
      marker,
    ]),
  ).toEqual([
    [root.id.toLowerCase(), "root"],
    [replyParent.toLowerCase(), "reply"],
  ]);
  await expect(row("Nested from Reply")).toBeVisible();
});

test("a short thread keeps following after a nested reply opens", async ({
  page,
  app,
}) => {
  const { root, row, id } = await openThread(page, app);
  app.append(
    "primary",
    "alpha",
    "Nested in a short thread",
    true,
    false,
    root.id,
    await id("Unread reply 0"),
  );
  await expect(row("Nested in a short thread")).toBeVisible();
  await frames(page);
  for (let index = 0; index < 30; index++)
    app.append(
      "primary",
      "alpha",
      `Later reply ${index}`,
      true,
      false,
      root.id,
    );
  await expect(row("Later reply 29")).toBeInViewport();
});
