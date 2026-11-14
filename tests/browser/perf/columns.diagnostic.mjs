import { test, expect } from "../fixture.mjs";

// Diagnostic for the list/page columns: main-thread cost of work that should
// be proportional to what changed, not to how many conversations exist.
// Chromium only (DevTools counters); numbers are local evidence, not a budget.
test.use({
  productionBroker: true,
  readState: true,
  // PERF_SMALL=1 drops the 128 extra conversations: the difference between
  // the two runs is the cost that grows with how many conversations exist.
  largeSidebar: process.env.PERF_SMALL !== "1",
  historyCounts: { alpha: 40, beta: 1 },
});

const counters = {
  scriptMs: "ScriptDuration",
  layoutMs: "LayoutDuration",
  styleMs: "RecalcStyleDuration",
  taskMs: "TaskDuration",
};

async function meter(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  await cdp.send("Emulation.setCPUThrottlingRate", {
    rate: Number(process.env.PERF_CPU ?? 4),
  });
  const read = async () => {
    const { metrics } = await cdp.send("Performance.getMetrics");
    return Object.fromEntries(
      Object.entries(counters).map(([key, name]) => [
        key,
        metrics.find((metric) => metric.name === name).value * 1000,
      ]),
    );
  };
  return async (act) => {
    const before = await read();
    await act();
    const after = await read();
    return Object.fromEntries(
      Object.keys(after).map((key) => [
        key,
        Math.round(after[key] - before[key]),
      ]),
    );
  };
}

/** Two rendering opportunities with nothing pending. */
const idle = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => setTimeout(resolve, 0)),
        ),
      ),
  );

test("columns: messages arriving elsewhere, and switching conversations", async ({
  page,
  app,
  browserName,
}, testInfo) => {
  test.skip(browserName !== "chromium", "DevTools counters are Chromium-only");
  await page.goto(app.origin);
  // The app lands on the list; rows are found wherever the shell places it.
  const row = (id) =>
    page.locator(`[data-activity-row="${id}"] [data-conversation-row]`);
  await row("alpha").click();
  await expect(
    page.locator('section[data-channel-timeline="alpha"] [data-message-id]'),
  ).not.toHaveCount(0);
  const rows = await page.locator("[data-activity-row]").count();
  const measure = await meter(page);
  await idle(page);

  // 1. Twenty messages in a conversation that is listed but not open.
  const burst = 20;
  const arrival = await measure(async () => {
    for (let index = 0; index < burst; index++) {
      const text = `columns diagnostic ${index}`;
      app.append("primary", "beta", text, true, false);
      await expect(row("beta")).toContainText(text);
    }
    await idle(page);
  });

  // 2. Selecting another conversation from the list, ten times.
  const switches = 10;
  const switching = await measure(async () => {
    for (let index = 0; index < switches; index++) {
      const id = index % 2 ? "alpha" : "beta";
      await row(id).click();
      await expect(
        page.locator(
          `section[data-channel-timeline="${id}"] [data-message-id]`,
        ),
      ).not.toHaveCount(0);
    }
    await idle(page);
  });

  const per = (sample, count) =>
    Object.fromEntries(
      Object.entries(sample).map(([key, value]) => [
        key,
        Math.round((value / count) * 10) / 10,
      ]),
    );
  const result = {
    listRows: rows,
    conversations: process.env.PERF_SMALL === "1" ? "small" : "large",
    cpu: Number(process.env.PERF_CPU ?? 4),
    perArrivingMessage: per(arrival, burst),
    perConversationSwitch: per(switching, switches),
  };
  console.log(JSON.stringify(result, null, 2));
  await testInfo.attach("columns-diagnostic", {
    body: JSON.stringify(result),
    contentType: "application/json",
  });
});
