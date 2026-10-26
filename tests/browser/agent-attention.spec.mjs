import { test, expect } from "./source-fixture.mjs";

// Real browser focus, popup placement and scroll geometry are outside jsdom.
// Recipe validation and host-store patches retain their component/helper coverage.
test("Agent Attention fits both themes and sizes and creates a subscription by keyboard", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/agent-attention.html");
  const pane = page.getByRole("region", {
    name: "Agent Attention",
    exact: true,
  });
  const create = page.getByRole("button", { name: "New subscription" });
  await expect(pane).toBeVisible();
  for (const theme of ["light", "dark"]) {
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate((theme) => {
        document.documentElement.dataset.colorMode = theme;
        document.documentElement.style.fontSize = "20px";
      }, theme);
      await expect(create).toBeInViewport();
      await expect(
        page.getByRole("switch", { name: "Subscription Release discussion" }),
      ).toBeInViewport();
      expect(
        await pane.evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
    }
  }
  await create.focus();
  await page.keyboard.press("Enter");
  const form = page.getByRole("form", { name: "New subscription" });
  const agent = form.getByRole("combobox", { name: "Agent", exact: true });
  await agent.focus();
  await page.keyboard.press("ArrowDown");
  await page.getByRole("option", { name: "Ada", exact: true }).click();
  await form
    .getByRole("textbox", { name: "Interest instructions" })
    .fill("Review release checks");
  await form
    .getByRole("textbox", { name: "Pull request URL" })
    .fill("https://github.com/example/project/pull/42");
  await form.getByRole("button", { name: "Create subscription" }).click();
  await expect(form).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Open project#42" }),
  ).toBeVisible();
  const toggle = page.getByRole("switch", {
    name: "Subscription example/project#42",
  });
  await toggle.focus();
  await page.keyboard.press("Space");
  await expect(toggle).toHaveAttribute("aria-checked", "false");
});

test("the allowlist warning opens editable shared settings with usable narrow-layout controls", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/agent-attention.html");
  await expect(
    page.getByText(/No GitHub author allowlist configured/),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Edit GitHub author allowlist" })
    .click();
  const form = page.getByRole("form", { name: "GitHub author allowlist" });
  await expect(form).toBeVisible();
  for (const theme of ["light", "dark"]) {
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate((theme) => {
        document.documentElement.dataset.colorMode = theme;
        document.documentElement.style.fontSize = "20px";
      }, theme);
      const save = form.getByRole("button", { name: "Save allowlist" });
      await save.scrollIntoViewIfNeeded();
      await expect(save).toBeInViewport();
      expect(
        await page
          .locator(".attention-page")
          .evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
    }
  }
  await form
    .getByRole("textbox", { name: "Trusted organizations" })
    .fill("example-org");
  await form
    .getByRole("textbox", { name: "Trusted commenters" })
    .fill("review-bot[bot]");
  await form.getByRole("button", { name: "Save allowlist" }).click();
  await expect(form.getByRole("status")).toHaveText(
    "GitHub author allowlist saved.",
  );
  await expect(
    page.getByText(/No GitHub author allowlist configured/),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Cancel editing allowlist" }).click();
  await page
    .getByRole("button", { name: "Edit GitHub author allowlist" })
    .click();
  await expect(
    form.getByRole("textbox", { name: "Trusted commenters" }),
  ).toHaveValue("review-bot[bot]");
});
