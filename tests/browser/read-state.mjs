import { expect } from "@playwright/test";

// Read-state publication waits a five-second debounce (createReadState). The
// session reporting the message read is the barrier: its publication is now
// scheduled, so the controlled clock crosses the debounce. Install page.clock
// before the read and leave it running; the publication assertion stays with
// the caller.
export async function crossReadDebounce(page, channelId, messageId) {
  await expect
    .poll(
      () =>
        page.evaluate(
          ([channelId, messageId]) =>
            window.fixtureRelay
              .snapshot()
              .session.unread.attention(channelId, messageId).unread,
          [channelId, messageId],
        ),
      { message: "session records the message as read" },
    )
    .toBe(false);
  await page.clock.fastForward(5000);
}
