import { npubEncode } from "nostr-tools/nip19";
import { test, expect } from "@playwright/test";
import { createServer } from "./vite-server.mjs";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

test("actual composer selects namesakes by exact key, publishes channel/reply tags, and blocks removed members", async ({
  page,
}) => {
  // This journey exercises one-message recipients; prefill-on has separate coverage.
  await page.addInitScript(() => {
    localStorage.setItem("buzz-remember-mentioned-agents.v1", "off");
  });
  const server = await createServer({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    configFile: false,
    envFile: false,
    plugins: [react()],
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  try {
    await server.listen();
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/mentions.html`,
    );
    const keys = await page.evaluate(() => ({
      first: window.mentionFixture.first,
      second: window.mentionFixture.second,
    }));
    const choose = async (key) => {
      await page
        .getByRole("button", { name: "Mention a member", exact: true })
        .click();
      const picker = page.getByRole("dialog", {
        name: "Mention a member or agent",
      });
      await expect(
        picker.getByRole("button", { name: new RegExp(key) }),
      ).toBeVisible();
      const search = picker.getByRole("searchbox");
      await expect(search).toBeFocused();
      await expect(picker).toHaveCSS("width", "380px");
      expect((await picker.boundingBox()).height).toBeLessThanOrEqual(360);
      await search.fill("");
      const choice = picker.getByRole("button", {
        name: new RegExp(key),
      });
      const index = await choice.evaluate((node) =>
        [
          ...node.parentElement.querySelectorAll("[data-mention-choice]"),
        ].indexOf(node),
      );
      await search.press("ArrowDown");
      for (let step = 0; step < index; step++)
        await page.keyboard.press("ArrowDown");
      await expect(choice).toBeFocused();
      await expect(choice).toHaveCSS("padding", "8px");
      await expect(choice.locator(".buzz-avatar")).toHaveCSS("width", "40px");
      await choice.press("ArrowUp");
      await page.keyboard.press("ArrowDown");
      await expect(choice).toBeFocused();
      await choice.press("Enter");
    };
    const order = () =>
      page
        .getByRole("button", { name: /^(Mention a member|Insert emoji)$/ })
        .evaluateAll((buttons) =>
          buttons.map((button) => button.getAttribute("aria-label")),
        );
    await expect.poll(order).toEqual(["Mention a member", "Insert emoji"]);
    const input = page.getByRole("textbox", { name: "Message #General" });
    await choose(keys.first);
    await expect(input.locator(".inline-chip")).toHaveText("@Honey");
    await choose(keys.second);
    const labels = ["@Honey", "@Honey (agent)"];
    await expect(input.locator(".inline-chip")).toHaveText(labels);
    // The complete choice set already qualifies the agent before selection.
    await expect(input.locator("[data-reveal]")).toHaveCount(0);
    // Copy serializes authored source, not the visible namesake qualifiers.
    await input.focus();
    await input.press("ControlOrMeta+a");
    await expect(input.locator("[data-editor-selected]")).toHaveCount(2);
    const copied = await input.evaluate((element) => {
      const clipboardData = new DataTransfer();
      element.dispatchEvent(
        new ClipboardEvent("copy", {
          bubbles: true,
          cancelable: true,
          clipboardData,
        }),
      );
      return clipboardData.getData("text/plain");
    });
    expect(copied).toBe("@Honey @Honey ");
    await input.press("ArrowRight");
    // Typing can rebuild editor portals; it must not replay the reveal.
    await input.press("x");
    await expect(input).toHaveJSProperty("value", "@Honey @Honey x");
    await expect(input.locator("[data-reveal]")).toHaveCount(0);
    await input.press("Backspace");
    await page.emulateMedia({ reducedMotion: "reduce" });
    // The first chip's visual expansion must not change native source offsets.
    await input.focus();
    await input.evaluate((element) => element.setSelectionRange(7, 13));
    await input.press("Backspace");
    await expect(input).toHaveJSProperty("value", "@Honey  ");
    await expect(input.locator(".inline-chip")).toHaveText("@Honey");
    await input.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
    await expect(input).toHaveJSProperty("value", "@Honey @Honey ");
    await expect(input.locator(".inline-chip")).toHaveText(labels);
    await expect(input.locator("[data-reveal]")).toHaveCount(0);
    // Undo restores the former selected range. Continue the original typing journey at its end.
    await input.evaluate((element) =>
      element.setSelectionRange(element.value.length, element.value.length),
    );
    // The merged toolbar must preserve exact recipients while the new picker
    // inserts Unicode and follows the host mode without recreating the draft.
    await page.evaluate(() => {
      document.documentElement.dataset.colorMode = "dark";
    });
    await page
      .getByRole("button", { name: "Insert emoji", exact: true })
      .click();
    const search = page.getByRole("searchbox", { name: "Search" });
    await expect(page.locator("em-emoji-picker #root")).toHaveAttribute(
      "data-theme",
      "dark",
    );
    await search.fill("grinning");
    await page.getByRole("button", { name: "😀", exact: true }).click();
    await expect(input).toHaveJSProperty("value", "@Honey @Honey 😀");
    await expect(page.getByRole("textbox").locator(".inline-chip")).toHaveCount(
      2,
    );
    const chip = input.locator(".inline-chip").first();
    const recipients = page.getByRole("region", {
      name: "Explicit mentions",
    });
    await expect(recipients.getByRole("button")).toHaveCount(2);
    await expect(
      recipients.locator('.buzz-avatar[data-avatar-shape="circle"]'),
    ).toHaveCount(1);
    await expect(
      recipients.locator('.buzz-avatar[data-avatar-shape="squircle"]'),
    ).toHaveCount(1);
    await expect
      .poll(() =>
        recipients
          .locator("img")
          .evaluateAll(
            (images) =>
              images.length === 2 &&
              images.every((image) => image.complete && image.naturalWidth > 0),
          ),
      )
      .toBe(true);
    const mentionTool = page.getByRole("button", {
      name: "Mention a member",
      exact: true,
    });
    const emojiTool = page.getByRole("button", {
      name: "Insert emoji",
      exact: true,
    });
    await mentionTool.focus();
    for (const recipient of await recipients.getByRole("button").all()) {
      await page.keyboard.press("Tab");
      await expect(recipient).toBeFocused();
    }
    await page.keyboard.press("Tab");
    await expect(emojiTool).toBeFocused();
    const chipRoles = await chip.evaluate((element) => {
      const probe = document.createElement("span");
      probe.style.backgroundColor = "var(--affordance-accent)";
      probe.style.color = "var(--text-standard)";
      element.append(probe);
      const style = getComputedStyle(probe);
      const roles = { background: style.backgroundColor, text: style.color };
      probe.remove();
      return roles;
    });
    await expect(chip).toHaveCSS("background-color", chipRoles.background);
    await expect(chip).toHaveCSS("color", chipRoles.text);
    // Browser-only: shared chip geometry across themes/widths, without a
    // nested focus target or hover preview competing with native editing.
    for (const mode of ["light", "dark"]) {
      await page.evaluate((mode) => {
        document.documentElement.dataset.colorMode = mode;
      }, mode);
      for (const width of [360, 768, 1440]) {
        await page.setViewportSize({ width, height: 950 });
        const bounds = await input.boundingBox();
        for (const item of await input.locator(".inline-chip").all()) {
          const box = await item.boundingBox();
          expect(box.x).toBeGreaterThanOrEqual(bounds.x);
          expect(box.x + box.width).toBeLessThanOrEqual(
            bounds.x + bounds.width,
          );
        }
        // Avatars stay beside @, before Emoji, even on the narrow composer.
        const mentionBox = await mentionTool.boundingBox();
        const recipientsBox = await recipients.boundingBox();
        const emojiBox = await emojiTool.boundingBox();
        expect(recipientsBox.x).toBeGreaterThanOrEqual(
          mentionBox.x + mentionBox.width,
        );
        expect(recipientsBox.x + recipientsBox.width).toBeLessThanOrEqual(
          emojiBox.x,
        );
        expect(Math.abs(recipientsBox.y - mentionBox.y)).toBeLessThanOrEqual(2);
        await expect(input).toHaveJSProperty("value", "@Honey @Honey 😀");
      }
    }
    await chip.hover();
    await chip.click();
    await expect(input.locator("button, a, [tabindex], [title]")).toHaveCount(
      0,
    );
    await expect(page.locator(".buzz-preview-card")).toHaveCount(0);
    await input.press("Escape");
    await page.screenshot({
      path: test.info().outputPath("mention-recipients.png"),
    });
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.mentionFixture.publications.length ||
            window.mentionFixture
              .outbox()
              .map((item) => ({ state: item.delivery, error: item.error })),
        ),
      )
      .toBe(1);
    const first = await page.evaluate(
      () => window.mentionFixture.publications[0],
    );
    expect(first.content).toBe("@Honey @Honey 😀");
    expect(first.tags.filter(([tag]) => tag === "p")).toEqual([
      ["p", keys.first],
      ["p", keys.second],
    ]);
    expect(first.tags.filter(([tag]) => tag === "h")).toEqual([["h", "c"]]);
    await page.getByRole("button", { name: "Toggle thread" }).click();
    await choose(keys.second);
    await page.evaluate(() =>
      window.mentionFixture.change("disable", "buzz.mentions"),
    );
    await expect(
      page.getByRole("button", { name: "Mention a member", exact: true }),
    ).toHaveCount(0);
    await expect(page.getByRole("textbox").locator(".inline-chip")).toHaveCount(
      1,
    );
    await expect(recipients.getByRole("button")).toHaveCount(1);
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await expect
      .poll(() =>
        page.evaluate(() => window.mentionFixture.publications.length),
      )
      .toBe(2);
    const reply = await page.evaluate(
      () => window.mentionFixture.publications[1],
    );
    expect(reply.tags).toContainEqual(["e", "a".repeat(64), "", "reply"]);
    expect(reply.tags.filter(([tag]) => tag === "p")).toEqual([
      ["p", keys.second],
    ]);
    await page.evaluate(() =>
      window.mentionFixture.change("enable", "buzz.mentions"),
    );
    await expect.poll(order).toEqual(["Mention a member", "Insert emoji"]);
    await choose(keys.first);
    await page
      .getByRole("button", { name: "Remove first Honey", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await expect(page.getByRole("alert")).toContainText(
      "no longer a channel member",
    );
    await expect(
      page.getByRole("textbox", { name: "Reply to thread" }),
    ).toHaveJSProperty("value", "@Honey ");
    expect(
      await page.evaluate(() => window.mentionFixture.publications.length),
    ).toBe(2);
    // A child layout effect sees disabled DOM before parent command props refresh.
    // Both commands must fail, even with the previous render's enabled closures.
    await page
      .getByRole("button", { name: "Toggle disabled", exact: true })
      .click();
    await expect(
      page.getByRole("textbox", { name: "Reply to thread" }),
    ).toBeDisabled();
    await expect(recipients.getByRole("button")).toBeDisabled();
    expect(
      await page.evaluate(() => window.mentionFixture.disabledCalls),
    ).toEqual([{ inputDisabled: true, text: false, mention: false }]);
    await expect(
      page.getByRole("textbox", { name: "Reply to thread" }),
    ).toHaveJSProperty("value", "@Honey ");
    await expect(page.getByRole("textbox").locator(".inline-chip")).toHaveCount(
      1,
    );
    await expect(recipients.getByRole("button")).toHaveCount(1);
    await page
      .getByRole("button", { name: "Toggle disabled", exact: true })
      .click();
    await choose(keys.second);
    await expect(
      page.getByRole("textbox", { name: "Reply to thread" }),
    ).toHaveJSProperty("value", "@Honey @Honey ");
    await recipients
      .getByRole("button", {
        name: `Remove mention Honey ${keys.first}`,
        exact: true,
      })
      .click();
    await expect(page.getByRole("textbox")).toHaveJSProperty(
      "value",
      "@Honey @Honey ",
    );
    await expect(recipients.getByRole("button")).toHaveCount(1);
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await expect
      .poll(() =>
        page.evaluate(() => window.mentionFixture.publications.length),
      )
      .toBe(3);
    const afterRemoval = await page.evaluate(() =>
      window.mentionFixture.publications.at(-1),
    );
    expect(afterRemoval.content).toBe("@Honey @Honey");
    expect(afterRemoval.tags.filter(([tag]) => tag === "p")).toEqual([
      ["p", keys.second],
    ]);
    expect(errors).toEqual([]);
  } finally {
    await server.close();
  }
});

test("selected mentions inside code remain visible through draft restore and channel/reply publication", async ({
  page,
}) => {
  // Browser-only boundary: real picker insertion and source selection in a code literal.
  await page.addInitScript(() => {
    localStorage.setItem("buzz-remember-mentioned-agents.v1", "off");
  });
  const server = await createServer({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    configFile: false,
    envFile: false,
    plugins: [react()],
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
  });
  try {
    await server.listen();
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/mentions.html`,
    );
    const keys = await page.evaluate(() => [
      window.mentionFixture.first,
      window.mentionFixture.second,
    ]);
    const input = page.getByRole("textbox");
    const labels = ["@Honey", "@Honey (agent)"];
    for (const reply of [false, true]) {
      await input.fill("` `");
      await input.evaluate((element) => element.setSelectionRange(1, 1));
      for (const key of keys) {
        await page
          .getByRole("button", { name: "Mention a member", exact: true })
          .click();
        await page
          .getByRole("dialog", { name: "Mention a member or agent" })
          .getByRole("button", { name: new RegExp(key) })
          .click();
      }
      const source = "`@Honey @Honey  `";
      await expect(input).toHaveJSProperty("value", source);
      await expect(input.locator(".inline-chip")).toHaveText(labels);
      // Retargeting unmounts the destination's composer and restores its saved draft.
      await page.getByRole("button", { name: "Toggle thread" }).click();
      await expect(input).toHaveJSProperty("value", "");
      await page.getByRole("button", { name: "Toggle thread" }).click();
      await expect(input).toHaveJSProperty("value", source);
      await expect(input.locator(".inline-chip")).toHaveText(labels);
      await input.focus();
      await input.press("ControlOrMeta+a");
      const copied = await input.evaluate((element) => {
        const clipboardData = new DataTransfer();
        element.dispatchEvent(
          new ClipboardEvent("copy", {
            bubbles: true,
            cancelable: true,
            clipboardData,
          }),
        );
        return clipboardData.getData("text/plain");
      });
      expect(copied).toBe(source);
      await page
        .getByRole("button", { name: "Send message", exact: true })
        .click();
      await expect
        .poll(() =>
          page.evaluate(() => window.mentionFixture.publications.length),
        )
        .toBe(reply ? 2 : 1);
      const sent = await page.evaluate(() =>
        window.mentionFixture.publications.at(-1),
      );
      expect(sent.content).toBe(source);
      expect(sent.tags.filter(([tag]) => tag === "p")).toEqual(
        keys.map((key) => ["p", key]),
      );
      expect(sent.tags.filter(([tag]) => tag === "h")).toEqual([["h", "c"]]);
      expect(sent.tags.filter(([tag]) => tag === "e")).toEqual(
        reply ? [["e", "a".repeat(64), "", "reply"]] : [],
      );
      if (!reply)
        await page.getByRole("button", { name: "Toggle thread" }).click();
    }
  } finally {
    await server.close();
  }
});

// Browser-only contract: qualifiers remain visible without hover at touch width.
test("namesake recipient qualifiers remain visible on touch after live name changes", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  const page = await context.newPage();
  const server = await createServer({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    configFile: false,
    envFile: false,
    plugins: [react()],
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
  });
  try {
    await server.listen();
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/mentions.html?identity-names`,
    );
    await page.evaluate(() => {
      document.documentElement.dataset.colorMode = "dark";
    });
    const keys = await page.evaluate(() => [
      window.mentionFixture.first,
      window.mentionFixture.second,
    ]);
    const choose = async (key) => {
      await page
        .getByRole("button", { name: "Mention a member", exact: true })
        .tap();
      await page
        .getByRole("dialog", { name: "Mention a member or agent" })
        .getByRole("button", { name: new RegExp(key) })
        .tap();
    };
    await page.evaluate(() => window.mentionFixture.collide(false));
    await choose(keys[0]);
    await choose(keys[1]);
    const input = page.getByRole("textbox");
    const chips = input.locator(".inline-chip");
    const labels = keys.map((key) => `@Honey · ${npubEncode(key).slice(-4)}`);
    await expect(chips).toHaveText(["@Honey", "@Other Honey"]);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.evaluate(() => {
      window.qualifierReveals = [];
      document.addEventListener("animationstart", (event) => {
        if (event.animationName !== "inline-chip-qualifier-reveal") return;
        window.qualifierReveals.push(event.target);
        for (const animation of event.target.getAnimations()) {
          animation.pause();
          animation.currentTime = 0;
        }
      });
    });
    await page.evaluate(() => window.mentionFixture.collide(true));
    await expect
      .poll(() => page.evaluate(() => window.qualifierReveals.length))
      .toBe(2);
    const widths = await input
      .locator(".inline-chip-qualifier")
      .first()
      .evaluate((element) => {
        const animation = element.getAnimations()[0];
        const start = element.getBoundingClientRect().width;
        const duration = animation.effect.getTiming().duration;
        animation.currentTime = duration / 2;
        const middle = element.getBoundingClientRect().width;
        animation.finish();
        return { start, middle, end: element.getBoundingClientRect().width };
      });
    expect(widths.start).toBeLessThan(widths.middle);
    expect(widths.middle).toBeLessThan(widths.end);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(input.locator(".inline-chip-qualifier").first()).toHaveCSS(
      "animation-name",
      "none",
    );
    await expect(chips).toHaveText(labels);
    for (const chip of await chips.all()) {
      await expect(chip).toBeVisible();
      expect(
        await chip.evaluate((el) => {
          const rect = el.getBoundingClientRect();
          return rect.left >= 0 && rect.right <= innerWidth;
        }),
      ).toBe(true);
    }
    await page.screenshot({
      path: test.info().outputPath("recipient-qualifiers-touch.png"),
    });
    await input.evaluate((el) => el.setSelectionRange(7, 13));
    await input.press("Backspace");
    await expect(chips).toHaveText([labels[0]]);
    await choose(keys[1]);
    await expect(chips).toHaveText(labels);
    await page.evaluate(() => window.mentionFixture.collide(false));
    await expect(chips).toHaveText(["@Honey", "@Other Honey"]);
    await expect(input).toHaveJSProperty("value", "@Honey @Honey  ");
    await page.getByRole("button", { name: "Send message", exact: true }).tap();
    await expect
      .poll(() =>
        page.evaluate(() => window.mentionFixture.publications.length),
      )
      .toBe(1);
    const notified = await page.evaluate(() =>
      window.mentionFixture.publications[0].tags
        .filter((tag) => tag[0] === "p")
        .map((tag) => tag[1]),
    );
    expect(notified.sort()).toEqual(keys.sort());
  } finally {
    await context.close();
    await server.close();
  }
});
