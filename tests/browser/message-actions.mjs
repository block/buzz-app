import { expect } from "./playwright-test.mjs";

/** Both a closed toolbar and a hidden, anchored toolbar must neither paint nor hit. */
export const expectMessageActionsHidden = (actions) =>
  expect
    .poll(() =>
      actions.evaluate((bar) => {
        const style = getComputedStyle(bar);
        const rect = bar.getBoundingClientRect();
        return {
          painted:
            rect.width > 0 &&
            rect.height > 0 &&
            style.visibility !== "hidden" &&
            Number(style.opacity) > 0,
          takesPointer: bar.contains(
            document.elementFromPoint(
              rect.x + rect.width / 2,
              rect.y + rect.height / 2,
            ),
          ),
        };
      }),
    )
    .toEqual({ painted: false, takesPointer: false });

/** Reveal actions from visible message content, never its full-width row. */
export const hoverMessage = async (row) => {
  // Reactions live inside the bubble but intentionally do not open its toolbar.
  // Prefer painted prose so a growing reaction strip cannot become the target.
  const prose = row.locator("[data-message-action-anchor] p").first();
  const target = (await prose.count())
    ? prose
    : row
        .locator("[data-message-action-anchor], [data-message-attachments] > *")
        .first();
  await target.hover();
};

/** Open an exact thread through a real content link, independently of inline Reply. */
export const openThreadLink = async (page, app, id, channel = "alpha") => {
  const link = app.append(
    "primary",
    channel,
    `<buzz://message?channel=${channel}&id=${id}&thread=${id}>`,
    true,
    false,
  );
  const trigger = page
    .locator(`[data-channel-timeline] [data-message-id="${link.id}"]`)
    .getByRole("link");
  await trigger.click();
  await expect(
    page.getByRole("complementary", { name: "Thread", exact: true }),
  ).toBeVisible();
  return trigger;
};
