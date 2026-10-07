import { test, expect } from "@playwright/test";
import { createServer } from "./vite-server.mjs";
import config from "../fixtures/agent-control.vite.mjs";
import { watchPageErrors } from "./page-errors.mjs";

// Playwright's service-worker blocker accesses navigator.serviceWorker in every
// frame, which throws in an opaque sandbox. This fixture registers no workers.
test.use({ serviceWorkers: "allow" });

// Browser-only boundary: the real sharing page, model Select popup and narrow
// geometry. Synthetic IPC does not certify SDK serving or live agent replies.
test("sharing page presents the ladder and supports share/stop at desktop and narrow widths", async ({
  page,
}, testInfo) => {
  const server = await createServer({
    ...config,
    configFile: false,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await server.listen();
  const errors = watchPageErrors(page);
  try {
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/mesh-share.html`,
    );
    await expect(page.getByText("Qwen 27B", { exact: true })).toBeVisible();
    await page.evaluate(() =>
      document.documentElement.setAttribute("data-color-mode", "dark"),
    );
    await expect(
      page.getByRole("heading", { name: "Shared-compute activity" }),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("shared-compute-preview.png"),
      fullPage: true,
    });
    // Browser-only boundary: sandboxed canvas loads, accepts parent telemetry,
    // draws real pixels and owns its keyboard without touching the model picker.
    const tile = page.frameLocator(
      'iframe[title="Shared-compute bee visualization"]',
    );
    await expect(tile.locator("canvas")).toHaveAttribute("data-total", "120");
    await expect
      .poll(() =>
        tile.locator("canvas").evaluate((canvas) =>
          canvas
            .getContext("2d")
            .getImageData(0, 0, canvas.width, canvas.height)
            .data.some((value, index) => index % 4 !== 3 && value > 0),
        ),
      )
      .toBe(true);
    await tile.locator("canvas").click();
    await page.keyboard.press("ArrowRight");
    await expect(tile.locator("canvas")).toHaveAttribute(
      "data-design",
      "orbit",
    );
    await page.getByRole("button", { name: "Advanced", exact: true }).click();
    await expect(
      page.getByRole("combobox", { name: "Model to share" }),
    ).toContainText("Qwen 27B — recommended");
    await page.getByRole("combobox", { name: "Model to share" }).click();
    await expect(page.getByRole("option", { name: /Gemma E4B/ })).toBeVisible();
    await expect(page.getByRole("option", { name: /Qwen 9B/ })).toBeVisible();
    await page.getByRole("option", { name: /Qwen 27B/ }).click();
    await page.getByRole("switch", { name: "Share this machine" }).click();
    await expect(
      page.getByRole("switch", { name: "Share this machine" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(
      await page.evaluate(
        () =>
          window.meshShareFixture.calls.find(
            (call) => call.command === "mesh_compute_share",
          ).args.model,
      ),
    ).toBe("unsloth/Qwen3.8-27B-GGUF:Q4_K_M");
    for (const [width, mode] of [
      [1200, "light"],
      [390, "dark"],
    ]) {
      await page.setViewportSize({ width, height: 950 });
      await page.evaluate(
        (mode) =>
          document.documentElement.setAttribute("data-color-mode", mode),
        mode,
      );
      await expect(
        page.getByRole("switch", { name: "Share this machine" }),
      ).toBeInViewport();
      await expect
        .poll(() =>
          page.evaluate(() =>
            [...document.querySelectorAll("main div, main section")].every(
              (element) => element.scrollWidth <= element.clientWidth + 1,
            ),
          ),
        )
        .toBe(true);
      await page.screenshot({
        path: testInfo.outputPath(`sharing-${width}-${mode}.png`),
        fullPage: true,
      });
    }
    await page.getByRole("switch", { name: "Share this machine" }).click();
    await expect(
      page.getByRole("switch", { name: "Share this machine" }),
    ).toHaveAttribute("aria-checked", "false");
    expect(errors.unexplained()).toEqual([]);
  } finally {
    await server.close();
  }
});
