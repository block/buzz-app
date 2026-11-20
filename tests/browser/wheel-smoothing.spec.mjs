import { finalizeEvent, generateSecretKey } from "nostr-tools";
import { test, expect } from "./fixture.mjs";
import { expectAnchor, open, settle, wheel } from "./timeline.mjs";
import { settlePanelMotion } from "./navigation.mjs";
import { markAllRead } from "./reading.mjs";

// Browser-only: real animation frames, each engine's scrollTop clamping and
// rounding, Virtua's scroll handling, and the panels' own bottom follow. The
// classifier, stepping, corrections, cancels, overlays and setting have Vitest
// coverage in src/features/messages/wheel-smoothing.test.ts.
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
    // The glide reads wheels less than 200ms apart as one device's gesture.
    // Each dispatch below starts its own gesture, stamped at least that long
    // after the last wheel, real or dispatched.
    let last = -Infinity;
    addEventListener(
      "wheel",
      (event) => {
        last = Math.max(last, event.timeStamp);
      },
      { capture: true, passive: true },
    );
    window.__wheelGesture = () =>
      (last = Math.max(performance.now(), last + 200));
    window.__sinceWheel = () => performance.now() - last;
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
    const timeStamp = window.__wheelGesture();
    const events = deltas.map((deltaY) => {
      const event = new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        deltaY,
      });
      Object.defineProperty(event, "timeStamp", { value: timeStamp });
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
/**
 * Dispatches one notch at `target` and runs only the glide's first frame. Later
 * frames wait for `window.__releaseFrames()`, so input lands mid-glide, still
 * within bottom follow's 80px, on every run. True when the notch was prevented.
 */
const holdGlide = (target, deltaY) =>
  target.evaluate((node, deltaY) => {
    const held = [];
    const raf = window.requestAnimationFrame;
    window.__releaseFrames = () => {
      window.requestAnimationFrame = raf;
      for (const callback of held.splice(0)) raf(callback);
    };
    window.requestAnimationFrame = (callback) => held.push(callback);
    const event = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY,
    });
    Object.defineProperty(event, "timeStamp", {
      value: window.__wheelGesture(),
    });
    node.dispatchEvent(event);
    const now = performance.now();
    for (const callback of held.splice(0)) callback(now + 16);
    return event.defaultPrevented;
  }, deltaY);
/** The viewport Y of message `id`'s paragraph within `scroller`. */
const paragraphY = (scroller, id) =>
  scroller.evaluate(
    (element, id) =>
      element
        .querySelector(`[data-message-id="${id}"] p`)
        .getBoundingClientRect().top - element.getBoundingClientRect().top,
    id,
  );
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

  // Real integer wheel input still scrolls natively past the wheel listener,
  // as a new gesture once the last notch is a pause behind it.
  await settle(page);
  await expect
    .poll(() => page.evaluate(() => window.__sinceWheel()))
    .toBeGreaterThan(200);
  const before = await top(page);
  await history(page).hover();
  await wheel(page, -150);
  expect(await top(page)).toBeLessThan(before - 100);
});

test("a message during an upward glide leaves the timeline where the notch lands", async ({
  page,
  app,
}) => {
  await open(page, app);
  const text = prose(page).last();
  const id = await text.evaluate(
    (node) => node.closest("[data-message-id]").dataset.messageId,
  );
  const start = await paragraphY(history(page), id);
  expect(await holdGlide(text, NOTCH_UP)).toBe(true);
  const moved = (await paragraphY(history(page), id)) - start;
  expect(moved, "partway, within bottom follow").toBeGreaterThan(0);
  expect(moved).toBeLessThan(80);

  app.append("primary", "alpha", "Arrived mid-glide", true, false);
  await expect(
    page.getByRole("button", { name: "1 new message", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => window.__releaseFrames());
  await settle(page);
  // The notch lands in full, as a native one would, and follow is released.
  await expectAnchor(page, { id, y: start - NOTCH_UP });
  await expect(
    page.getByRole("button", { name: "1 new message", exact: true }),
  ).toBeVisible();
});

test.describe("thread panel", () => {
  test.use({
    productionBroker: true,
    readState: true,
    threadUnread: true,
    presenceThreadAuthors: 60,
  });
  // A thread with unread replies opens at the first one; these start at the end.
  test.beforeEach(async ({ page, app }) => {
    await open(page, app);
    await markAllRead(page);
  });

  test("glides a mouse notch through thread replies and releases bottom follow", async ({
    page,
    app,
  }) => {
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
          Object.defineProperty(event, "timeStamp", {
            value: window.__wheelGesture(),
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

  test("a reply during an upward glide leaves the thread where the notch lands", async ({
    page,
    app,
  }) => {
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
    const peer = generateSecretKey();
    let time = replies.at(-1).created_at;
    const reply = (content) => {
      const event = finalizeEvent(
        {
          kind: 9,
          content,
          created_at: ++time,
          tags: [
            ["h", "alpha"],
            ["e", root.id, "", "reply"],
          ],
        },
        peer,
      );
      app.histories.get("primary/alpha").push(event);
      app.relay.publish("primary", event);
      return thread.locator(`[data-message-id="${event.id}"]`);
    };
    const y = (id) => paragraphY(thread, id);
    const anchor = replies.at(-1).id;
    const start = await y(anchor);
    expect(
      await holdGlide(thread.locator("[data-message-id] p").first(), NOTCH_UP),
    ).toBe(true);
    const moved = (await y(anchor)) - start;
    expect(moved, "partway, within bottom follow").toBeGreaterThan(0);
    expect(moved).toBeLessThan(80);

    await expect(reply("Live reply during the glide")).toBeAttached();
    await thread.evaluate(() => window.__releaseFrames());
    await settle(page, thread);
    // The notch lands in full, as a native one would, and follow is released.
    const landed = async () => Math.abs((await y(anchor)) - (start - NOTCH_UP));
    await expect.poll(landed).toBeLessThan(4);
    await expect(
      thread.getByRole("button", { name: "1 new message", exact: true }),
    ).toBeVisible();
    // The next reply does not pull the reader back down.
    await expect(reply("A later reply")).toBeAttached();
    await expect(
      thread.getByRole("button", { name: "2 new messages", exact: true }),
    ).toBeVisible();
    await settle(page, thread);
    expect(await landed()).toBeLessThan(4);
  });
});
