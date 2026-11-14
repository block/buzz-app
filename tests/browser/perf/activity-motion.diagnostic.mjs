import { test, expect } from "../fixture.mjs";
import { writeFile } from "node:fs/promises";

test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  historyCounts: { alpha: 40, beta: 1 },
});

// Optional attribution pass. Trace costs are diagnostic; tracing changes timing.
async function trace(page) {
  const session = await page.context().newCDPSession(page);
  await session.send("Tracing.start", {
    categories: "devtools.timeline,v8,blink.user_timing",
    transferMode: "ReturnAsStream",
  });
  let ended = false;
  return {
    async finish() {
      const completed = new Promise((resolve) =>
        session.once("Tracing.tracingComplete", resolve),
      );
      await session.send("Tracing.end");
      const { stream } = await completed;
      ended = true;
      let json = "";
      let eof = false;
      while (!eof) {
        const chunk = await session.send("IO.read", { handle: stream });
        json += chunk.data;
        eof = chunk.eof;
      }
      await session.send("IO.close", { handle: stream });
      const events = JSON.parse(json).traceEvents;
      const start = events.find(
        (event) => event.name === "activity-motion-input",
      );
      const end = events.find(
        (event) => event.name === "activity-motion-settled",
      );
      if (!start || !end)
        throw new Error("Missing input/settled trace boundary");
      // Union nested events so a function inside EventDispatch is counted once.
      // Script is inclusive of synchronous rendering; these costs are not additive.
      const cost = (names) => {
        const spans = events
          .filter(
            (event) =>
              names.includes(event.name) &&
              event.ph === "X" &&
              event.pid === start.pid &&
              event.tid === start.tid,
          )
          .map((event) => [
            Math.max(start.ts, event.ts),
            Math.min(end.ts, event.ts + event.dur),
          ])
          .filter(([left, right]) => right > left)
          .sort((a, b) => a[0] - b[0]);
        let total = 0;
        let right = start.ts;
        for (const [left, next] of spans) {
          total += Math.max(0, next - Math.max(left, right));
          right = Math.max(right, next);
        }
        return total / 1000;
      };
      return {
        scriptInclusiveMs: cost([
          "FunctionCall",
          "EvaluateScript",
          "EventDispatch",
          "RunMicrotasks",
        ]),
        styleLayoutMs: cost(["UpdateLayoutTree", "Layout"]),
        paintMs: cost(["PrePaint", "Paint"]),
      };
    },
    async stop() {
      if (!ended) await session.send("Tracing.end");
      await session.detach();
    },
  };
}

// Diagnostic measurement: run alone with --workers=1, in both engines. The
// recorder starts on real input, before React mounts or dismisses the sheet.
async function observe(page, closing) {
  return page.evaluateHandle((closing) => {
    let start;
    let dispatchLag;
    let raf;
    let complete;
    let visible = false;
    let surface;
    let backdrop;
    let quiet = 0;
    const frames = [];
    const longFrames = [];
    const observer = PerformanceObserver.supportedEntryTypes.includes(
      "long-animation-frame",
    )
      ? new PerformanceObserver((list) => {
          for (const item of list.getEntries())
            longFrames.push({
              time: item.startTime,
              duration: item.duration,
              blocking: item.blockingDuration,
              script: item.scripts.reduce(
                (sum, script) => sum + script.duration,
                0,
              ),
              styleLayout: item.styleAndLayoutStart
                ? item.startTime + item.duration - item.styleAndLayoutStart
                : 0,
            });
        })
      : undefined;
    observer?.observe({ type: "long-animation-frame" });
    const result = new Promise((resolve) => {
      complete = resolve;
    });
    const sample = () => {
      const sheet = [
        ...document.querySelectorAll('.buzz-dialog[data-placement="bottom"]'),
      ].find(
        (element) =>
          !element.hidden &&
          getComputedStyle(element).visibility !== "hidden" &&
          element.getClientRects().length,
      );
      const hit = (element) => {
        if (!element || !sheet) return false;
        const rect = element.getBoundingClientRect();
        const frame = sheet.getBoundingClientRect();
        const scroll =
          element.closest('[role="region"]')?.getBoundingClientRect() ?? frame;
        const top = Math.max(rect.top, scroll.top, frame.top, 0);
        const bottom = Math.min(
          rect.bottom,
          scroll.bottom,
          frame.bottom,
          innerHeight,
        );
        if (bottom <= top) return false;
        return element.contains(
          document.elementFromPoint(
            Math.max(frame.left, rect.left) +
              Math.min(frame.width, rect.width) / 2,
            (top + bottom) / 2,
          ),
        );
      };
      const rows = [...(sheet?.querySelectorAll("[data-message-id]") ?? [])];
      const reader = rows.find(hit) ?? rows[0];
      const editor = sheet?.querySelector('[role="textbox"]');
      const header = sheet?.querySelector(".buzz-dialog-header");
      const box = (element) => element?.getBoundingClientRect().toJSON();
      if (sheet) {
        surface = sheet;
        backdrop = sheet.parentElement.querySelector(
          ':scope > .buzz-dialog-backdrop[data-placement="bottom"]',
        );
      }
      // Only the reveal and its scrim determine sheet completion. Descendant
      // tooltips, status cues and typing motion belong to content, not the sheet.
      const running = [surface, backdrop].some((element) =>
        element
          ?.getAnimations()
          .some(
            (animation) =>
              animation.effect?.target === element &&
              !animation.effect.pseudoElement &&
              ["clip-path", "transform", "opacity"].includes(
                animation.transitionProperty,
              ) &&
              (animation.playState === "running" || animation.pending),
          ),
      );
      frames.push({
        time: performance.now() - start,
        sheet: box(sheet),
        reader: box(reader),
        editor: box(editor),
        header: box(header),
        scrollTop: sheet?.scrollTop,
        readerId: reader?.getAttribute("data-message-id"),
        rowHitTestable: hit(reader),
        editorHitTestable: hit(editor),
        clip: sheet ? getComputedStyle(sheet).clipPath : null,
        transform: sheet ? getComputedStyle(sheet).transform : null,
        duration: sheet ? getComputedStyle(sheet).transitionDuration : null,
        attrs: sheet
          ? sheet
              .getAttributeNames()
              .filter((a) => a.startsWith("data-"))
              .map((a) => [a, sheet.getAttribute(a)])
          : [],
        keyboard: document.documentElement.hasAttribute(
          "data-keyboard-navigation",
        ),
        running: !!running,
      });
      visible ||= !!sheet;
      const settled = closing
        ? visible && !sheet && !running
        : sheet &&
          reader &&
          editor &&
          !sheet.hasAttribute("data-starting-style") &&
          !running;
      quiet = settled ? quiet + 1 : 0;
      if (quiet < 3) raf = requestAnimationFrame(sample);
      else {
        performance.mark("activity-motion-settled");
        observer?.disconnect();
        complete({
          frames,
          dispatchLag,
          longFrames: longFrames
            .filter((frame) => frame.time + frame.duration > start)
            .map((frame) => ({ ...frame, time: frame.time - start })),
        });
      }
    };
    const input = (event) => {
      if (!event.target.closest("[data-measure-input]")) return;
      performance.clearMarks("activity-motion-input");
      performance.clearMarks("activity-motion-settled");
      performance.mark("activity-motion-input");
      start = event.timeStamp;
      dispatchLag = performance.now() - start;
      visible = closing;
      document.removeEventListener("pointerdown", input, true);
      raf = requestAnimationFrame(sample);
    };
    document.addEventListener("pointerdown", input, true);
    return {
      result,
      stop() {
        cancelAnimationFrame(raf);
        observer?.disconnect();
        document.removeEventListener("pointerdown", input, true);
      },
    };
  }, closing);
}

test("Activity sheet input-to-settled motion measurement", async ({
  page,
  app,
  browserName,
}, testInfo) => {
  // Feed scale and a long conversation are intentional measurement inputs.
  for (let index = 0; index < 40; index++) {
    const root = app.append(
      "primary",
      "alpha",
      `Performance topic ${index}`,
      false,
    );
    const count = index === 39 ? 80 : 2;
    for (let reply = 0; reply < count; reply++)
      app.append(
        "primary",
        "alpha",
        `Performance ${index} reply ${reply}\n\n${"A realistic wrapped conversation update. ".repeat(4)}`,
        false,
        false,
        root.id,
      );
  }
  await page.goto(app.origin);
  const activity = page.getByRole("region", { name: "Activity", exact: true });
  await expect(activity.getByText("Checking recent activity…")).toHaveCount(0);
  const opener = activity
    .getByRole("listitem")
    .filter({ hasText: "Performance 39 reply 79" })
    .getByRole("button", { name: /^Open / });
  await expect(opener).toBeVisible();
  await opener.evaluate((element) =>
    element.setAttribute("data-measure-input", ""),
  );
  const measurements = [];
  for (let iteration = 0; iteration < 3; iteration++) {
    for (const closing of [false, true]) {
      if (closing)
        await page
          .getByRole("dialog", { name: "Alpha", exact: true })
          .getByRole("button", { name: "Close", exact: true })
          .evaluate((element) =>
            element.setAttribute("data-measure-input", ""),
          );
      const recording = await observe(page, closing);
      const attribution =
        process.env.ACTIVITY_TRACE === "1" && browserName === "chromium"
          ? await trace(page)
          : undefined;
      try {
        if (closing)
          await page
            .getByRole("dialog", { name: "Alpha", exact: true })
            .getByRole("button", { name: "Close", exact: true })
            .click();
        else await opener.click();
        const measurement = await recording.evaluate(
          (recorder) => recorder.result,
        );
        const costs = await attribution?.finish();
        const gaps = measurement.frames.map((frame, i, frames) =>
          i ? frame.time - frames[i - 1].time : frame.time,
        );
        measurements.push({
          iteration,
          closing,
          costs,
          firstSurface: measurement.frames.find((frame) => frame.sheet)?.time,
          firstRowMounted: measurement.frames.find((frame) => frame.reader)
            ?.time,
          firstRowHitTestable: measurement.frames.find(
            (frame) => frame.rowHitTestable,
          )?.time,
          firstEditorMounted: measurement.frames.find((frame) => frame.editor)
            ?.time,
          firstEditorHitTestable: measurement.frames.find(
            (frame) => frame.editorHitTestable,
          )?.time,
          firstFrame: measurement.frames[0].time,
          settled: measurement.frames.at(-1).time,
          maxFrame: Math.max(...gaps),
          slowFrames: gaps.filter((gap) => gap > 25).length,
          ...measurement,
        });
      } finally {
        await attribution?.stop();
        await recording.evaluate((recorder) => recorder.stop());
        await recording.dispose();
      }
    }
  }
  await page.screenshot({ path: testInfo.outputPath("activity-rest.png") });
  await writeFile(
    testInfo.outputPath("activity-input-motion.json"),
    JSON.stringify(measurements),
  );
  await testInfo.attach("activity-input-motion", {
    body: JSON.stringify(measurements),
    contentType: "application/json",
  });
  console.log(
    JSON.stringify({
      engine: testInfo.project.name,
      measurements: measurements.map(({ frames, longFrames, ...metrics }) => ({
        ...metrics,
        longFrames,
      })),
    }),
  );
});
