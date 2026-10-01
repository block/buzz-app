import { test, expect } from "./source-fixture.mjs";

test("Use here opens a visible dialog at desktop and narrow widths", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/agent-control.html");
  await page.evaluate(async () => {
    const f = window.agentControlFixture;
    f.data.parked = [];
    Object.assign(f.agent, {
      configured: false,
      enabled: false,
      status: "stopped",
      runningRevision: null,
    });
    await f.control.refresh();
  });
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 800 });
    await page.getByRole("button", { name: "Use here", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Set up agent here" });
    await expect(dialog).toHaveCSS("position", "fixed");
    await expect(dialog).toBeInViewport({ ratio: 1 });
    await expect(
      dialog.getByRole("button", { name: "Use here", exact: true }),
    ).toBeInViewport({ ratio: 1 });
    const close = dialog.getByRole("button", { name: "Close", exact: true });
    await expect(close).toBeInViewport({ ratio: 1 });
    await close.click();
    await expect(dialog).toHaveCount(0);
  }
});
