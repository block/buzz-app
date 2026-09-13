import { test, expect } from "@playwright/test";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

let server;

test.beforeAll(async () => {
  server = await createServer({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    configFile: false,
    envFile: false,
    plugins: [react()],
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await server.listen();
});

test.afterAll(async () => server.close());

const url = () =>
  `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/agent-channels.html`;

test("agent dashboard changes point of view and keeps its network usable on narrow screens", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(url());
  const dashboard = page.getByRole("region", {
    name: "Agent dashboard",
    exact: true,
  });
  await expect(
    dashboard.getByRole("button", { name: /^Rizz 2 current/ }),
  ).toHaveAttribute("aria-pressed", "true");
  await dashboard.getByRole("button", { name: /^Carl 1 current/ }).click();
  await expect(
    dashboard.getByRole("button", { name: /^Carl 1 current/ }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    dashboard.getByRole("button", { name: "Focus Rizz, 1 shared channel" }),
  ).toBeVisible();
  await expect(
    dashboard.getByText("#buzz-agent-channel-map").last(),
  ).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  const selector = dashboard.getByRole("combobox", { name: "Choose an agent" });
  await expect(selector).toBeVisible();
  await selector.selectOption("definition:fizz");
  await expect(
    dashboard.getByRole("button", { name: "Focus Rizz, 1 shared channel" }),
  ).toBeVisible();
  await expect(
    page.evaluate(() => document.documentElement.scrollWidth),
  ).resolves.toBe(390);

  await page.setViewportSize({ width: 1214, height: 822 });
  await dashboard.getByRole("tab", { name: /Outcomes 3/ }).click();
  await expect(
    dashboard.getByRole("heading", { name: "Outcomes", exact: true }),
  ).toBeVisible();
  await expect(dashboard.getByText("2", { exact: true }).first()).toBeVisible();
  await expect(
    dashboard.getByRole("heading", { name: "Shipping paths" }),
  ).toBeVisible();
  await expect(
    dashboard.getByRole("button", {
      name: /Launch the agent outcomes dashboard, Merged\. Inspect shipping path/,
    }),
  ).toBeVisible();
  await dashboard
    .getByRole("button", {
      name: /Connect signed evidence to pull requests, open\. Inspect shipping path/,
    })
    .click();
  await expect(
    dashboard.getByTitle("tho/outcomes-9 → block:main"),
  ).toBeVisible();
  await expect(dashboard.getByText(/signed [a-f0-9]{10}…/)).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    dashboard.getByRole("heading", { name: "Shipping paths" }),
  ).toBeVisible();
  await expect(
    page.evaluate(() => document.documentElement.scrollWidth),
  ).resolves.toBe(390);
  expect(errors).toEqual([]);
});
