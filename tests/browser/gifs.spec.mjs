import { test, expect } from "./fixture.mjs";

test.use({ historyCounts: { alpha: 1, beta: 0 } });
test("relay-backed GIF tab searches KLIPY and inserts URL-only media", async ({
  page,
  app,
}, testInfo) => {
  const result = (id, title, height) => ({
    id,
    type: "gif",
    slug: title.toLowerCase(),
    title,
    file: {
      md: {
        gif: {
          url: `https://gif.fixture.invalid/${id}.gif`,
          width: 320,
          height,
          size: 1200,
        },
      },
      sm: {
        webp: {
          url: `https://gif.fixture.invalid/${id}.webp`,
          width: 160,
          height: height / 2,
          size: 600,
        },
      },
    },
  });
  const requests = [];
  let signRequests = 0;
  await page.route("**/api/relay/*/sign", (route) => {
    signRequests += 1;
    return route.abort();
  });
  let releaseInfo = () => {};
  const infoReady = new Promise((resolve) => {
    releaseInfo = resolve;
  });
  let infoRequests = 0;
  await page.route("**/api/relay/*/gif-info", async (route) => {
    infoRequests += 1;
    await infoReady;
    await route.fulfill({
      json: {
        policy: null,
        supported_extensions: ["buzz-gif"],
        gif: { provider: "klipy", search: "/gifs/search" },
      },
    });
  });
  await page.route("**/api/relay/*/gifs", async (route) => {
    const request = route.request().postDataJSON();
    requests.push(request);
    await route.fulfill({
      json: {
        result: true,
        data: {
          data: [
            result(1, request.query ? "Hello" : "Trending Hello", 240),
            result(2, "Celebrate", 320),
          ],
        },
      },
    });
  });
  await page.route("https://gif.fixture.invalid/**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120"><rect width="160" height="120" fill="#8aa6b4"/></svg>',
    }),
  );

  await page.goto(app.origin);
  await page
    .getByRole("navigation", { name: "Pages", exact: true })
    .getByRole("button", { name: "Messages", exact: true })
    .click();
  const draft = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  const emojiTrigger = page.getByRole("button", {
    name: "Insert emoji",
    exact: true,
  });
  await emojiTrigger.click();
  await expect.poll(() => infoRequests).toBeGreaterThan(0);
  const picker = page.getByRole("dialog", { name: "Emoji picker" });
  await expect(emojiTrigger).toHaveAttribute("aria-busy", "true");
  await expect(picker).toBeVisible();
  await expect(page.getByRole("tab", { name: "GIF", exact: true })).toHaveCount(
    0,
  );
  const initialEmojiSearch = page.getByRole("searchbox", {
    name: "Search emoji",
    exact: true,
  });
  await expect(initialEmojiSearch).toBeFocused();
  const initialSearchNode = await initialEmojiSearch.elementHandle();
  releaseInfo();
  await expect(emojiTrigger).not.toHaveAttribute("aria-busy", "true");
  await expect(
    page.getByRole("tab", { name: "GIF", exact: true }),
  ).toBeVisible();
  await expect(picker).toBeVisible();
  await expect(picker).toHaveCSS("border-radius", "24px");
  await expect(picker).toHaveCSS("border-top-width", "1px");
  await expect(picker).not.toHaveCSS("box-shadow", "none");
  const emojiTab = page.getByRole("tab", { name: "Emoji", exact: true });
  const gifTab = page.getByRole("tab", { name: "GIF", exact: true });
  const emojiSearch = page.getByRole("searchbox", {
    name: "Search emoji",
    exact: true,
  });
  const emojiSearchFrame = await emojiSearch.locator("..").boundingBox();
  const emojiTabsBox = await picker.getByRole("tablist").boundingBox();
  expect(emojiSearchFrame.x).toBeCloseTo(emojiTabsBox.x, 1);
  expect(emojiSearchFrame.y - emojiTabsBox.y - emojiTabsBox.height).toBeCloseTo(
    16,
    1,
  );
  const emojiResultsBox = await picker
    .locator("em-emoji-picker .scroll")
    .boundingBox();
  const emojiPickerBox = await picker.boundingBox();
  const emojiFooterBox = await picker
    .locator("em-emoji-picker #nav")
    .boundingBox();
  expect(
    emojiResultsBox.y - emojiSearchFrame.y - emojiSearchFrame.height,
  ).toBeCloseTo(12, 1);
  expect(emojiFooterBox.height).toBeCloseTo(40, 1);
  await expect(emojiSearch).toBeFocused();
  // Discovering GIF support must not replace the focused vendor search.
  expect(await initialSearchNode.evaluate((node) => node.isConnected)).toBe(
    true,
  );
  await expect(emojiTab).toHaveAttribute("aria-selected", "true");
  await expect(emojiTab).toHaveAttribute("aria-controls", /.+/);
  await expect(
    picker.getByRole("tabpanel", { name: "Emoji", exact: true }),
  ).toBeVisible();
  await emojiSearch.fill("hello");
  // Base UI owns the tab keyboard model; the selected panel focuses its search.
  await emojiTab.focus();
  await emojiTab.press("ArrowRight");
  await expect(gifTab).toBeFocused();
  await gifTab.press("Enter");
  await expect(gifTab).toHaveAttribute("aria-selected", "true");
  await expect(
    picker.getByRole("tabpanel", { name: "GIF", exact: true }),
  ).toBeVisible();
  await expect(
    picker.getByRole("tabpanel", { name: "Emoji", exact: true }),
  ).toHaveCount(0);
  const tabIndicator = picker.locator(".buzz-tabs-indicator");
  await expect(tabIndicator).toHaveCSS("height", "2px");
  await expect(tabIndicator).toHaveCSS("background-color", "rgb(0, 0, 0)");
  const search = page.getByRole("searchbox", { name: "Search GIFs" });
  await expect(search).toBeFocused();
  await expect(search).toHaveValue("hello");
  await draft.fill("unfinished draft");
  // Observe the real key's browser-default boundary, not a guessed network delay.
  await search.evaluate((input) => {
    window.gifEnter = { prevented: false, submits: 0 };
    document
      .querySelector("form")
      .addEventListener("submit", () => window.gifEnter.submits++);
    window.addEventListener("keydown", (event) => {
      if (event.target === input && event.key === "Enter")
        window.gifEnter.prevented = event.defaultPrevented;
    });
  });
  await search.press("Enter");
  expect(await page.evaluate(() => window.gifEnter)).toEqual({
    prevented: true,
    submits: 0,
  });
  await expect(draft).toHaveJSProperty("value", "unfinished draft");
  expect(signRequests).toBe(0);
  await draft.evaluate((element) => {
    element.value = "";
    element.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "deleteContentBackward",
      }),
    );
  });
  await expect(draft).toHaveJSProperty("value", "");
  const composer = draft.locator("xpath=ancestor::form");
  const composerBorder = await composer.evaluate((element) => {
    const probe = document.createElement("div");
    probe.style.borderColor = "var(--border-standard)";
    element.append(probe);
    const color = getComputedStyle(probe).borderColor;
    probe.remove();
    return color;
  });
  await expect(composer).toHaveCSS("border-top-color", composerBorder);
  await expect(composer).not.toHaveCSS("box-shadow", "none");
  await expect(search).toHaveAttribute("spellcheck", "false");
  await expect(search).toHaveAttribute("autocorrect", "off");
  await expect(search).toHaveAttribute("autocapitalize", "off");
  const searchFrame = search.locator("..");
  await expect(searchFrame).toHaveClass(/search-field/);
  await expect(searchFrame).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(searchFrame).toHaveCSS("border-top-color", "rgb(128, 128, 128)");
  await expect(search).toHaveCSS("color", "rgb(0, 0, 0)");
  await expect(search).toHaveCSS("font-family", /Inter Variable/);
  const gifSearchPosition = await searchFrame.boundingBox();
  const tabListBox = await picker.getByRole("tablist").boundingBox();
  expect(gifSearchPosition.x).toBeCloseTo(tabListBox.x, 1);
  expect(gifSearchPosition.y - tabListBox.y - tabListBox.height).toBeCloseTo(
    16,
    1,
  );
  expect(gifSearchPosition.width).toBeGreaterThan(0);
  expect(gifSearchPosition.x).toBeGreaterThanOrEqual(
    (await picker.boundingBox()).x,
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(tabIndicator).toHaveCSS("transition-duration", "0s");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(
    page.getByTestId("klipy-gif-grid").getByRole("button"),
  ).toHaveCount(2);
  const gifGridBox = await page.getByTestId("klipy-gif-grid").boundingBox();
  const gifResultGutters = await page
    .getByTestId("klipy-gif-grid")
    .evaluate((grid) => {
      const results = grid.parentElement;
      const resultsBounds = results.getBoundingClientRect();
      const gridBounds = grid.getBoundingClientRect();
      return {
        left: gridBounds.left - resultsBounds.left,
        right: resultsBounds.left + results.clientWidth - gridBounds.right,
      };
    });
  expect(gifResultGutters.left).toBeCloseTo(gifResultGutters.right, 1);
  expect(gifResultGutters.left).toBeCloseTo(12, 1);
  const gifResults = page.getByTestId("klipy-gif-grid").locator("..");
  const gifResultsBox = await gifResults.boundingBox();
  expect(gifResultsBox.y).toBeCloseTo(emojiResultsBox.y, 1);
  expect(gifResultsBox.height).toBeCloseTo(emojiResultsBox.height, 1);
  expect(await picker.boundingBox()).toEqual(emojiPickerBox);
  await expect(gifResults).toHaveCSS("scrollbar-width", "thin");
  await expect(gifResults).toHaveCSS(
    "scrollbar-color",
    "rgb(128, 128, 128) rgba(0, 0, 0, 0)",
  );
  expect(gifGridBox.y).toBeGreaterThanOrEqual(
    gifSearchPosition.y + gifSearchPosition.height,
  );
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    locale: expect.any(String),
    query: "hello",
  });
  await search.fill("celebrate");
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]).toMatchObject({ query: "celebrate" });
  await emojiTab.click();
  await expect(emojiTab).toHaveAttribute("aria-selected", "true");
  const returningEmojiSearch = page.getByRole("searchbox", {
    name: "Search emoji",
    exact: true,
  });
  await expect(returningEmojiSearch).toHaveValue("celebrate");
  await expect(returningEmojiSearch).toHaveCSS("animation-name", "none");
  const returningEmojiSearchPosition = await returningEmojiSearch
    .locator("..")
    .boundingBox();
  expect(returningEmojiSearchPosition.x).toBeCloseTo(emojiSearchFrame.x, 1);
  expect(returningEmojiSearchPosition.y).toBeCloseTo(emojiSearchFrame.y, 1);
  expect(returningEmojiSearchPosition.width).toBeCloseTo(
    emojiSearchFrame.width,
    1,
  );
  await gifTab.click();
  await expect(search).toBeFocused();
  await expect(search).toHaveValue("celebrate");
  await page.locator("main").click({ position: { x: 4, y: 4 } });
  await expect(picker).toHaveCount(0);
  await emojiTrigger.click();
  await gifTab.click();
  await expect(search).toHaveValue("celebrate");
  await expect(
    page.getByTestId("klipy-gif-grid").getByRole("button"),
  ).toHaveCount(2);
  const reopenRequests = requests.length;
  expect(requests.at(-1)).toMatchObject({
    locale: expect.any(String),
    query: "celebrate",
  });
  await search.fill("hello");
  await expect.poll(() => requests.length).toBe(reopenRequests + 1);
  expect(requests.at(-1)).toMatchObject({ query: "hello" });
  const clear = picker.getByRole("button", {
    name: "Clear search gifs",
    exact: true,
  });
  await expect(clear).toHaveCSS("width", "32px");
  await expect(clear).toHaveCSS("height", "32px");
  await clear.click();
  await expect(search).toHaveValue("");
  await expect(search).toBeFocused();
  // Clearing starts a debounced request. Old results have the same count, so
  // wait for the cleared query's rendered result before clicking its replacement.
  const trending = page.getByRole("button", {
    name: "Choose Trending Hello",
    exact: true,
  });
  await expect(trending).toBeVisible();
  await expect(
    page.getByTestId("klipy-gif-grid").getByRole("button"),
  ).toHaveCount(2);
  await page.screenshot({ path: testInfo.outputPath("gif-picker.png") });

  await trending.click();
  await expect(draft).toHaveJSProperty(
    "value",
    "![Trending Hello](https://gif.fixture.invalid/1.gif)",
  );
  await expect(
    page.getByRole("searchbox", { name: "Search GIFs" }),
  ).toHaveCount(0);
  expect(app.report.unexpected).toEqual([]);
});

for (const initial of ["invalid response", "unsupported relay"]) {
  test(`GIF discovery retries after ${initial}`, async ({ page, app }) => {
    let attempts = 0;
    let releaseFirst;
    const firstResponse = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    await page.route("**/api/relay/*/gif-info", async (route) => {
      attempts += 1;
      if (attempts === 1) {
        await firstResponse;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: initial === "invalid response" ? "{" : "{}",
        });
        return;
      }
      await route.fulfill({
        json: {
          policy: null,
          supported_extensions: ["buzz-gif"],
          gif: { provider: "klipy", search: "/gifs/search" },
        },
      });
    });

    await page.goto(app.origin);
    await page
      .getByRole("navigation", { name: "Pages", exact: true })
      .getByRole("button", { name: "Messages", exact: true })
      .click();
    const trigger = page.getByRole("button", {
      name: "Insert emoji",
      exact: true,
    });
    const gifTab = page.getByRole("tab", { name: "GIF", exact: true });

    // Hover/focus may prefetch. Hold that response through the opening click
    // so the click cannot accidentally become a retry of a completed request.
    try {
      await trigger.click();
      await expect.poll(() => attempts).toBe(1);
      await expect(trigger).toHaveAttribute("aria-busy", "true");
    } finally {
      releaseFirst();
    }
    await expect(trigger).not.toHaveAttribute("aria-busy", "true");
    await expect(gifTab).toHaveCount(0);
    await trigger.click();
    await trigger.click();
    await expect.poll(() => attempts).toBe(2);
    await expect(trigger).not.toHaveAttribute("aria-busy", "true");
    await expect(gifTab).toBeVisible();
  });
}
