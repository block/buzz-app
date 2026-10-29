import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({ historyCounts: { alpha: 40, beta: 1 }, tallMessages: true });

// Only a browser can prove that the production fixture build loads a real
// module worker and that the renderer consumes its transferred parser tree.
test("older pages consume the real production worker's parser result", async ({
  page,
  app,
}) => {
  const marker = "Worker transfer consumption witness";
  await page.addInitScript((marker) => {
    const NativeWorker = window.Worker;
    window.markdownWorkerProbe = {
      replies: 0,
      trees: 0,
      sourceHadMarker: false,
    };
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        super(url, options);
        this.markdown = String(url).includes("markdown-preparation.worker");
      }
      set onmessage(listener) {
        super.onmessage =
          listener &&
          ((event) => {
            if (this.markdown) {
              const probe = window.markdownWorkerProbe;
              probe.replies++;
              for (const result of event.data.results) {
                probe.sourceHadMarker ||= result.content.includes(marker);
                if (!result.tree) continue;
                probe.trees++;
                // This text never enters the raw message. Its appearance proves
                // cache consumption, rather than a correct synchronous fallback.
                result.tree.children.push({
                  type: "paragraph",
                  children: [{ type: "text", value: marker }],
                });
              }
            }
            listener.call(this, event);
          });
      }
    };
  }, marker);
  await open(page, app);
  const history = page.getByRole("region", { name: "Channel message history" });
  await history.hover();
  await page.mouse.wheel(
    0,
    -(await history.evaluate((element) => element.scrollTop)),
  );
  await expect.poll(() => app.pending.length).toBe(1);
  const request = app.pending.shift();
  try {
    // The relay gate keeps worker preparation from starting until its deadline
    // is controlled. Native worker messages still arrive while the clock pauses.
    await page.clock.install({ time: Date.now() });
    await page.clock.pauseAt(Date.now() + 1_000);
  } finally {
    request.release();
  }
  await expect
    .poll(() => page.evaluate(() => window.markdownWorkerProbe.replies))
    .toBeGreaterThan(0);
  await history.evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.clock.runFor(32);
  await expect
    .poll(() => history.getByText(marker, { exact: true }).count())
    .toBeGreaterThan(0);
  const probe = await page.evaluate(() => window.markdownWorkerProbe);
  expect(probe.trees).toBeGreaterThan(0);
  expect(probe.sourceHadMarker).toBe(false);
});
