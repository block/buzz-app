import { test, expect } from "./fixture.mjs";
import { clickRow, open, settle } from "./timeline.mjs";

async function selectText(page, locator) {
  // Collapse an earlier native selection before dragging; Chromium otherwise
  // drags the selected text itself after a viewport change.
  await locator.click();
  await settle(page);
  const box = await locator.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const { x, y, width, height } = range.getBoundingClientRect();
    return { x, y, width, height };
  });
  await page.mouse.move(box.x, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width, box.y + box.height / 2, {
    steps: 8,
  });
  await page.mouse.up();
  expect(await page.evaluate(() => getSelection()?.toString())).toBe(
    await locator.innerText(),
  );
}

test.use({
  video: "on",
  pluginFixtures: true,
  enabledPlugins: ["example.selection-preview"],
  historyCounts: { alpha: 1, beta: 0 },
});

// Real-engine proof: pointer/keyboard selection, focus and copy with a portalled
// host popup. The fixture installs the actual standalone example plugin.
test("selected message text opens a preview without stealing focus or copy", async ({
  page,
  app,
  browserName,
}) => {
  await open(page, app);
  const event = app.append("primary", "alpha", "EX-42", true);
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${event.id}"]`,
  );
  const text = row.locator("p").filter({ hasText: /^EX-42$/ });
  await expect(text).toBeVisible();
  await selectText(page, text);
  const popup = page.getByRole("dialog");
  await expect(popup.getByText("EX-42", { exact: true })).toBeVisible();
  await test.info().attach("Selection preview", {
    body: await page.screenshot({
      path: test.info().outputPath("preview.png"),
    }),
    contentType: "image/png",
  });
  expect(await page.evaluate(() => getSelection()?.toString())).toBe("EX-42");
  expect(
    await popup.evaluate((element) => element.contains(document.activeElement)),
  ).toBe(false);
  await page.evaluate(() => {
    document.addEventListener(
      "copy",
      (event) => {
        window.selectionPreviewCopy =
          event.clipboardData?.getData("text/plain");
      },
      { once: true },
    );
  });
  if (browserName === "webkit")
    await page.evaluate(() => document.execCommand("copy"));
  else await page.keyboard.press("ControlOrMeta+c");
  await expect
    .poll(() => page.evaluate(() => window.selectionPreviewCopy))
    .toBe("EX-42");
  await page.keyboard.press("Escape");
  await expect(popup).toHaveCount(0);
  expect(await page.evaluate(() => getSelection()?.toString())).toBe("EX-42");
  // A new ordinary selection completes its observer turn and still opens nothing.
  const ordinary = app.append("primary", "alpha", "ordinary prose", true);
  const ordinaryText = page
    .locator(`[data-channel-timeline] [data-message-id="${ordinary.id}"] p`)
    .filter({ hasText: /^ordinary prose$/ });
  await expect(ordinaryText).toBeVisible();
  await selectText(page, ordinaryText);
  await page.evaluate(
    () =>
      new Promise((done) =>
        requestAnimationFrame(() => requestAnimationFrame(done)),
      ),
  );
  await expect(popup).toHaveCount(0);
});

test.describe("competing plugins", () => {
  test.use({
    enabledPlugins: [
      "example.selection-preview",
      "fixture.selection-alternate",
    ],
  });
  test("shows both matches and lets the viewer choose either", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const event = app.append("primary", "alpha", "EX-42", true);
    const row = page.locator(
      `[data-channel-timeline] [data-message-id="${event.id}"]`,
    );
    await selectText(page, row.locator("p").filter({ hasText: /^EX-42$/ }));
    const popup = page.getByRole("dialog");
    await expect(popup).toHaveAccessibleName("Selected text previews");
    await test.info().attach("Matching plugins", {
      body: await page.screenshot({
        path: test.info().outputPath("chooser.png"),
      }),
      contentType: "image/png",
    });
    for (const { width, theme, fontSize } of [
      { width: 390, theme: "dark", fontSize: "20px" },
      { width: 1440, theme: "light", fontSize: "16px" },
    ]) {
      await page.setViewportSize({ width, height: 950 });
      await expect(popup).toHaveCount(0);
      await page.evaluate(
        ({ theme, fontSize }) => {
          document.documentElement.dataset.colorMode = theme;
          document.documentElement.classList.toggle("dark", theme === "dark");
          document.documentElement.style.fontSize = fontSize;
        },
        { theme, fontSize },
      );
      await selectText(page, row.locator("p").filter({ hasText: /^EX-42$/ }));
      await expect(popup).toHaveAccessibleName("Selected text previews");
      const bounds = await popup.evaluate((node) => ({
        left: node.getBoundingClientRect().left,
        right: node.getBoundingClientRect().right,
        client: node.clientWidth,
        scroll: node.scrollWidth,
      }));
      expect(bounds.left).toBeGreaterThanOrEqual(0);
      expect(bounds.right).toBeLessThanOrEqual(width);
      expect(bounds.scroll).toBeLessThanOrEqual(bounds.client);
      await test.info().attach(`Chooser ${theme} ${width}`, {
        body: await page.screenshot({
          path: test.info().outputPath(`chooser-${theme}-${width}.png`),
        }),
        contentType: "image/png",
      });
    }
    const choices = popup.getByRole("button");
    await expect(choices.first()).toContainText("Alternate ID");
    await page.keyboard.press("Tab");
    await expect(choices.first()).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(
      popup.getByRole("button", { name: /^Example ID$/ }),
    ).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(choices.first()).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(
      popup.getByRole("button", { name: /^Example ID$/ }),
    ).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(popup.getByText("EX-42", { exact: true })).toBeVisible();
    await popup.getByRole("button", { name: "Other previews" }).click();
    await popup.getByRole("button", { name: /^Alternate ID$/ }).click();
    await expect(popup.getByText("Alternate identifier: EX-42")).toBeVisible();
    await popup.getByRole("button", { name: "Dismiss" }).click();
    await expect(popup).toHaveCount(0);
  });
});

test.describe("thread preview dismissal", () => {
  test.use({
    productionBroker: true,
    readState: true,
    threadUnread: true,
    historyCounts: { alpha: 20, beta: 0 },
  });
  // The retained thread tab also owns Escape. With native focus still in its
  // history, the preview must dismiss before the containing tab does.
  test("Escape dismisses the preview before the containing thread", async ({
    page,
    app,
  }) => {
    await open(page, app);
    const root = app.histories
      .get("primary/alpha")
      .find((row) => row.content === "Thread root 0");
    if (!root) throw Error("Thread root unavailable");
    const trigger = page
      .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
      .getByRole("button", { name: /^View thread:/ });
    await clickRow(page, trigger);
    const panel = page.getByRole("complementary", {
      name: "Thread",
      exact: true,
    });
    const history = panel.getByRole("region", {
      name: "Thread messages",
      exact: true,
    });
    await expect(history).toBeVisible();
    const reply = app.append("primary", "alpha", "EX-42", true, true, root.id);
    const text = history
      .locator(`[data-message-id="${reply.id}"] p`)
      .filter({ hasText: /^EX-42$/ });
    await expect(text).toBeVisible();
    await history.focus();
    await selectText(page, text);
    const popup = page.getByRole("dialog");
    await expect(popup).toBeVisible();
    await expect(history).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(popup).toHaveCount(0);
    await expect(history).toBeVisible();
    await expect(history).toBeFocused();
    expect(await page.evaluate(() => getSelection()?.toString())).toBe("EX-42");
    await page.keyboard.press("Escape");
    await expect(history).toHaveCount(0);
  });
});
