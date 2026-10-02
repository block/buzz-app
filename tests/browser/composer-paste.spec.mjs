import { npubEncode } from "nostr-tools/nip19";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({ productionBroker: true });

// The timeline labels a message link with its channel name.
const link = `buzz://message?channel=alpha&id=${"b".repeat(64)}`;
const anchors = (viewer) =>
  `Ping <a href="nostr:${npubEncode(viewer)}">@Fixture Reader</a> about <a href="buzz://channel/beta">#Beta</a> and <a href="${link.replace("&", "&amp;")}">Alpha</a>`;

/** Deliver both flavors at once, as a real clipboard does. */
const pasteInto = (input, payload) =>
  input.evaluate((element, { text, html }) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", text);
    clipboardData.setData("text/html", html);
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }),
    );
  }, payload);

// Browser-only contract: an engine-native pointer selection copied from the
// timeline reaches the composer through real clipboard flavors, DOMParser and
// the live session's mention candidates, then round-trips composer → composer.
// Serializer and promotion cases live in the colocated Vitest files.
test("pasting copied messages into the composer restores chips, the recipient and links", async ({
  page,
  app,
  browserName,
}) => {
  await open(page, app);
  const event = app.append(
    "primary",
    "alpha",
    `Ping @Fixture Reader about #Beta and ${link}`,
    true,
    true,
    undefined,
    undefined,
    [["p", app.viewer]],
  );
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${event.id}"]`,
  );
  await expect(
    row.getByRole("button", { name: "View Fixture Reader profile" }),
  ).toBeVisible();
  await expect(row.getByRole("link", { name: "#Beta" })).toBeVisible();
  const paragraph = row.locator("p").first();
  const box = await paragraph.boundingBox();
  await page.mouse.move(box.x + 1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, {
    steps: 12,
  });
  await page.mouse.up();
  await page.evaluate(() => {
    window.__copyPayload = undefined;
    document.addEventListener(
      "copy",
      (event) => {
        window.__copyPayload = {
          text: event.clipboardData?.getData("text/plain"),
          html: event.clipboardData?.getData("text/html"),
        };
      },
      { once: true },
    );
  });
  // See timeline-copy.spec.mjs for the WebKit copy command.
  if (browserName === "webkit")
    expect(await page.evaluate(() => document.execCommand("copy"))).toBe(true);
  else await page.keyboard.press("ControlOrMeta+c");
  const timeline = {
    text: `Ping @Fixture Reader about #Beta and Alpha (${link})`,
    html: `<div data-buzz-copy="timeline"><p>${anchors(app.viewer)}</p></div>`,
  };
  await expect
    .poll(() => page.evaluate(() => window.__copyPayload))
    .toEqual(timeline);

  const input = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  const recipients = page.getByRole("region", { name: "Explicit mentions" });
  const source = `Ping @Fixture Reader about [#Beta](buzz://channel/beta) and [Alpha](${link})`;
  await input.click();
  await pasteInto(input, timeline);
  await expect(input).toHaveJSProperty("value", source);
  await expect(input.locator("[data-source]")).toHaveCount(3);
  await expect(input.locator(".inline-chip").first()).toHaveText(
    "@Fixture Reader",
  );
  await expect(recipients).toBeVisible();

  // Composer → composer keeps the recipient through the composer's own flavors.
  const composer = await input.evaluate((element) => {
    element.setSelectionRange(0, element.value.length);
    const clipboardData = new DataTransfer();
    element.dispatchEvent(
      new ClipboardEvent("copy", {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }),
    );
    return {
      text: clipboardData.getData("text/plain"),
      html: clipboardData.getData("text/html"),
    };
  });
  // text/plain stays Markdown source except for identity and channel locators.
  expect(composer).toEqual({
    text: `Ping @Fixture Reader about #Beta and [Alpha](${link})`,
    html: `<div data-buzz-copy="composer"><p>${anchors(app.viewer)}</p></div>`,
  });
  await input.fill("");
  await expect(recipients).toBeHidden();
  await pasteInto(input, composer);
  await expect(input).toHaveJSProperty("value", source);
  await expect(recipients).toBeVisible();

  await input.press("Enter");
  await expect.poll(() => app.report.publications.length).toBe(1);
  const published = app.report.publications[0].event;
  expect(published.content).toBe(source);
  expect(published.tags).toContainEqual(["p", app.viewer]);
});
