import { expect } from "@playwright/test";
import { openPage } from "./navigation.mjs";
const rowSelector = "[data-message-id]";
const history = (page) =>
  page.getByRole("region", { name: "Channel message history" });
const composer = (page, name) =>
  page.getByRole("textbox", { name: `Message #${name}`, exact: true });

export async function settle(page, scroller = history(page)) {
  // Wait for geometry to stop moving, rather than assuming a fixed animation delay.
  let previous;
  let stable = 0;
  await expect
    .poll(
      async () => {
        const value = await scroller.evaluate((element) =>
          JSON.stringify([
            element.scrollTop,
            element.scrollHeight,
            element.clientHeight,
            ...Array.from(element.querySelectorAll("[data-message-id]")).map(
              (row) => [row.dataset.messageId, row.getBoundingClientRect().y],
            ),
          ]),
        );
        stable = value === previous ? stable + 1 : 0;
        previous = value;
        return stable;
      },
      { intervals: [50], message: "timeline geometry settles" },
    )
    .toBeGreaterThanOrEqual(3);
}
// Use for gestures that must move before capturing a reading baseline. Geometry
// can pause mid-gesture in Linux WebKit; only scrollend closes native input.
export async function wheel(page, deltaY, scroller = history(page)) {
  const completion = await scroller.evaluateHandle((element) => {
    const state = { started: false, done: false };
    const started = () => {
      state.started = true;
    };
    const ended = (event) => {
      if (event.target === element && state.started) state.done = true;
    };
    element.addEventListener("wheel", started, { once: true, passive: true });
    element.addEventListener("scrollend", ended);
    return {
      state,
      dispose() {
        element.removeEventListener("wheel", started);
        element.removeEventListener("scrollend", ended);
      },
    };
  });
  let pendingRead;
  try {
    await page.mouse.wheel(0, deltaY);
    await expect
      .poll(
        () => (pendingRead = completion.evaluate(({ state }) => state.done)),
        {
          message: "timeline wheel gesture completes",
        },
      )
      .toBe(true);
    await settle(page, scroller);
  } finally {
    // expect.poll does not cancel a DOM read when its deadline expires.
    await pendingRead;
    await completion.evaluate((observer) => observer.dispose());
    await completion.dispose();
  }
}

export async function anchor(page) {
  return history(page).evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const rows = Array.from(element.querySelectorAll("[data-message-id]"));
    // Prefer a whole paragraph, but tall messages can leave only clipped rows.
    // Track the first intersecting row in that case, as the reader does. The
    // same-ID/Y assertion below still detects displacement after a resize.
    const row =
      rows.find((row) => {
        const rect = row.querySelector("p").getBoundingClientRect();
        return rect.top >= bounds.top && rect.bottom <= bounds.bottom;
      }) ??
      rows.find((row) => {
        const rect = row.getBoundingClientRect();
        return rect.bottom > bounds.top && rect.top < bounds.bottom;
      });
    if (!row) throw new Error("No visible message anchor");
    return {
      id: row.dataset.messageId,
      y: row.querySelector("p").getBoundingClientRect().top - bounds.top,
    };
  });
}
export async function expectAnchor(page, expected) {
  await expect
    .poll(
      async () =>
        history(page).evaluate((element, expected) => {
          const row = element.querySelector(
            `[data-message-id="${expected.id}"]`,
          );
          return row
            ? Math.abs(
                row.querySelector("p").getBoundingClientRect().top -
                  element.getBoundingClientRect().top -
                  expected.y,
              )
            : Infinity;
        }, expected),
      { message: `same visible message ${expected.id} at same viewport Y` },
    )
    .toBeLessThan(4);
}
export async function edge(page, direction) {
  const distance = () =>
    history(page).evaluate(
      (element, direction) =>
        direction < 0
          ? element.scrollTop
          : element.scrollHeight - element.scrollTop - element.clientHeight,
      direction,
    );
  await history(page).hover();
  // Send one real gesture for the actual distance, not an arbitrary 100,000px
  // overshoot. At the boundary, retain input so production can initiate paging.
  const remaining = await distance();
  if (remaining >= 4) await wheel(page, direction * remaining);
  else await page.mouse.wheel(0, direction * Math.max(1, remaining));
  await expect
    .poll(distance, { message: "wheel reaches timeline edge" })
    .toBeLessThan(4);
  await settle(page);
  expect(await distance(), "timeline stays at the requested edge").toBeLessThan(
    4,
  );
}
export async function end(page) {
  await edge(page, 1);
}
export async function open(page, app) {
  await page.goto(app.origin);
  await openPage(page, "Messages");
  await composer(page, "Alpha").waitFor();
  await expect(history(page).locator(rowSelector).first()).toBeVisible();
  await settle(page);
}
export async function upper(page) {
  await end(page);
  const distance = () =>
    history(page).evaluate(
      (element) =>
        element.scrollHeight - element.scrollTop - element.clientHeight,
    );
  await history(page).hover();
  expect(
    await history(page).evaluate((element) => element.scrollTop),
    "history has room for an above-bottom reading position",
  ).toBeGreaterThan(400);
  // This establishes a reading position, not a wheel-delta measurement. A wheel
  // request does not guarantee exact displacement (Linux WebKit stopped short).
  // Each bounded gesture must make real progress; never assign scrollTop or
  // repeat an assertion until an immobile timeline happens to pass.
  for (let gesture = 0; gesture < 4; gesture++) {
    const before = await distance();
    if (before > 400) break;
    await wheel(page, -(650 - before));
    expect(
      await distance(),
      "reading gesture moves away from bottom",
    ).toBeGreaterThan(before);
  }
  expect(await distance(), "reading position is above bottom").toBeGreaterThan(
    400,
  );
  return anchor(page);
}
