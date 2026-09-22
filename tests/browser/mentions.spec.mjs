import { test, expect } from "@playwright/test";
import { createServer } from "./vite-server.mjs";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

test("actual composer selects namesakes by exact key, publishes channel/reply tags, and blocks removed members", async ({
  page,
}) => {
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
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/mentions.html?test-controls`,
    );
    const keys = await page.evaluate(() => ({
      first: window.mentionFixture.first,
      second: window.mentionFixture.second,
    }));
    // Real layout is required: the popup follows the whole composer, including
    // multiple lines of text, rather than the trigger's toolbar position.
    const expectComposerAnchor = async (popup) => {
      await expect(popup).toHaveClass(/buzz-popover/);
      expect(
        await popup.evaluate((element) => element.closest("form") === null),
      ).toBe(true);
      await expect(popup).toHaveCSS("border-radius", "24px");
      await expect
        .poll(() =>
          popup.evaluate((element) => {
            const composer = document.querySelector("form");
            return (
              composer.getBoundingClientRect().top -
              element.getBoundingClientRect().bottom
            );
          }),
        )
        .toBe(4);
    };
    const choose = async (key) => {
      await page
        .getByRole("button", { name: "Mention a member", exact: true })
        .click();
      const picker = page.getByRole("dialog", {
        name: "Mention a member or agent",
      });
      const search = picker.getByRole("searchbox");
      await search.fill(key);
      await expect(
        picker.getByRole("button", { name: `Honey ${key}`, exact: true }),
      ).toBeVisible();
      await expectComposerAnchor(picker);
      await search.press("ArrowDown");
      const choice = picker.getByRole("button", {
        name: `Honey ${key}`,
        exact: true,
      });
      await expect(choice).toBeFocused();
      await expect(choice).toHaveCSS("outline-style", "solid");
      await choice.press("Enter");
      await expect(picker).toHaveCount(0);
      await expect(page.getByRole("textbox")).toBeFocused();
    };
    const order = () =>
      page
        .getByRole("button", { name: /^(Mention a member|Insert emoji)$/ })
        .evaluateAll((buttons) =>
          buttons.map((button) => button.getAttribute("aria-label")),
        );
    await expect.poll(order).toEqual(["Mention a member", "Insert emoji"]);
    // Browser-only contract: native shadow search and React search share their
    // shape, typography, clear target and alignment in both appearance modes.
    const searchAppearance = (field) =>
      field.evaluate((element) => {
        const style = getComputedStyle(element);
        const input = getComputedStyle(element.querySelector("input"));
        const clear = element.querySelector("button");
        return {
          height: style.height,
          radius: style.borderRadius,
          padding: style.padding,
          background: style.backgroundColor,
          border: style.border,
          color: input.color,
          font: input.font,
          clear: clear && {
            width: getComputedStyle(clear).width,
            height: getComputedStyle(clear).height,
            radius: getComputedStyle(clear).borderRadius,
            color: getComputedStyle(clear).color,
          },
        };
      });
    for (const mode of ["light", "dark"]) {
      await page.evaluate((mode) => {
        document.documentElement.dataset.colorMode = mode;
      }, mode);
      await page
        .getByRole("button", { name: "Mention a member", exact: true })
        .click();
      const mention = page.getByRole("dialog", {
        name: "Mention a member or agent",
      });
      const row = mention.getByRole("button", {
        name: `Honey ${keys.first}`,
        exact: true,
      });
      await expect(row).toHaveCSS("padding", "8px");
      await row.hover();
      await expect(row).toHaveCSS(
        "background-color",
        mode === "light" ? "rgb(232, 232, 232)" : "rgb(64, 64, 64)",
      );
      await mention.getByRole("searchbox").fill("");
      const empty = await searchAppearance(mention.locator(".search-field"));
      await mention.getByRole("searchbox").fill("Honey");
      const filled = await searchAppearance(mention.locator(".search-field"));
      await page
        .getByRole("button", { name: "Insert emoji", exact: true })
        .click();
      const emojiField = page.locator("em-emoji-picker .search-field");
      await expect(emojiField).toBeVisible();
      expect(await searchAppearance(emojiField)).toEqual(empty);
      const emojiSearch = emojiField.getByRole("searchbox");
      await emojiSearch.fill("face");
      await expect(
        emojiField.getByRole("button", { name: "Clear", exact: true }),
      ).toBeVisible();
      expect(await searchAppearance(emojiField)).toEqual(filled);
      await emojiField
        .getByRole("button", { name: "Clear", exact: true })
        .click();
      await expect(emojiSearch).toHaveValue("");
      await expect(emojiSearch).toBeFocused();
      await emojiSearch.press("Escape");
    }
    await page.evaluate(() => {
      document.documentElement.dataset.colorMode = "light";
    });
    await choose(keys.first);
    await choose(keys.second);
    // The merged toolbar must preserve exact recipients while the new picker
    // inserts Unicode and follows the host mode without recreating the draft.
    const input = page.getByRole("textbox", { name: "Message #General" });
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
    await expectComposerAnchor(
      page.getByRole("dialog", { name: "Emoji picker" }),
    );
    await search.fill("grinning");
    await page.getByRole("button", { name: "😀", exact: true }).click();
    await expect(input).toHaveJSProperty("value", "@Honey @Honey 😀");
    await expect(
      page.getByRole("region", { name: "Notification recipients" }),
    ).toHaveCount(0);
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
    await expect(
      page.getByRole("region", { name: "Notification recipients" }),
    ).toHaveCount(0);
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
    expect(
      await page.evaluate(() => window.mentionFixture.disabledCalls),
    ).toEqual([{ inputDisabled: true, text: false, mention: false }]);
    await expect(
      page.getByRole("textbox", { name: "Reply to thread" }),
    ).toHaveJSProperty("value", "@Honey ");
    await expect(
      page.getByRole("region", { name: "Notification recipients" }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "Toggle disabled", exact: true })
      .click();
    await choose(keys.second);
    await expect(
      page.getByRole("textbox", { name: "Reply to thread" }),
    ).toHaveJSProperty("value", "@Honey @Honey ");
    expect(errors).toEqual([]);
  } finally {
    await server.close();
  }
});
