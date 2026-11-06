import { expect } from "./playwright-test.mjs";
import { frames } from "./timeline.mjs";

// A thread's virtual list mounts only the top-level replies near its viewport.
// These count what it holds, mounted or not: the rows rendered, plus one for
// each top-level reply it has not mounted (its items' aria-setsize less those
// mounted). Unmounted replies show no open branch, so each is one row.
const count = (history, scope) =>
  history.evaluate((history, scope) => {
    const rows = history.querySelector("[data-thread-rows]");
    const list = rows?.querySelector(":scope > ol");
    if (!rows || !list) return 0;
    const items = [...list.children];
    const size = Number(items[0]?.getAttribute("aria-setsize") ?? 0);
    const rendered = (scope === "replies" ? list : rows).querySelectorAll(
      "[data-message-id]",
    ).length;
    return rendered + size - items.length;
  }, scope);

/** The original and every reply the thread holds. */
export const threadMessageCount = (history) => count(history, "messages");
/** Every reply the thread holds, without the original. */
export const threadReplyCount = (history) => count(history, "replies");

/** Scroll the thread from its top, a viewport at a time, until `locator` is
 * mounted and Virtua accepts input again. Each step waits for the rendering
 * updates that carry the scroll to Virtua. Ends at the bottom if it never
 * mounts. */
export async function scrollUntilMounted(history, locator) {
  await history.evaluate((node) => {
    node.scrollTop = 0;
  });
  for (;;) {
    await frames(history.page(), 3);
    if (await locator.count()) {
      // Virtua resumes hit-testing once the scroll settles; act after.
      await expect(history.locator("[data-thread-rows] > ol")).toHaveCSS(
        "pointer-events",
        "auto",
      );
      return;
    }
    const moved = await history.evaluate((node) => {
      const end = node.scrollHeight - node.clientHeight;
      if (node.scrollTop >= end - 1) return false;
      node.scrollTop = Math.min(end, node.scrollTop + node.clientHeight);
      return true;
    });
    if (!moved) return;
  }
}
