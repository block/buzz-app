import { test, expect } from "./fixture.mjs";
import { hoverMessage } from "./message-actions.mjs";
import { expectAnchor, open, settle, wheel } from "./timeline.mjs";
import { settlePanelMotion } from "./navigation.mjs";

// Browser-only: real animation frames, each engine's scrollTop clamping and
// rounding, Virtua's scroll handling, the floating toolbar's top-layer popover
// and a native modal dialog. The classifier, stepping, corrections, cancels and
// setting have Vitest coverage in src/features/messages/wheel-smoothing.test.ts.
//
// Smoothing runs only on Mac WebKit, so both engines report it here. That also
// turns on the Virtua patch's Mac overflow toggle in Chromium for this file.
// Untrusted wheel events have no native scroll, so any movement is the glide's.
test.use({ historyCounts: { alpha: 60, beta: 1 } });
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "platform", { value: "MacIntel" });
    Object.defineProperty(navigator, "vendor", {
      value: "Apple Computer, Inc.",
    });
    Object.defineProperty(navigator, "maxTouchPoints", { value: 0 });
  });
});

const history = (page) =>
  page.getByRole("region", { name: "Channel message history" });
// WebKit's 16.16 fixed-point mouse notches: fractional pixel deltas.
const NOTCH_UP = -6554 * 61 * (40 / 65536); // about -244px
const NOTCH_DOWN = 6554 * 31 * (40 / 65536); // about 124px

/**
 * Dispatches wheels at `target`. Reports whether they were prevented, and a
 * message in view: its paragraph's viewport Y before, at once and two frames
 * on. The timeline corrects scrollTop as rows above it measure, so movement is
 * read against content, as timeline.mjs anchors are, not scrollTop.
 */
const dispatch = (target, ...deltas) =>
  target.evaluate((node, deltas) => {
    const scroller = node.closest("[data-message-scroller]");
    const bounds = scroller.getBoundingClientRect();
    const inView = [...scroller.querySelectorAll("[data-message-id] p")].filter(
      (p) => {
        const rect = p.getBoundingClientRect();
        return rect.top >= bounds.top && rect.bottom <= bounds.bottom;
      },
    );
    const paragraph = inView[Math.floor(inView.length / 2)];
    const id = paragraph.closest("[data-message-id]").dataset.messageId;
    const top = () =>
      scroller
        .querySelector(`[data-message-id="${id}"] p`)
        .getBoundingClientRect().top - bounds.top;
    const start = top();
    const events = deltas.map((deltaY) => {
      const event = new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        deltaY,
      });
      node.dispatchEvent(event);
      return event;
    });
    const immediate = top();
    return new Promise((resolve) =>
      requestAnimationFrame(() =>
        requestAnimationFrame(() =>
          resolve({
            prevented: events.every((event) => event.defaultPrevented),
            id,
            start,
            immediate,
            frame: top(),
          }),
        ),
      ),
    );
  }, deltas);
const top = (page) => history(page).evaluate((node) => node.scrollTop);
/** The message moves opposite the wheel, by the whole of `delta`. */
const arrives = (page, { id, start }, delta) =>
  expectAnchor(page, { id, y: start - delta });
const prose = (page) =>
  history(page).locator("[data-message-id] p").filter({ visible: true });

test("glides a mouse notch, releases bottom follow, and leaves trackpad deltas alone", async ({
  page,
  app,
}) => {
  await open(page, app);
  const text = prose(page).last();
  // Integer deltas are a trackpad: WebKit scrolls for them.
  const trackpad = await dispatch(text, -3);
  // Not prevented means no glide began; the timeline can still settle itself.
  expect(trackpad.prevented).toBe(false);

  const notch = await dispatch(text, NOTCH_UP);
  expect(notch.prevented).toBe(true);
  expect(notch.immediate, "no jump before the first frame").toBe(notch.start);
  expect(notch.frame).toBeGreaterThan(notch.start);
  expect(notch.frame, "partway after two frames").toBeLessThan(
    notch.start - NOTCH_UP - 1,
  );
  await arrives(page, notch, NOTCH_UP);
  await settle(page);
  // The glide is reader scrolling: a new message no longer pulls the reader down.
  const reading = await top(page);
  app.append("primary", "alpha", "Arrived while reading", true, false);
  await expect(
    page.getByRole("button", { name: "1 new message", exact: true }),
  ).toBeVisible();
  expect(Math.abs((await top(page)) - reading)).toBeLessThan(1);

  const down = await dispatch(prose(page).first(), NOTCH_DOWN);
  expect(down.prevented).toBe(true);
  await arrives(page, down, NOTCH_DOWN);

  // Real integer wheel input still scrolls natively past the wheel listener.
  await settle(page);
  const before = await top(page);
  await history(page).hover();
  await wheel(page, -150);
  expect(await top(page)).toBeLessThan(before - 100);
});

test("glides a notch over the floating toolbar once, and turns it around without a jump", async ({
  page,
  app,
}) => {
  await open(page, app);
  await history(page).hover();
  await wheel(page, -600);
  // The row at the middle of the viewport, so hovering it does not scroll.
  const id = await history(page).evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return document
      .elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      .closest("[data-message-id]").dataset.messageId;
  });
  const row = history(page).locator(`[data-message-id="${id}"]`);
  const actions = row.getByRole("group", {
    name: "Message actions",
    includeHidden: true,
  });
  const reveal = async () => {
    await hoverMessage(row);
    await expect
      .poll(() => actions.evaluate((bar) => bar.matches(":popover-open")))
      .toBe(true);
  };
  await reveal();
  const button = actions.getByRole("button").first();
  const room = () =>
    history(page).evaluate(
      (node) => node.scrollHeight - node.clientHeight - node.scrollTop,
    );
  expect(await room()).toBeGreaterThan(2 * NOTCH_DOWN);
  const notch = await dispatch(button, NOTCH_DOWN);
  expect(notch.prevented).toBe(true);
  expect(notch.immediate, "the toolbar did not scroll for it too").toBe(
    notch.start,
  );
  await arrives(page, notch, NOTCH_DOWN);

  // Reverse before a frame: no instant forward is left to undo.
  await settle(page);
  await reveal();
  const turned = await dispatch(button, NOTCH_DOWN, NOTCH_UP);
  expect(turned.prevented).toBe(true);
  expect(turned.immediate).toBe(turned.start);
  expect(turned.frame, "moving up from the start").toBeGreaterThan(
    turned.start,
  );
  await arrives(page, turned, NOTCH_UP);
});

test("leaves wheels over a modal dialog inside a message alone", async ({
  page,
  app,
}) => {
  await open(page, app);
  // As a message plugin's expanded view does: a native modal within the row.
  const dialog = await prose(page)
    .last()
    .evaluateHandle((text) => {
      const dialog = document.createElement("dialog");
      const button = document.createElement("button");
      button.textContent = "Close";
      dialog.append("Fictional equation", button);
      text.closest("[data-message-id]").append(dialog);
      dialog.showModal();
      return dialog;
    });
  const inside = page
    .getByRole("dialog")
    .getByRole("button", { name: "Close" });
  for (const target of [page.getByRole("dialog"), inside]) {
    const result = await dispatch(target, NOTCH_UP);
    expect(result.prevented).toBe(false);
  }
  await dialog.evaluate((node) => node.remove());
  await dialog.dispose();
});

test("leaves mouse wheels to WebKit while the setting is off", async ({
  page,
  app,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("buzz-smooth-mouse-wheel.v1", "off"),
  );
  await open(page, app);
  const result = await dispatch(prose(page).last(), NOTCH_UP);
  expect(result.prevented).toBe(false);
});

test.describe("thread panel", () => {
  test.use({ readState: true, threadUnread: true, presenceThreadAuthors: 60 });

  test("glides a mouse notch through thread replies and releases bottom follow", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const { root, replies } = app.presenceThread;
    await page
      .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
      .getByRole("button", { name: /^View thread:/ })
      .click();
    const thread = page.getByRole("region", {
      name: "Thread messages",
      exact: true,
    });
    await expect(
      thread.locator(`[data-message-id="${replies.at(-1).id}"]`),
    ).toBeVisible();
    await settlePanelMotion(page);
    await settle(page, thread);
    const text = thread
      .locator("[data-message-id] p")
      .filter({ visible: true })
      .last();

    const trackpad = await dispatch(text, -3);
    expect(trackpad.prevented).toBe(false);

    const notch = await dispatch(text, NOTCH_UP);
    expect(notch.prevented).toBe(true);
    expect(notch.immediate, "no jump before the first frame").toBe(notch.start);
    expect(notch.frame).toBeGreaterThan(notch.start);
    expect(notch.frame, "partway after two frames").toBeLessThan(
      notch.start - NOTCH_UP - 1,
    );
    // The reply moves opposite the wheel, by the whole notch.
    await expect
      .poll(() =>
        thread.evaluate(
          (element, { id, y }) =>
            Math.abs(
              element
                .querySelector(`[data-message-id="${id}"] p`)
                .getBoundingClientRect().top -
                element.getBoundingClientRect().top -
                y,
            ),
          { id: notch.id, y: notch.start - NOTCH_UP },
        ),
      )
      .toBeLessThan(4);
    // The glide is reader scrolling: the thread stops following the bottom.
    await expect(
      thread.getByRole("button", { name: /^Jump to latest/ }),
    ).toBeVisible();

    // A press in the thread is newer reader intent: the glide ends at once.
    await settle(page, thread);
    const pressed = await text.evaluate(
      (node, deltaY) =>
        new Promise((resolve) => {
          const scroller = node.closest("[data-message-scroller]");
          const start = scroller.scrollTop;
          const event = new WheelEvent("wheel", {
            bubbles: true,
            cancelable: true,
            deltaY,
          });
          node.dispatchEvent(event);
          node.dispatchEvent(
            new PointerEvent("pointerdown", { bubbles: true }),
          );
          requestAnimationFrame(() =>
            requestAnimationFrame(() =>
              resolve({
                prevented: event.defaultPrevented,
                moved: scroller.scrollTop - start,
              }),
            ),
          );
        }),
      NOTCH_DOWN,
    );
    expect(pressed.prevented).toBe(true);
    expect(pressed.moved).toBe(0);
  });
});
