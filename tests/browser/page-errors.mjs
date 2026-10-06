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

// Playwright converts every WebKit console message with source "javascript" and
// level "error" into a page error, and splits its text at the first colon
// ("Fetch API cannot load http" becomes the name). The stack's first line keeps
// the full text. Reports without a stack keep their name, for example
// "Unhandled Promise Rejection".
const errorText = (error) =>
  (error.stack ?? "").split("\n")[0] ||
  (error.name ? `${error.name}: ${error.message}` : error.message);

export function watchPageErrors(page) {
  const webkit = page.context().browser()?.browserType().name() === "webkit";
  const errors = [];
  // Access-control logs that the old document reported while the main frame
  // was navigating away (see `unexplained`).
  const leaving = new Set();
  const cancelled = [];
  // The main-frame navigation request that is replacing the current document.
  let navigation;
  page.on("pageerror", (error) => {
    errors.push(errorText(error));
    if (navigation) leaving.add(errors.length - 1);
  });
  if (webkit) {
    page.on("request", (request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame())
        navigation = request;
    });
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigation = undefined;
    });
    page.on("requestfailed", (request) => {
      if (request === navigation) navigation = undefined;
      if (cancellations.has(request.failure()?.errorText))
        cancelled.push(request.url());
    });
  }
  return {
    errors,
    unexplained() {
      if (!webkit) return [...errors];
      const unmatched = [...cancelled];
      return errors.filter((message, index) => {
        // A layout warning that WebKit reports as a page error.
        if (message === resizeObserverLoop) return false;
        // When a reload or navigation cancels a fetch, WebKit logs the fetch as
        // an access-control failure even though the caller handles the
        // rejection. An unhandled rejection is a separate page error named
        // "Unhandled Promise Rejection".
        const url = cancelledLoad.exec(message)?.[1];
        if (!url) return true;
        // A fetch that the old document starts after the main-frame navigation
        // request and before the new document commits is refused inside
        // fetch(). Playwright sees no request for it.
        if (leaving.has(index)) return false;
        // Otherwise accept the log only for a request that Playwright saw
        // cancelled, once per cancellation.
        const match = unmatched.indexOf(url);
        if (match < 0) return true;
        unmatched.splice(match, 1);
        return false;
      });
    },
  };
}
