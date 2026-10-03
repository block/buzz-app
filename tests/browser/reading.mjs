import { sidebarJournals } from "./fixture.mjs";

// Hold real focus outside reading surfaces while a journey establishes unread
// state. Blur the target itself: the sidebar may still be inert while the search
// palette closes, so redirecting focus to a sidebar button is not reliable.
export async function holdReadingFocus(page) {
  await page.addInitScript(() => {
    const hold = ({ target }) => {
      if (
        target instanceof HTMLElement &&
        (target.closest("[data-channel-timeline], [data-reading-surface]") ||
          target.matches('[role="textbox"][aria-label^="Message #"]'))
      )
        target.blur();
    };
    document.addEventListener("focusin", hold);
    window.fixtureReleaseReadingFocus = () =>
      document.removeEventListener("focusin", hold);
  });
}

export async function releaseReadingFocus(page) {
  await page.evaluate(() => window.fixtureReleaseReadingFocus());
}

// Observe the real durable result, never seed state or call an engine test hook.
export async function readJournal(page) {
  const all = await sidebarJournals(page);
  return {
    pending: all.flatMap((journal) => journal.pending),
    manual: all.flatMap((journal) => journal.manual),
  };
}
