import { writeFile } from "node:fs/promises";
import { ALLOW_LATE_NAMES } from "../../src/features/relay/late-names.ts";
import { test, expect } from "./fixture.mjs";
import { settle } from "./timeline.mjs";
import { holdReadingFocus, markAllRead } from "./reading.mjs";

// A channel's first paint is final. From the first frame a channel's rows are in
// the DOM, no visible row may change its text, height or place on screen, no
// row may enter or leave the viewport, and no indicator drawn over the timeline (the New messages
// line, Jump to latest) may appear, move or leave. Every fact these journeys
// show was on the relay before the channel opened, so no later frame is
// excused by new data.
//
// Each open path runs with all reads prompt, then with one class of read held
// until well after the open: membership notices, author profiles or read
// state. A held read is released only once Alpha has painted, or once the open
// waits on it: on a held head read, or with its first screen held. So it lands
// either after the first paint or while that screen waits for it.
//
// One exemption, while the app allows late names (a temporary exception, see
// src/features/relay/late-names.ts): a name the first screen did not hold may
// replace its fallback label after the paint. Nothing else on that row may
// change. With late names off, the spec is strict.

const UNREAD = 4;

test.use({
  productionBroker: true,
  readState: true,
  membershipActivity: true,
  historyCounts: { alpha: 60, beta: 5 },
  viewport: { width: 1280, height: 800 },
});

const history = (page) =>
  page.getByRole("region", { name: "Channel message history" });
const sidebarRow = (page, name) =>
  page.getByRole("button", { name: new RegExp(`^${name}`) });
const composer = (page, name) =>
  page.getByRole("textbox", { name: `Message #${name}`, exact: true });

/** What the open timeline showed in each painted frame, kept only when it
 * changed. A frame is read after it paints: requestAnimationFrame runs before
 * the same frame's ResizeObserver corrections, so reading there can record a
 * state that never reaches the screen. */
function recorder() {
  const state = { frames: [], t0: 0, last: "" };
  window.firstPaint = state;
  const visibleRows = (scroller) => {
    const viewport = scroller.getBoundingClientRect();
    return [...scroller.querySelectorAll("[data-message-id]")].flatMap(
      (row) => {
        const box = row.getBoundingClientRect();
        if (box.height <= 0 || box.bottom <= viewport.top) return [];
        if (box.top >= viewport.bottom) return [];
        return [
          {
            id: row.dataset.messageId,
            top: Math.round(box.top - viewport.top),
            height: Math.round(box.height),
            notice: row.hasAttribute("data-membership-row"),
            text: row.innerText.replace(/\s+/g, " ").trim().slice(0, 160),
          },
        ];
      },
    );
  };
  const sample = () => {
    const timeline = document.querySelector("[data-channel-timeline]");
    const scroller = document.querySelector(
      '[aria-label="Channel message history"]',
    );
    // A timeline laid out hidden paints nothing yet.
    const shown = !!scroller && getComputedStyle(scroller).opacity !== "0";
    const line = shown
      ? scroller.querySelector("[data-new-messages-boundary]")
      : null;
    const viewportTop = scroller?.getBoundingClientRect().top ?? 0;
    const frame = {
      channel: timeline?.getAttribute("data-channel-timeline") ?? null,
      scrollTop: scroller ? Math.round(scroller.scrollTop) : null,
      rows: shown ? visibleRows(scroller) : [],
      line: line
        ? Math.round(line.getBoundingClientRect().top - viewportTop)
        : null,
      jump: shown && !!timeline?.hasAttribute("data-jump-visible"),
    };
    const key = JSON.stringify(frame);
    if (key !== state.last) {
      state.last = key;
      state.frames.push({
        t: Math.round(performance.now() - state.t0),
        ...frame,
      });
      if (state.frames.length > 4000) state.frames.splice(0, 1000);
    }
  };
  // A task posted from a frame's callbacks runs after that frame paints.
  const painted = new MessageChannel();
  painted.port1.onmessage = sample;
  const tick = () => {
    painted.port2.postMessage(null);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** Whether a row went from `before` to `after` only by names replacing its
 * fallback identity labels: the only change `ALLOW_LATE_NAMES` lets through.
 * `before` shows a fallback (`npub…xyz`, or the directory's 10-character key
 * prefix), and every word of it except fallbacks and avatar initials is still
 * in `after`, in order. Height and place stay strict. */
function lateName(before, after) {
  const fallback = /^(npub…[0-9a-z]+|[0-9a-f]{10})$/;
  const words = before.split(" ");
  if (!words.some((word) => fallback.test(word))) return false;
  const kept = after.split(" ");
  let at = 0;
  for (const word of words) {
    if (fallback.test(word) || [...word].length === 1) continue;
    at = kept.indexOf(word, at);
    if (at < 0) return false;
    at++;
  }
  return true;
}

/** Changes after the channel's first painted frame, first of each kind. */
function violations(frames, channel, { noticeNames }) {
  const first = frames.findIndex(
    (frame) => frame.t >= 0 && frame.channel === channel && frame.rows.length,
  );
  if (first < 0) return { firstPaintMs: null, changes: ["never painted"] };
  const base = frames[first];
  const byId = new Map(base.rows.map((row) => [row.id, row]));
  const found = new Map();
  const note = (kind, t, detail) => {
    if (!found.has(kind))
      found.set(kind, `${kind} at +${t - base.t}ms: ${detail}`);
  };
  for (const frame of frames.slice(first + 1)) {
    if (frame.channel !== channel) {
      note("left", frame.t, `timeline became ${frame.channel}`);
      break;
    }
    if (
      (frame.line === null) !== (base.line === null) ||
      Math.abs(frame.line - base.line) > 1
    )
      note("line", frame.t, `New messages line ${base.line} → ${frame.line}`);
    if (frame.jump !== base.jump)
      note("jump", frame.t, `Jump to latest ${base.jump} → ${frame.jump}`);
    const ids = frame.rows.map((row) => row.id);
    const added = ids.filter((id) => !byId.has(id));
    const removed = base.rows.filter((row) => !ids.includes(row.id));
    if (added.length || removed.length)
      note("rows", frame.t, `+${added.length} −${removed.length} visible rows`);
    for (const row of frame.rows) {
      const was = byId.get(row.id);
      if (!was) continue;
      // scrollTop alone is not visible: the virtualizer moves it when it
      // measures rows above the viewport, without moving what is on screen.
      if (Math.abs(was.top - row.top) > 1)
        note(
          "move",
          frame.t,
          `${row.id.slice(0, 8)} top ${was.top} → ${row.top}px`,
        );
      if (Math.abs(was.height - row.height) > 1)
        note(
          "height",
          frame.t,
          `${row.id.slice(0, 8)} ${was.height} → ${row.height}px`,
        );
      if (
        was.text !== row.text &&
        (noticeNames || !row.notice) &&
        !(ALLOW_LATE_NAMES && lateName(was.text, row.text))
      )
        note(
          "text",
          frame.t,
          `${row.id.slice(0, 8)} "${was.text.slice(0, 40)}" → "${row.text.slice(0, 40)}"`,
        );
    }
  }
  return {
    firstPaintMs: base.t,
    changes: [...found.values()],
    lineAtEnd: frames.at(-1)?.line !== null,
  };
}

const isAlphaHead = (filter) =>
  filter.kinds?.includes(9) &&
  filter.top_level === true &&
  filter["#h"]?.includes("alpha") &&
  filter.until === undefined;

const holds = {
  none: () => false,
  // Membership notices are read beside the head; holding them holds that read.
  notices: (filters) =>
    filters.some((f) => f.kinds?.includes(40099) && f["#h"]?.includes("alpha")),
  profiles: (filters, viewer) =>
    filters.some(
      (f) => f.kinds?.includes(0) && f.authors?.some((id) => id !== viewer),
    ),
  // Alpha's head reads, the open's and any catch-up's.
  head: (filters) => filters.some(isAlphaHead),
  readState: (filters) =>
    filters.some(
      (f) =>
        f.kinds?.includes(30078) &&
        (f.read_state_snapshot === 1 ||
          f["#t"]?.some((t) => t.startsWith("read-state"))),
    ),
};

/** Held reads wait from `arm` until `release`. Alpha head reads are timed from
 * `arm`; `idle` waits until every read that is not held has answered. */
async function instrument(page, app, held) {
  let gate;
  let armedAt = 0;
  const requests = [];
  // Reads that are not held, from submission until the page has the answer.
  const inflight = new Set();
  const done = (request) => inflight.delete(request);
  page.on("request", (request) => {
    if (!request.url().endsWith("/query")) return;
    const filters = request.postDataJSON() ?? [];
    // The relay holds older pages, such as the read-ahead after an open,
    // until a test releases them; they are not part of the first screen.
    const older = filters.some((f) => f.until !== undefined);
    if (!older && (!gate || !holds[held](filters, app.viewer)))
      inflight.add(request);
    if (armedAt && filters.some(isAlphaHead))
      requests.push({
        t: Date.now() - armedAt,
        priority: request.headers()["x-buzz-read-priority"] ?? "?",
      });
  });
  page.on("requestfinished", done);
  page.on("requestfailed", done);
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) inflight.clear();
  });
  let heldHeads = 0;
  await page.route("**/query", async (route) => {
    const waiting = gate;
    const filters = route.request().postDataJSON() ?? [];
    if (waiting && holds[held](filters, app.viewer)) {
      const head = filters.some(isAlphaHead);
      if (head) heldHeads++;
      await waiting.promise;
      if (head) heldHeads--;
    }
    await route.fallback().catch(() => {});
  });
  return {
    requests,
    /** Alpha head reads waiting at the gate. */
    holding: () => heldHeads,
    arm() {
      armedAt = Date.now();
      gate = held === "none" ? undefined : Promise.withResolvers();
    },
    /** Release once Alpha has painted rows, or once its open is waiting on
     * a held read: a held head read, or a timeline that holds its first
     * screen (callers have seen Alpha's composer). */
    async release() {
      await expect
        .poll(
          async () =>
            heldHeads > 0 ||
            (await page.evaluate(
              () =>
                !!document.querySelector(
                  '[data-channel-timeline="alpha"][data-first-screen="pending"]',
                ) ||
                window.firstPaint.frames.some(
                  (frame) => frame.channel === "alpha" && frame.rows.length > 0,
                ),
            )),
          { intervals: [16] },
        )
        .toBe(true);
      gate?.resolve();
    },
    async idle(scroller = history(page)) {
      await expect.poll(() => inflight.size).toBe(0);
      await settle(page, scroller);
      await expect.poll(() => inflight.size).toBe(0);
    },
  };
}

/** Alpha's saved head holds its newest row and the names of its authors. */
function savedHead(page, newestId) {
  return page.evaluate(
    (newestId) =>
      new Promise((resolve) => {
        const request = indexedDB.open("buzz-channel-heads-v1");
        request.onerror = () => resolve(false);
        request.onsuccess = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains("heads")) {
            db.close();
            return resolve(false);
          }
          const read = db
            .transaction("heads", "readonly")
            .objectStore("heads")
            .getAll();
          read.onsuccess = () => {
            db.close();
            resolve(
              read.result.some(
                (row) =>
                  row.channelId === "alpha" &&
                  row.profiles?.length > 0 &&
                  row.events?.some((event) => event.id === newestId),
              ),
            );
          };
          read.onerror = () => {
            db.close();
            resolve(false);
          };
        };
      }),
    newestId,
  );
}

const unread = (app, content, deliver, createdAt) =>
  app.append(
    "primary",
    "alpha",
    content,
    deliver,
    false,
    undefined,
    undefined,
    [],
    createdAt ?? Math.floor(Date.now() / 1000) + 10,
  );

/** Alpha has history read through Mark all as read, then unread rows that
 * arrive while Beta is open, so opening it draws a New messages line. Reading
 * stays held so nothing reads Alpha's rows by being on screen. */
async function seed(page, app) {
  await holdReadingFocus(page);
  await page.addInitScript(recorder);
  await page.addInitScript(() => {
    // A path moves the clock past a head's freshness lease (`FRESH_FOR`).
    const real = Date.now;
    window.clockSkew = 0;
    Date.now = () => real() + window.clockSkew;
  });
  await page.addInitScript(() => {
    // `saveData` switches off background warming and hover preparation. It
    // stays on until a path turns it off, so nothing reads Alpha early.
    window.fixtureSaveData = true;
    Object.defineProperty(Navigator.prototype, "connection", {
      configurable: true,
      get: () => ({ saveData: window.fixtureSaveData }),
    });
  });
  await page.goto(
    `${app.origin}/#buzz=${encodeURIComponent(
      JSON.stringify({
        version: 1,
        kind: "conversation",
        channelId: "beta",
        scope: {
          viewer: app.viewer,
          communityOrigin: "https://primary.example",
        },
      }),
    )}`,
  );
  await expect(composer(page, "Beta")).toBeVisible();
  await expect(
    history(page).locator("[data-message-id]").first(),
  ).toBeVisible();
  await settle(page);
  const published = app.report.readPublications.length;
  await markAllRead(page);
  await expect
    .poll(() => app.report.readPublications.length)
    .toBeGreaterThan(published);
  // Newer than the read mark, which is the time it was made.
  const now = Math.floor(Date.now() / 1000) + 1;
  let newest;
  for (let i = 0; i < UNREAD; i++)
    newest = unread(app, `Unread follow-up ${i}`, true, now + i);
  await expect(
    sidebarRow(page, "Alpha").locator("[data-channel-unread]"),
  ).toHaveCount(1);
  return newest;
}

/** Reload on Beta. Alpha was never read, so nothing of it is saved. */
async function reloadOnBeta(page) {
  await page.reload();
  await expect(composer(page, "Beta")).toBeVisible();
  await expect(
    history(page).locator("[data-message-id]").first(),
  ).toBeVisible();
  await settle(page);
}

async function clickOpen(page, name) {
  await sidebarRow(page, name).evaluate((button) => {
    window.firstPaint.t0 = performance.now();
    window.firstPaint.frames.length = 0;
    window.firstPaint.last = "";
    button.click();
  });
}

const paths = {
  async cold(page, _app, gates) {
    gates.arm();
    await reloadOnBeta(page);
    expect(
      gates.requests,
      "nothing read Alpha's head before the click",
    ).toEqual([]);
    await clickOpen(page, "Alpha");
  },
  async hover(page, _app, gates) {
    gates.arm();
    await reloadOnBeta(page);
    expect(
      gates.requests,
      "nothing read Alpha's head before the hover",
    ).toEqual([]);
    await page.evaluate(() => {
      window.fixtureSaveData = false;
    });
    await sidebarRow(page, "Alpha").hover();
    await expect.poll(() => gates.requests.length).toBe(1);
    await gates.idle();
    await clickOpen(page, "Alpha");
  },
  // The app shell turns roster warming off (service.ts `warm: false`), so a
  // head read before the first visit comes only from a hover. A revisit
  // adopts the head the first visit left in memory.
  async revisit(page, _app, gates) {
    gates.arm();
    await sidebarRow(page, "Alpha").click();
    await expect(composer(page, "Alpha")).toBeVisible();
    await gates.release();
    await gates.idle();
    await sidebarRow(page, "Beta").click();
    await expect(composer(page, "Beta")).toBeVisible();
    await gates.idle();
    gates.arm();
    await clickOpen(page, "Alpha");
  },
  // Past the head's freshness lease the revisit re-reads it. The window
  // followed the stream meanwhile, so the first screen does not wait for it.
  async lateRevisit(page, _app, gates) {
    gates.arm();
    await sidebarRow(page, "Alpha").click();
    await expect(composer(page, "Alpha")).toBeVisible();
    await gates.release();
    await gates.idle();
    await sidebarRow(page, "Beta").click();
    await expect(composer(page, "Beta")).toBeVisible();
    await gates.idle();
    await page.evaluate(() => {
      window.clockSkew += 61_000;
    });
    gates.arm();
    await clickOpen(page, "Alpha");
  },
  async saved(page, _app, gates, newest) {
    // Alpha's head is saved on screen; the reload reopens Alpha from it.
    await sidebarRow(page, "Alpha").click();
    await expect(composer(page, "Alpha")).toBeVisible();
    await expect.poll(() => savedHead(page, newest.id)).toBe(true);
    gates.arm();
    await page.reload();
  },
  async reconnect(page, app, gates, _newest, held) {
    // Alpha's head is retained; while Beta is open the stream drops and more
    // unread rows land that only the reconnect's catch-up can read.
    await sidebarRow(page, "Alpha").click();
    await expect(composer(page, "Alpha")).toBeVisible();
    await settle(page);
    await sidebarRow(page, "Beta").click();
    await expect(composer(page, "Beta")).toBeVisible();
    gates.arm();
    const before = new Set(app.relay.sockets);
    app.relay.disconnect("primary");
    unread(app, "Missed while offline", false);
    await expect
      .poll(() =>
        app.relay.sockets.some(
          (socket) =>
            !before.has(socket) &&
            socket.community === "primary" &&
            socket.readyState === 1 &&
            socket.authenticated,
        ),
      )
      .toBe(true);
    // The catch-up reads Alpha's retained head in the background. While the
    // reconnect's profile or read-state reads are held, it does not start, so
    // those journeys open on the stale head and wait for the catch-up.
    if (held === "none" || held === "notices")
      await expect.poll(() => gates.requests.length).toBeGreaterThan(0);
    await gates.idle();
    await clickOpen(page, "Alpha");
  },
};

for (const path of Object.keys(paths))
  for (const held of Object.keys(holds).filter((held) => held !== "head"))
    test(`${path} open, ${held === "none" ? "prompt reads" : `held ${held}`}: first paint is final`, async ({
      page,
      app,
    }, testInfo) => {
      const newest = await seed(page, app);
      const gates = await instrument(page, app, held);
      await paths[path](page, app, gates, newest, held);
      await expect(composer(page, "Alpha")).toBeVisible();
      await gates.release();
      await expect(
        history(page).locator("[data-message-id]").first(),
      ).toBeVisible();
      await gates.idle();
      const frames = await page.evaluate(() => window.firstPaint.frames);
      // A notice row's names are read only after its head lands, so with
      // prompt profiles they race the first paint. The held-profiles case
      // decides that race; the others leave notice names out of scope.
      const result = violations(frames, "alpha", {
        noticeNames: held === "profiles",
      });
      const report = testInfo.outputPath("first-paint.json");
      await writeFile(
        report,
        JSON.stringify(
          { path, held, ...result, headReads: gates.requests, frames },
          null,
          1,
        ),
      );
      await testInfo.attach("first-paint.json", {
        path: report,
        contentType: "application/json",
      });
      // Read state never holds the screen, and every path holds read state
      // that places the line with it: the fresh snapshot, or before it lands
      // the saved copy after a reload or what a drop interrupted. The line is
      // never moved afterward (`changes`).
      expect(result.lineAtEnd, "the open draws a New messages line").toBe(true);
      expect(result.changes).toEqual([]);
    });

/** The first frame that painted Alpha's rows. */
const firstAlphaPaint = (frames) =>
  frames.find((frame) => frame.channel === "alpha" && frame.rows.length);

async function finalPaint(page, testInfo, name, extra = {}) {
  const frames = await page.evaluate(() => window.firstPaint.frames);
  const result = violations(frames, "alpha", { noticeNames: true });
  const report = testInfo.outputPath(`${name}.json`);
  await writeFile(
    report,
    JSON.stringify({ ...result, ...extra, frames }, null, 1),
  );
  await testInfo.attach(`${name}.json`, {
    path: report,
    contentType: "application/json",
  });
  return { frames, result };
}

// Rows saved to disk or kept across a drop are not current. The open gathers
// a fresh head and paints once: no kept row shows while that read is out, and
// the first paint already has what arrived while the app was closed or the
// stream was down.
const freshOpens = {
  async reload(page, app, gates, newest) {
    await sidebarRow(page, "Alpha").click();
    await expect(composer(page, "Alpha")).toBeVisible();
    await expect.poll(() => savedHead(page, newest.id)).toBe(true);
    unread(app, "Sent while the app was closed", false);
    gates.arm();
    await page.reload();
    return "Sent while the app was closed";
  },
  async reconnect(page, app, gates) {
    await sidebarRow(page, "Alpha").click();
    await expect(composer(page, "Alpha")).toBeVisible();
    await settle(page);
    await sidebarRow(page, "Beta").click();
    await expect(composer(page, "Beta")).toBeVisible();
    await gates.idle();
    gates.arm();
    const before = new Set(app.relay.sockets);
    app.relay.disconnect("primary");
    unread(app, "Missed while offline", false);
    await expect
      .poll(() =>
        app.relay.sockets.some(
          (socket) =>
            !before.has(socket) &&
            socket.community === "primary" &&
            socket.readyState === 1 &&
            socket.authenticated,
        ),
      )
      .toBe(true);
    await clickOpen(page, "Alpha");
    return "Missed while offline";
  },
};
// The resume session's offline fallback (3 s) is for when no connection
// comes up. While connected, a slow fresh head is a longer wait, never the
// kept rows first.
const OFFLINE_AFTER_MS = 3_000;
for (const [path, held] of [
  ["reload", 500],
  ["reconnect", 500],
  ["reload", OFFLINE_AFTER_MS + 500],
])
  test(`${path} open${held > OFFLINE_AFTER_MS ? ", its head held past the offline fallback," : ""} paints a fresh head once, never its kept rows`, async ({
    page,
    app,
  }, testInfo) => {
    const newest = await seed(page, app);
    const gates = await instrument(page, app, "head");
    const missed = await freshOpens[path](page, app, gates, newest);
    await expect(composer(page, "Alpha")).toBeVisible();
    // The open's head read is out, and nothing of Alpha has painted.
    await expect.poll(() => gates.holding()).toBeGreaterThan(0);
    await page.evaluate(
      (held) => new Promise((resolve) => setTimeout(resolve, held)),
      held,
    );
    expect(
      firstAlphaPaint(await page.evaluate(() => window.firstPaint.frames)),
      "kept rows painted before the fresh head",
    ).toBeUndefined();
    await gates.release();
    await expect(history(page).getByText(missed)).toBeVisible();
    await gates.idle();
    const { frames, result } = await finalPaint(page, testInfo, "fresh-open");
    expect(
      firstAlphaPaint(frames).rows.some((row) => row.text.includes(missed)),
      "the first paint has what arrived while Alpha was not followed",
    ).toBe(true);
    expect(result.lineAtEnd, "the open draws a New messages line").toBe(true);
    expect(result.changes).toEqual([]);
  });

// A message the live stream delivered while Alpha was closed is in its first
// screen: the window the stream kept current, or the kept head and the tail
// of what arrived since, make a memory open that reads nothing.
test.describe("memory open after a live arrival", () => {
  test.use({ channelIds: ["alpha", "beta", "gamma", "delta"] });
  for (const kept of ["window", "head"])
    test(`${kept} kept: the first paint has the arrival, with no head read`, async ({
      page,
      app,
    }, testInfo) => {
      await seed(page, app);
      const gates = await instrument(page, app, "head");
      await sidebarRow(page, "Alpha").click();
      await expect(composer(page, "Alpha")).toBeVisible();
      await settle(page);
      // Three other windows evict Alpha's; its head and tail stay.
      for (const name of kept === "head"
        ? ["Beta", "gamma", "delta"]
        : ["Beta"]) {
        await sidebarRow(page, name).click();
        await expect(composer(page, name)).toBeVisible();
      }
      await gates.idle();
      const arrival = "Arrived while Alpha was closed";
      unread(app, arrival, true);
      // The stream delivers it to the session, not to an open timeline.
      await page.evaluate(
        () => new Promise((resolve) => setTimeout(resolve, 500)),
      );
      gates.arm();
      await clickOpen(page, "Alpha");
      await expect(composer(page, "Alpha")).toBeVisible();
      await expect(history(page).getByText(arrival)).toBeVisible();
      await gates.release();
      await gates.idle();
      const { frames, result } = await finalPaint(
        page,
        testInfo,
        "memory-open",
        {
          headReads: gates.requests,
        },
      );
      expect(
        firstAlphaPaint(frames).rows.some((row) => row.text.includes(arrival)),
        "the first paint has the live arrival",
      ).toBe(true);
      expect(gates.requests, "a memory open reads no head").toEqual([]);
      expect(result.changes).toEqual([]);
    });
});
