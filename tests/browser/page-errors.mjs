// The only owner of Playwright `pageerror` collection for browser tests. A lint
// plugin (page-errors.grit) rejects other collectors.
//
// Every page error is kept as evidence in `errors`. `unexplained()` returns the
// errors that are not a known engine report; tests assert that it is empty.
// Add an engine report here only with evidence that the application did not
// throw or leave a rejection unhandled.

const resizeObserverLoop =
  "ResizeObserver loop completed with undelivered notifications.";
// WebKit's cancellation text for a request: Linux (CI), then macOS.
const cancellations = new Set(["Load request cancelled", "cancelled"]);
const cancelledLoad =
  /^Fetch API cannot load (\S+) due to access control checks\.$/;
// The sidebar read that a reload can interrupt without Playwright recording it.
const sidebarRead = "/api/relay/primary/sidebar-api";

// Playwright converts every WebKit console message with source "javascript" and
// level "error" into a page error, and splits its text at the first colon
// ("Fetch API cannot load http" becomes the name). The stack's first line keeps
// the full text. Reports without a stack keep their name, for example
// "Unhandled Promise Rejection".
const errorText = (error) =>
  (error.stack ?? "").split("\n")[0] ||
  (error.name ? `${error.name}: ${error.message}` : error.message);

const firstRequest = (request) => {
  while (request.redirectedFrom()) request = request.redirectedFrom();
  return request;
};

// The only reader of Playwright internals. Only the client frame's private
// `frame._eventEmitter` "navigated" event says whether a commit created a new
// document and which request it came from (`newDocument.request._object`, the
// public Request); the public "framenavigated" says neither. Checked against
// Playwright 1.63.0. Returns the first request of the navigation that committed
// a new document, or null for a same-document or failed commit or any other
// shape, which excuses nothing.
const committedNavigation = (event) => {
  if (!event?.newDocument || event.error) return null;
  let request = event.newDocument.request?._object;
  while (typeof request?.redirectedFrom === "function") {
    const previous = request.redirectedFrom();
    if (!previous) return request;
    request = previous;
  }
  return null;
};
const driftReport =
  'Playwright internal frame._eventEmitter "navigated" did not identify the ' +
  "main-frame navigation request (newDocument.request._object); the WebKit " +
  "reload allowance is off. See the @playwright/test upgrade note in " +
  "docs/contributing.md.";

export function watchPageErrors(page) {
  const webkit = page.context().browser()?.browserType().name() === "webkit";
  const errors = [];
  const cancelled = [];
  // A main-frame navigation in flight, keyed by its first request so redirects
  // stay on it. `held` is the index of the one sidebar-read log it may excuse.
  let navigation = null;
  const replaced = new Set();
  // The last main-frame navigation request whose new document the internal
  // event has not yet identified. If its document loads first, the internal
  // event has drifted.
  let unidentified = null;
  const drift = [];
  page.on("pageerror", (error) => {
    const text = errorText(error);
    if (navigation && cancelledLoad.exec(text)?.[1] === navigation.read)
      navigation.held ??= errors.length;
    errors.push(text);
  });
  if (webkit) {
    page.on("requestfailed", (request) => {
      if (cancellations.has(request.failure()?.errorText))
        cancelled.push(request.url());
    });
    page.on("request", (request) => {
      if (
        !request.isNavigationRequest() ||
        request.frame() !== page.mainFrame()
      )
        return;
      const first = firstRequest(request);
      unidentified = first;
      if (navigation?.first === first) return;
      // A new navigation supersedes the old one, which can excuse nothing.
      navigation = URL.canParse(sidebarRead, page.url())
        ? { first, read: new URL(sidebarRead, page.url()).href }
        : null;
    });
    page.mainFrame()._eventEmitter?.on?.("navigated", (event) => {
      const first = committedNavigation(event);
      if (first && first === unidentified) unidentified = null;
      if (first && first === navigation?.first && navigation.held !== undefined)
        replaced.add(navigation.held);
      // Any commit, same-document, failed or unrelated, closes the window.
      navigation = null;
    });
    page.on("domcontentloaded", () => {
      if (unidentified) drift.push(driftReport);
      unidentified = null;
    });
  }
  return {
    errors,
    unexplained() {
      if (!webkit) return [...errors];
      const unmatched = [...cancelled];
      const unexplained = errors.filter((message, index) => {
        // A layout warning that WebKit reports as a page error.
        if (message === resizeObserverLoop) return false;
        // When a reload or navigation cancels a fetch, WebKit logs the fetch as
        // an access-control failure even though the caller handles the
        // rejection. An unhandled rejection is a separate page error named
        // "Unhandled Promise Rejection". Accept the log only for a request that
        // Playwright saw cancelled, once per cancellation, including a log that
        // a replacement below also explains.
        const url = cancelledLoad.exec(message)?.[1];
        const match = url ? unmatched.indexOf(url) : -1;
        if (match >= 0) {
          unmatched.splice(match, 1);
          return false;
        }
        // The same log for the sidebar read of a document that a main-frame
        // navigation then replaced: logged after the navigation request and
        // before that same navigation committed a new document, once per
        // navigation. A genuine denial of that read in this interval is an
        // accepted blind spot. Ordering rests on WebKit sending the log before
        // the commit; Playwright only preserves the order it receives.
        return !replaced.has(index);
      });
      return [...drift, ...unexplained];
    },
  };
}
