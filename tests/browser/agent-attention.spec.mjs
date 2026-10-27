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
  const create = page.getByRole("button", { name: "New watch" });
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
        page.getByRole("switch", { name: "Watch Release discussion" }),
      ).toBeInViewport();
      expect(
        await pane.evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
    }
  }
  await create.focus();
  await page.keyboard.press("Enter");
  const form = page.getByRole("form", { name: "New watch" });
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
  await page.evaluate(() => window.attentionFixture.holdSave());
  const submit = form.getByRole("button", { name: "Create watch" });
  await submit.focus();
  await page.keyboard.press("Enter");
  try {
    await expect
      .poll(() => page.evaluate(() => window.attentionFixture.saveStarted))
      .toBe(true);
    await expect(submit).toBeFocused();
  } finally {
    await page.evaluate(() => window.attentionFixture.releaseSave());
  }
  await expect(form).toHaveCount(0);
  await expect(create).toBeFocused();
  await expect(
    page.getByRole("link", { name: "Open project#42" }),
  ).toBeVisible();
  const toggle = page.getByRole("switch", {
    name: "Watch example/project#42",
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
    page.getByText(/GitHub comments and reviews are off/),
  ).toBeVisible();
  await page.getByRole("button", { name: "Edit allowlist" }).click();
  const form = page.getByRole("form", { name: "GitHub author allowlist" });
  await expect(form).toBeVisible();
  for (const theme of ["light", "dark"]) {
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate((theme) => {
        document.documentElement.dataset.colorMode = theme;
        document.documentElement.style.fontSize = "20px";
      }, theme);
      const save = page.getByRole("button", { name: "Save", exact: true });
      await save.scrollIntoViewIfNeeded();
      await expect(save).toBeInViewport();
      await expect
        .poll(() =>
          form.evaluate((el) => {
            const footer = el
              .closest('[role="dialog"]')
              .querySelector(".buzz-dialog-actions");
            return (
              el.getBoundingClientRect().bottom <=
              footer.getBoundingClientRect().top
            );
          }),
        )
        .toBe(true);
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
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "GitHub allowlist", exact: true }),
  ).toBeFocused();
  await expect(
    page.getByText(/GitHub comments and reviews are off/),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "GitHub allowlist", exact: true })
    .click();
  await expect(
    form.getByRole("textbox", { name: "Trusted commenters" }),
  ).toHaveValue("review-bot[bot]");
});

test("allowlist dialog discards drafts on Escape and outside click", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/agent-attention.html");
  await page.getByRole("button", { name: "Edit allowlist" }).click();
  await page
    .getByRole("textbox", { name: "Trusted commenters" })
    .fill("discard-me");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Edit allowlist" }).click();
  await expect(
    page.getByRole("textbox", { name: "Trusted commenters" }),
  ).toHaveValue("");
  await page.mouse.click(5, 5);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

// Browser focus after removal, including async writes, cannot be proved by jsdom.
test("watch cancellation and deletion restore focus without taking it from another control", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/agent-attention.html");
  const create = page.getByRole("button", { name: "New watch" });
  await create.focus();
  await page.keyboard.press("Enter");
  const cancel = page.getByRole("button", { name: "Cancel", exact: true });
  await cancel.focus();
  await page.keyboard.press("Enter");
  await expect(create).toBeFocused();
  const remove = page.getByRole("button", {
    name: "Delete Release discussion",
  });
  await page.evaluate(() => window.attentionFixture.holdSave());
  await remove.focus();
  await page.keyboard.press("Enter");
  try {
    await expect
      .poll(() => page.evaluate(() => window.attentionFixture.saveStarted))
      .toBe(true);
    await expect(remove).toBeFocused();
  } finally {
    await page.evaluate(() => window.attentionFixture.releaseSave());
  }
  await expect(remove).toHaveCount(0);
  await expect(create).toBeFocused();
  await expect(
    page.getByRole("region", { name: "Ada", exact: true }),
  ).toHaveCount(0);

  await page.reload();
  await page.evaluate(() => window.attentionFixture.holdSave());
  await remove.focus();
  await page.keyboard.press("Enter");
  try {
    await expect
      .poll(() => page.evaluate(() => window.attentionFixture.saveStarted))
      .toBe(true);
    await page.getByRole("button", { name: "Edit allowlist" }).focus();
  } finally {
    await page.evaluate(() => window.attentionFixture.releaseSave());
  }
  await expect(remove).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Edit allowlist" }),
  ).toBeFocused();

  await create.click();
  const form = page.getByRole("form", { name: "New watch" });
  await form.getByRole("combobox", { name: "Agent", exact: true }).click();
  await page.getByRole("option", { name: "Ada", exact: true }).click();
  await form
    .getByRole("textbox", { name: "Interest instructions" })
    .fill("Review release checks");
  await form
    .getByRole("textbox", { name: "Pull request URL" })
    .fill("https://github.com/example/project/pull/42");
  await page.evaluate(() => window.attentionFixture.holdSave());
  await form.getByRole("button", { name: "Create watch" }).click();
  try {
    await expect
      .poll(() => page.evaluate(() => window.attentionFixture.saveStarted))
      .toBe(true);
    await page.getByRole("button", { name: "Edit allowlist" }).focus();
  } finally {
    await page.evaluate(() => window.attentionFixture.releaseSave());
  }
  await expect(form).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Open project#42" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Edit allowlist" }),
  ).toBeFocused();
});
