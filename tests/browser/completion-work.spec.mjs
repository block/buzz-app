import { test, expect } from "./source-fixture.mjs";

// Browser boundary: real contenteditable typing and transient portal/layout work.
// The real relay session runs against a counted, gated transport (not live traffic).
test("mention typing does not repeat cold reads or create phantom popup layout after acceptance", async ({
  page,
}, testInfo) => {
  await page.goto("/tests/fixtures/mentions.html?delayed-profiles");
  const input = page.getByRole("textbox", { name: "Message #General" });
  await expect
    .poll(() => page.evaluate(() => window.mentionFixture.list().status))
    .toBe("ready");
  await input.fill("@M");
  const reads = () => page.evaluate(() => window.mentionFixture.reads());
  await expect
    .poll(
      async () =>
        (await reads()).kinds.filter((kinds) => kinds.includes(0)).length,
    )
    .toBeGreaterThan(0);
  const cold = await reads();
  const coldLibraryReads = await page.evaluate(() =>
    window.mentionFixture.libraryReads(),
  );
  try {
    await input.pressSequentially("ary J");
    await expect(input).toHaveJSProperty("value", "@Mary J");
    expect((await reads()).kinds).toEqual(cold.kinds);
    expect(
      await page.evaluate(() => window.mentionFixture.libraryReads()),
    ).toBe(coldLibraryReads);
  } finally {
    await page.evaluate(() => window.mentionFixture.releaseProfiles());
  }
  const choice = page.getByRole("option", { name: /^Mary Jane / });
  await expect(choice).toBeVisible();
  await expect.poll(async () => (await reads()).pending).toBe(0);
  await choice.click();
  await expect(input).toHaveJSProperty("value", "@Mary Jane ");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  const warm = await reads();
  const warmLibraryReads = await page.evaluate(() =>
    window.mentionFixture.libraryReads(),
  );
  await input.evaluate((element) => {
    const anchor = element.closest("form");
    const original = anchor.getBoundingClientRect;
    const sample = { popups: 0, geometryReads: 0 };
    anchor.getBoundingClientRect = function (...args) {
      sample.geometryReads++;
      return original.apply(this, args);
    };
    const observer = new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          sample.popups += Number(
            node.matches('section[aria-label="Mention suggestions"]'),
          );
          sample.popups += node.querySelectorAll(
            'section[aria-label="Mention suggestions"]',
          ).length;
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    window.suggestionWork = {
      sample,
      stop() {
        observer.disconnect();
        anchor.getBoundingClientRect = original;
      },
    };
  });
  const prose = "this looks weird while typing";
  let sample;
  try {
    await input.pressSequentially(prose);
    await expect(input).toHaveJSProperty("value", `@Mary Jane ${prose}`);
    // Drain effects/DOM mutations and the subsequent paint opportunity, not a sleep.
    sample = await page.evaluate(
      () =>
        new Promise((resolve) => {
          requestAnimationFrame(() =>
            requestAnimationFrame(() => resolve(window.suggestionWork.sample)),
          );
        }),
    );
  } finally {
    await page.evaluate(() => window.suggestionWork.stop());
  }
  const after = await reads();
  const report = {
    characters: prose.length,
    coldReads: cold.kinds,
    warmAdditionalReads: after.kinds.length - warm.kinds.length,
    libraryReads: await page.evaluate(() =>
      window.mentionFixture.libraryReads(),
    ),
    ...sample,
  };
  await testInfo.attach("suggestion-work.json", {
    body: JSON.stringify(report, null, 2),
    contentType: "application/json",
  });
  expect(after.kinds).toEqual(warm.kinds);
  expect(report.libraryReads).toBe(warmLibraryReads);
  expect(sample).toEqual({ popups: 0, geometryReads: 0 });
  await expect(
    page
      .getByRole("region", { name: "Notification recipients" })
      .getByRole("button"),
  ).toHaveCount(1);
  await expect(input).not.toHaveAttribute("aria-controls");
});
