import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { watchPageErrors } from "../browser/page-errors.mjs";

// A Playwright page reduced to the events and browser identity the watcher reads.
const fakePage = (engine, url = "http://127.0.0.1:43347/#buzz=home") => {
  const page = new EventEmitter();
  const mainFrame = { _eventEmitter: new EventEmitter() };
  page.context = () => ({
    browser: () => ({ browserType: () => ({ name: () => engine }) }),
  });
  page.mainFrame = () => mainFrame;
  page.url = () => url;
  return page;
};
const pageError = ({ name, message, stack }) =>
  Object.assign(new Error(message), { name, stack });
const cancel = (page, url, errorText = "Load request cancelled") =>
  page.emit("requestfailed", {
    url: () => url,
    failure: () => ({ errorText }),
  });

const query = "http://127.0.0.1:43347/api/relay/primary/query";
// Replayed from the Linux WebKit trace of navigation-repairs.spec.mjs:89 on main
// (run for 85d6bf82): Playwright split the console text at its first colon.
const reloadCancelLog = (url = query) =>
  pageError({
    name: "Fetch API cannot load http",
    message: `${url.slice("http:/".length)} due to access control checks.`,
    stack: `Fetch API cannot load ${url} due to access control checks.\n    at query (http://127.0.0.1:43347/assets/index.js:141:28966)`,
  });
const resizeObserverLoop = () =>
  pageError({
    name: "",
    message: "ResizeObserver loop completed with undelivered notifications.",
    stack: "",
  });

test("WebKit's log for a fetch the reload cancelled is kept as evidence but explained", () => {
  const page = fakePage("webkit");
  const watched = watchPageErrors(page);
  cancel(page, query);
  page.emit("pageerror", reloadCancelLog());
  assert.deepEqual(watched.errors, [
    `Fetch API cannot load ${query} due to access control checks.`,
  ]);
  assert.deepEqual(watched.unexplained(), []);
});

test("macOS WebKit's cancellation text is also a cancellation", () => {
  const page = fakePage("webkit");
  const watched = watchPageErrors(page);
  cancel(page, query, "cancelled");
  page.emit("pageerror", reloadCancelLog());
  assert.deepEqual(watched.unexplained(), []);
});

test("the access-control log fails without a matching cancelled request", () => {
  for (const setup of [
    () => {},
    (page) => cancel(page, "http://127.0.0.1:43347/api/relay/primary/session"),
    (page) => cancel(page, query, "Could not connect to the server."),
  ]) {
    const page = fakePage("webkit");
    const watched = watchPageErrors(page);
    setup(page);
    page.emit("pageerror", reloadCancelLog());
    assert.equal(watched.unexplained().length, 1);
  }
});

test("one cancellation explains one log", () => {
  const page = fakePage("webkit");
  const watched = watchPageErrors(page);
  cancel(page, query);
  page.emit("pageerror", reloadCancelLog());
  page.emit("pageerror", reloadCancelLog());
  assert.equal(watched.unexplained().length, 1);
});

test("an unhandled rejection is never an engine report", () => {
  const page = fakePage("webkit");
  const watched = watchPageErrors(page);
  cancel(page, query);
  page.emit(
    "pageerror",
    pageError({
      name: "Unhandled Promise Rejection",
      message: "TypeError: Load failed",
      stack: "",
    }),
  );
  assert.deepEqual(watched.unexplained(), [
    "Unhandled Promise Rejection: TypeError: Load failed",
  ]);
});

test("engine reports are WebKit-only", () => {
  const page = fakePage("chromium");
  const watched = watchPageErrors(page);
  cancel(page, query);
  page.emit("pageerror", reloadCancelLog());
  page.emit("pageerror", resizeObserverLoop());
  assert.equal(watched.unexplained().length, 2);
  const webkit = fakePage("webkit");
  const watchedWebkit = watchPageErrors(webkit);
  webkit.emit("pageerror", resizeObserverLoop());
  assert.deepEqual(watchedWebkit.unexplained(), []);
  assert.equal(watchedWebkit.errors.length, 1);
});

test("an application error keeps its name", () => {
  const page = fakePage("webkit");
  const watched = watchPageErrors(page);
  page.emit("pageerror", new TypeError("a: b"));
  assert.deepEqual(watched.unexplained(), ["TypeError: a: b"]);
});

const sidebar = "http://127.0.0.1:43347/api/relay/primary/sidebar-api";
const navigationRequest = (page, redirectedFrom = null) => {
  const request = {
    isNavigationRequest: () => true,
    frame: () => page.mainFrame(),
    redirectedFrom: () => redirectedFrom,
  };
  page.emit("request", request);
  return request;
};
// Playwright's internal frame event, as the client receives it.
const commit = (page, request, extra = {}) =>
  page.mainFrame()._eventEmitter.emit("navigated", {
    url: "http://127.0.0.1:43347/",
    newDocument: { request: request && { _object: request } },
    ...extra,
  });

test("a sidebar-read log is explained once its navigation commits a new document", () => {
  const page = fakePage("webkit");
  const watched = watchPageErrors(page);
  const reload = navigationRequest(page);
  // Neither a fetch nor a child frame's navigation is the main-frame navigation.
  page.emit("request", {
    isNavigationRequest: () => false,
    frame: () => page.mainFrame(),
  });
  page.emit("request", { isNavigationRequest: () => true, frame: () => ({}) });
  page.emit("pageerror", reloadCancelLog(sidebar));
  commit(page, reload);
  assert.equal(watched.errors.length, 1);
  assert.deepEqual(watched.unexplained(), []);
});

test("a redirect stays on its navigation", () => {
  const page = fakePage("webkit");
  const watched = watchPageErrors(page);
  const reload = navigationRequest(page);
  page.emit("pageerror", reloadCancelLog(sidebar));
  commit(page, navigationRequest(page, reload));
  assert.deepEqual(watched.unexplained(), []);
});

test("a log that a cancellation and a replacement both explain spends the cancellation", () => {
  const page = fakePage("webkit");
  const watched = watchPageErrors(page);
  const reload = navigationRequest(page);
  cancel(page, sidebar);
  page.emit("pageerror", reloadCancelLog(sidebar));
  page.emit("pageerror", reloadCancelLog(sidebar));
  commit(page, reload);
  assert.equal(watched.unexplained().length, 1);
});

test("an unexpected shape of Playwright's internal event excuses nothing", () => {
  const shapes = {
    "newDocument without request": { newDocument: {} },
    "request without _object": { newDocument: { request: {} } },
    "_object that is not a Request": {
      newDocument: { request: { _object: {} } },
    },
    "_object that is a string": { newDocument: { request: { _object: "x" } } },
  };
  for (const [name, event] of Object.entries(shapes)) {
    const page = fakePage("webkit");
    const watched = watchPageErrors(page);
    navigationRequest(page);
    page.emit("pageerror", reloadCancelLog(sidebar));
    page.mainFrame()._eventEmitter.emit("navigated", event);
    assert.equal(watched.unexplained().length, 1, name);
  }
});

test("a sidebar-read log outside a confirmed replacement window fails", () => {
  const cases = {
    "logged before any navigation": (page) => {
      page.emit("pageerror", reloadCancelLog(sidebar));
      commit(page, navigationRequest(page));
    },
    "navigation never commits": (page) => {
      navigationRequest(page);
      page.emit("pageerror", reloadCancelLog(sidebar));
    },
    "logged after the commit": (page) => {
      const reload = navigationRequest(page);
      commit(page, reload);
      page.emit("pageerror", reloadCancelLog(sidebar));
    },
    "navigation fails": (page) => {
      const reload = navigationRequest(page);
      page.emit("pageerror", reloadCancelLog(sidebar));
      commit(page, reload, { error: "net::ERR_ABORTED" });
    },
    "a superseding navigation commits": (page) => {
      navigationRequest(page);
      page.emit("pageerror", reloadCancelLog(sidebar));
      commit(page, navigationRequest(page));
    },
    "an unrelated navigation commits": (page) => {
      navigationRequest(page);
      page.emit("pageerror", reloadCancelLog(sidebar));
      commit(page, { redirectedFrom: () => null });
    },
    "a same-document navigation comes first": (page) => {
      const reload = navigationRequest(page);
      page.emit("pageerror", reloadCancelLog(sidebar));
      page.mainFrame()._eventEmitter.emit("navigated", { url: "#buzz=x" });
      commit(page, reload);
    },
    "a different URL": (page) => {
      const reload = navigationRequest(page);
      page.emit("pageerror", reloadCancelLog(query));
      commit(page, reload);
    },
  };
  for (const [name, run] of Object.entries(cases)) {
    const page = fakePage("webkit");
    const watched = watchPageErrors(page);
    run(page);
    assert.equal(watched.unexplained().length, 1, name);
  }
});

test("one replacement window explains one log", () => {
  const page = fakePage("webkit");
  const watched = watchPageErrors(page);
  const reload = navigationRequest(page);
  page.emit("pageerror", reloadCancelLog(sidebar));
  page.emit("pageerror", reloadCancelLog(sidebar));
  commit(page, reload);
  assert.equal(watched.unexplained().length, 1);
});

test("a replacement window never explains an unhandled rejection", () => {
  const page = fakePage("webkit");
  const watched = watchPageErrors(page);
  const reload = navigationRequest(page);
  page.emit(
    "pageerror",
    pageError({
      name: "Unhandled Promise Rejection",
      message: "TypeError: Load failed",
      stack: "",
    }),
  );
  commit(page, reload);
  assert.deepEqual(watched.unexplained(), [
    "Unhandled Promise Rejection: TypeError: Load failed",
  ]);
});

const drift =
  'Playwright internal frame._eventEmitter "navigated" did not identify the ' +
  "main-frame navigation request (newDocument.request._object); the WebKit " +
  "reload allowance is off. See the @playwright/test upgrade note in " +
  "docs/contributing.md.";

test("a navigation whose new document Playwright's internal event identifies reports nothing", () => {
  const page = fakePage("webkit");
  const watched = watchPageErrors(page);
  const reload = navigationRequest(page);
  page.mainFrame()._eventEmitter.emit("navigated", { url: "#buzz=x" });
  commit(page, navigationRequest(page, reload));
  page.emit("domcontentloaded", page);
  // A superseded navigation is not drift.
  navigationRequest(page);
  commit(page, navigationRequest(page));
  page.emit("domcontentloaded", page);
  // A navigation that never loads a document (a download, a 204) is not drift.
  navigationRequest(page);
  assert.deepEqual(watched.unexplained(), []);
});

test("a document that loads without Playwright's internal identity names the internal", () => {
  const cases = {
    "no navigated event": () => {},
    "no newDocument": (page) =>
      page.mainFrame()._eventEmitter.emit("navigated", { url: "/" }),
    "no request": (page) => commit(page, null),
    "an unexpected request": (page, reload) =>
      commit(page, { ...reload, redirectedFrom: undefined }),
    "another navigation": (page) =>
      commit(page, { redirectedFrom: () => null }),
  };
  for (const [name, run] of Object.entries(cases)) {
    const page = fakePage("webkit");
    const watched = watchPageErrors(page);
    run(page, navigationRequest(page));
    page.emit("domcontentloaded", page);
    // Reported once per navigation.
    page.emit("domcontentloaded", page);
    assert.deepEqual(watched.unexplained(), [drift], name);
  }
  const page = fakePage("webkit");
  page.mainFrame()._eventEmitter = undefined;
  const watched = watchPageErrors(page);
  navigationRequest(page);
  page.emit("domcontentloaded", page);
  assert.deepEqual(watched.unexplained(), [drift], "no internal emitter");
});
