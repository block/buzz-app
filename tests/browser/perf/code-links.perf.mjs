import { readFileSync } from "node:fs";
import { scrollCadence } from "./cadence.mjs";
import { test, expect, repeats, sidebar, timeline } from "./runner.mjs";

// GitHub's file API, answered from this checkout so code links cost only
// their drawing. Any path reads the file it names.
const root = new URL("../../../", import.meta.url);
async function answerGitHub(page) {
  await page.route("https://api.github.com/repos/**", (route) => {
    const path = decodeURIComponent(
      new URL(route.request().url()).pathname.split("/contents/")[1] ?? "",
    );
    try {
      return route.fulfill({ body: readFileSync(new URL(path, root)) });
    } catch {
      return route.fulfill({ status: 404 });
    }
  });
}

// PERF_PLAIN_LINKS=1 marks a build without the code viewer, such as main,
// where the links stay plain and there is nothing to wait for.
const plain = !!process.env.PERF_PLAIN_LINKS;

// Milliseconds until every code link in `scope` that is on screen shows
// highlighted code: each visible message with a code link holds a viewer whose
// shadow root has token colors. A plain-text placeholder does not count.
function highlighted(page, scope) {
  return page.evaluate(
    ({ scope, timeoutMs }) =>
      new Promise((resolve, reject) => {
        const started = performance.now();
        const inView = (element, box) => {
          const r = element.getBoundingClientRect();
          return r.bottom > box.top && r.top < box.bottom && r.height > 0;
        };
        const lit = (viewer) =>
          !!viewer
            ?.querySelector("diffs-container")
            ?.shadowRoot?.querySelector('[style*="--diffs-token"]');
        const check = () => {
          const area = document.querySelector(scope);
          if (!area) return false;
          // A viewer itself, such as the side panel's file.
          if (area.matches("section[aria-label]")) return lit(area);
          const box = area.getBoundingClientRect();
          const rows = [...area.querySelectorAll("[data-message-id]")].filter(
            (row) =>
              inView(row, box) &&
              /references\.ts:\d/.test(row.textContent ?? ""),
          );
          return (
            rows.length > 0 &&
            rows.every((row) =>
              lit(row.querySelector("section[aria-label], pre[aria-label]")),
            )
          );
        };
        const tick = () => {
          if (check()) return resolve(performance.now() - started);
          if (performance.now() - started > timeoutMs)
            return reject(new Error("Code links never finished highlighting"));
          requestAnimationFrame(tick);
        };
        tick();
      }),
    { scope, timeoutMs: 20_000 },
  );
}

// Short rows, every other one with a code link, so several share the screen.
const corpus = {
  codeLinkMessages: true,
  tallMessages: false,
  shortMessages: true,
};

test.describe("code-links-open-cold", () => {
  test.use({ historyCounts: { alpha: 1, beta: 120 }, ...corpus });
  for (let i = 1; i <= repeats; i++)
    test(`code-links-open-cold sample ${i}`, async ({ page, perf }) => {
      await answerGitHub(page);
      await perf.setup("alpha");
      let highlightedMs = 0;
      const sample = await perf.measure("beta", {
        click: sidebar("beta"),
        act: async () => {
          if (!plain) highlightedMs = await highlighted(page, timeline("beta"));
        },
        work: { mode: "cold" },
      });
      sample.metrics.highlightedMs = highlightedMs;
      await perf.save(sample);
      expect(sample.metrics.firstRowsMs).toBeGreaterThan(0);
    });
});

// The same channel again: the grammar and the file are already loaded.
test.describe("code-links-open-warm", () => {
  test.use({ historyCounts: { alpha: 1, beta: 120 }, ...corpus });
  for (let i = 1; i <= repeats; i++)
    test(`code-links-open-warm sample ${i}`, async ({ page, perf }) => {
      await answerGitHub(page);
      await perf.setup("beta");
      if (!plain) await highlighted(page, timeline("beta"));
      await perf.open("alpha");
      let highlightedMs = 0;
      const sample = await perf.measure("beta", {
        click: sidebar("beta"),
        act: async () => {
          if (!plain) highlightedMs = await highlighted(page, timeline("beta"));
        },
        work: { mode: "warm" },
      });
      sample.metrics.highlightedMs = highlightedMs;
      await perf.save(sample);
      expect(sample.metrics.firstRowsMs).toBeGreaterThan(0);
    });
});

// Reading up through history: frame gaps while code links scroll in.
test.describe("code-links-scroll", () => {
  // Plain links make short rows: a different gesture, not a reference.
  test.skip(plain, "Without the code viewer the rows are too short to compare");
  test.use({ historyCounts: { alpha: 240, beta: 1 }, ...corpus });
  for (let i = 1; i <= repeats; i++)
    test(`code-links-scroll sample ${i}`, async ({ page, perf }) => {
      await answerGitHub(page);
      await perf.setup("alpha");
      if (!plain) await highlighted(page, timeline("alpha"));
      await perf.settle("alpha");
      const distance = 2400;
      const scroller = page.locator(timeline("alpha"));
      expect(
        await scroller.evaluate((element) => element.scrollTop),
        "room for the complete gesture",
      ).toBeGreaterThan(distance);
      const point = await perf.gutter("alpha", "pointer");
      await perf.settle("alpha");
      let highlightedMs = 0;
      const sample = await perf.measure("alpha", {
        act: async () => {
          await perf.cdp.send("Input.synthesizeScrollGesture", {
            ...point,
            xDistance: 0,
            yDistance: distance,
            speed: 3000,
            gestureSourceType: "mouse",
            preventFling: true,
          });
          // After the gesture: how long the landing spot takes to color in.
          if (!plain)
            highlightedMs = await highlighted(page, timeline("alpha"));
        },
        work: { requestedPx: distance },
      });
      Object.assign(sample.metrics, scrollCadence(sample.recording));
      sample.metrics.highlightedMs = highlightedMs;
      await perf.save(sample);
      expect(sample.recording.wheels, "real wheel input").toBeGreaterThan(0);
    });
});

// A whole-file link opened in the side panel: a 2,753-line TypeScript file.
test.describe("code-links-panel-open", () => {
  test.skip(plain, "Without the code viewer a file link opens the browser");
  test.use({ historyCounts: { alpha: 1, beta: 1 } });
  const path = "src/features/messages/ChannelTimeline.tsx";
  for (let i = 1; i <= repeats; i++)
    test(`code-links-panel-open sample ${i}`, async ({ page, app, perf }) => {
      await answerGitHub(page);
      await perf.setup("alpha");
      app.append(
        "primary",
        "alpha",
        `The timeline: https://github.com/block/buzz-app/blob/main/${path}`,
      );
      const link = page
        .locator(timeline("alpha"))
        .getByRole("link", { name: /ChannelTimeline\.tsx/ });
      await expect(link).toBeVisible();
      await perf.settle("alpha");
      let highlightedMs = 0;
      const sample = await perf.measure("alpha", {
        click: `${timeline("alpha")} a[href*="ChannelTimeline.tsx"]`,
        act: async () => {
          highlightedMs = await highlighted(
            page,
            'section[aria-label$="ChannelTimeline.tsx"]',
          );
        },
        work: {
          lines: readFileSync(new URL(path, root), "utf8").split("\n").length,
        },
      });
      sample.metrics.highlightedMs = highlightedMs;
      await perf.save(sample);
    });
});
