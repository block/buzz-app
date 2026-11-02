import { test, expect } from "./fixture.mjs";
import { open, settle } from "./timeline.mjs";

test.use({
  productionBroker: true,
  historyCounts: { alpha: 20, beta: 1 },
});

// Browser-only: a real pointer selection, the floating action placed from its
// line boxes, and the focused composer the quote lands in. Which selections are
// quotable, and the quote's Markdown, live in QuoteSelection.test.ts.

async function drag(page, from, to = from) {
  const start = await from.boundingBox();
  const end = await to.boundingBox();
  await page.mouse.move(start.x + 1, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.x + end.width - 1, end.y + end.height / 2, {
    steps: 12,
  });
  await page.mouse.up();
}

const quote = (page) =>
  page.getByRole("button", { name: "Quote", exact: true });

test("quotes a selected passage into the channel composer and keeps typing there", async ({
  page,
  app,
}) => {
  await open(page, app);
  const event = app.append(
    "primary",
    "alpha",
    "Ship the beta on Friday",
    true,
    true,
  );
  const paragraph = page
    .locator(`[data-channel-timeline] [data-message-id="${event.id}"]`)
    .locator("[data-message-body] p")
    .first();
  await expect(paragraph).toBeVisible();
  await settle(page);
  await drag(page, paragraph);
  await quote(page).click();
  const composer = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  await expect(composer).toBeFocused();
  await expect(composer.locator("blockquote")).toHaveText(
    "Ship the beta on Friday",
  );
  await expect(quote(page)).toHaveCount(0);
  await page.keyboard.type("Agreed");
  await expect(composer.locator("blockquote + p")).toHaveText("Agreed");
});

test("a selection across two messages offers no quote", async ({
  page,
  app,
}) => {
  await open(page, app);
  const first = app.append("primary", "alpha", "First message", true, true);
  const second = app.append("primary", "alpha", "Second message", true, true);
  const body = (event) =>
    page
      .locator(`[data-channel-timeline] [data-message-id="${event.id}"]`)
      .locator("[data-message-body]");
  await expect(body(second)).toBeVisible();
  await settle(page);
  // Positive control: the same rows quote one at a time.
  await drag(page, body(first));
  await expect(quote(page)).toBeVisible();
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await expect(quote(page)).toHaveCount(0);
  await drag(page, body(first), body(second));
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString()))
    .toContain("Second message");
  await expect(quote(page)).toHaveCount(0);
});

test.describe("in a thread", () => {
  test.use({ readState: true, threadUnread: true });

  test("a selection in an open thread quotes into the thread's composer", async ({
    page,
    app,
  }) => {
    await page.addInitScript(() =>
      localStorage.setItem("buzz-thread-placement.v1", "side"),
    );
    await open(page, app);
    const root = app.histories
      .get("primary/alpha")
      .find((row) => row.content === "Thread root 1");
    await page
      .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
      .getByRole("button", { name: /^View thread:/ })
      .click();
    const panel = page.locator("[data-panel-workspace]");
    const reply = panel.getByRole("textbox", {
      name: "Reply to thread",
      exact: true,
    });
    await expect(reply).toBeFocused();
    const history = panel.getByRole("region", { name: "Thread messages" });
    await settle(page, history);
    const body = history.locator(
      `[data-message-id="${root.id}"] [data-message-body] p`,
    );
    await drag(page, body);
    await quote(page).click();
    await expect(reply).toBeFocused();
    await expect(reply.locator("blockquote")).toHaveText(root.content);
    await expect(
      page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
    ).toHaveJSProperty("value", "");
  });
});
