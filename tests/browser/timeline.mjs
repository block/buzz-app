import { expect } from "@playwright/test";
const rowSelector = "[data-message-id]";
const history = (page) =>
  page.getByRole("region", { name: "Channel message history" });
const button = (page, name) => page.getByRole("button", { name, exact: true });
const composer = (page, name) =>
  page.getByRole("textbox", { name: `Message #${name}`, exact: true });

export async function settle(page) {
  // Wait for geometry to stop moving, rather than assuming a fixed animation delay.
  let previous;
  let stable = 0;
  await expect
    .poll(
      async () => {
        const value = await history(page).evaluate((element) =>
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
export async function anchor(page) {
  return history(page).evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const row = Array.from(element.querySelectorAll("[data-message-id]")).find(
      (row) => {
        const rect = row.querySelector("p").getBoundingClientRect();
        return rect.top >= bounds.top && rect.bottom <= bounds.bottom;
      },
    );
    if (!row) throw new Error("No fully visible message anchor");
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
export async function end(page) {
  await history(page).hover();
  await page.mouse.wheel(
    0,
    await history(page).evaluate((element) => element.scrollHeight),
  );
  await settle(page);
  await expect
    .poll(() =>
      history(page).evaluate(
        (element) =>
          element.scrollHeight - element.scrollTop - element.clientHeight,
      ),
    )
    .toBeLessThan(4);
}
export async function open(page, app) {
  await page.goto(app.origin);
  await button(page, "Messages").first().click();
  await composer(page, "Alpha").waitFor();
  await expect(history(page).locator(rowSelector).first()).toBeVisible();
  await settle(page);
}
export async function upper(page) {
  await end(page);
  await history(page).hover();
  await page.mouse.wheel(0, -650);
  // Wheel dispatch is asynchronous; require actual movement before settling.
  await expect
    .poll(() =>
      history(page).evaluate(
        (element) =>
          element.scrollHeight - element.scrollTop - element.clientHeight,
      ),
    )
    .toBeGreaterThan(400);
  await settle(page);
  return anchor(page);
}
