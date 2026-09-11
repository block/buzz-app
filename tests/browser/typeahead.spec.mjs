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
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
});
test.afterAll(async () => {
  await server?.close();
});
const open = async (page) => {
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/mentions.html`,
  );
  return page.getByRole("textbox", { name: "Message #General" });
};
test("typeahead replaces only the query and publishes selected namesake identity, including replies", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const input = await open(page);
  const keys = await page.evaluate(() => ({
    first: window.mentionFixture.first,
    second: window.mentionFixture.second,
  }));
  await input.fill("Before @Ho after");
  await input.evaluate((el) => {
    el.setSelectionRange(10, 10);
    el.dispatchEvent(new Event("select", { bubbles: true }));
  });
  const option = page.getByRole("option", {
    name: `Honey ${keys.second}`,
    exact: true,
  });
  await expect(option).toBeVisible();
  await option.click();
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("Before @Honey  after");
  await expect(
    page
      .getByRole("region", { name: "Notification recipients" })
      .getByRole("button"),
  ).toHaveCount(1);
  await input.press("Enter");
  await expect
    .poll(() => page.evaluate(() => window.mentionFixture.publications.length))
    .toBe(1);
  expect(
    await page.evaluate(() =>
      window.mentionFixture.publications[0].tags.filter(([tag]) => tag === "p"),
    ),
  ).toEqual([["p", keys.second]]);
  await page.getByRole("button", { name: "Toggle thread" }).click();
  const reply = page.getByRole("textbox", { name: "Reply to thread" });
  await reply.fill("@Ho");
  await expect(
    page.getByRole("option", { name: `Honey ${keys.first}`, exact: true }),
  ).toBeVisible();
  await page
    .getByRole("option", { name: `Honey ${keys.first}`, exact: true })
    .click();
  await page.evaluate(() =>
    window.mentionFixture.change("disable", "buzz.mentions"),
  );
  await reply.press("Enter");
  await expect
    .poll(() => page.evaluate(() => window.mentionFixture.publications.length))
    .toBe(2);
  const sent = await page.evaluate(() => window.mentionFixture.publications[1]);
  expect(sent.tags).toContainEqual(["e", "a".repeat(64), "", "reply"]);
  expect(sent.tags.filter(([tag]) => tag === "p")).toEqual([["p", keys.first]]);
  expect(errors).toEqual([]);
});
test("emoji keyboard, Escape, selected text, blur, IME and plugin disable preserve ordinary editing", async ({
  page,
}) => {
  const input = await open(page);
  await input.fill(":smile");
  await expect(page.getByRole("option").first()).toContainText(":smile:");
  await input.press("Tab");
  await expect(input).toHaveValue("😄 ");
  await expect(input).toBeFocused();
  expect(
    await page.evaluate(() => window.mentionFixture.publications.length),
  ).toBe(0);
  await input.fill(":smile");
  await expect(page.getByRole("option").first()).toBeVisible();
  await input.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await input.press("Shift+Enter");
  await expect(input).toHaveValue(":smile\n");
  await input.fill(":smile");
  await expect(page.getByRole("option").first()).toBeVisible();
  await input.evaluate((el) => {
    el.setSelectionRange(1, 4);
    el.dispatchEvent(new Event("select", { bubbles: true }));
  });
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await input.fill(":smile");
  await input.evaluate((el) =>
    el.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    ),
  );
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await input.dispatchEvent("keydown", {
    key: "Enter",
    isComposing: true,
    keyCode: 229,
  });
  expect(
    await page.evaluate(() => window.mentionFixture.publications.length),
  ).toBe(0);
  await input.evaluate((el) =>
    el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })),
  );
  await expect(page.getByRole("option").first()).toBeVisible();
  await page.evaluate(() =>
    window.mentionFixture.change("disable", "buzz.emoji"),
  );
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(input).toHaveValue(":smile");
});
test("completion resumes after selection collapses to the original caret", async ({
  page,
}) => {
  const input = await open(page);
  await input.fill(":smile");
  await expect(page.getByRole("option").first()).toContainText(":smile:");
  await input.press("Shift+ArrowLeft");
  expect(
    await input.evaluate((el) => [el.selectionStart, el.selectionEnd]),
  ).toEqual([5, 6]);
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await input.press("ArrowRight");
  expect(
    await input.evaluate((el) => [el.selectionStart, el.selectionEnd]),
  ).toEqual([6, 6]);
  await expect(page.getByRole("option").first()).toContainText(":smile:");
  await input.press("Tab");
  await expect(input).toHaveValue("😄 ");
  await expect(input).toBeFocused();
});
test("selection recovery requires fresh results and preserves Escape dismissal", async ({
  page,
}) => {
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/typeahead.html`,
  );
  const input = page.getByRole("textbox", { name: "Message #Test" });
  const requests = () =>
    page.evaluate(() => window.completionFixture.queries().length);
  const publish = (index) =>
    page.evaluate(
      (index) =>
        window.completionFixture.publish(index, {
          items: [{ id: "choice", label: "Choice", edit: { text: "chosen" } }],
        }),
      index,
    );
  await input.fill("!selection");
  await expect.poll(requests).toBeGreaterThan(0);
  const before = await requests();
  expect(await publish(before - 1)).toBe(true);
  await expect(page.getByRole("option", { name: "Choice" })).toBeVisible();
  await input.press("Shift+ArrowLeft");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  expect(await publish(before - 1)).toBe(false);
  await input.press("ArrowRight");
  await expect.poll(requests).toBeGreaterThan(before);
  expect(await publish(before - 1)).toBe(false);
  const after = await requests();
  expect(await publish(after - 1)).toBe(true);
  await expect(page.getByRole("option", { name: "Choice" })).toBeVisible();
  await input.press("Escape");
  // Redundant same-caret notifications must not undo deliberate dismissal.
  await input.evaluate((el) => {
    el.dispatchEvent(new Event("select", { bubbles: true }));
    el.ownerDocument.dispatchEvent(new Event("selectionchange"));
  });
  await expect(page.getByRole("listbox")).toHaveCount(0);
  expect(await requests()).toBe(after);
  expect(await publish(after - 1)).toBe(false);
  await expect(input).toHaveValue("!selection");
  expect(
    await page.evaluate(() => window.completionFixture.publications.length),
  ).toBe(0);
});
test("textarea exposes its listbox popup relationship only while suggestions are open", async ({
  page,
}) => {
  const input = await open(page);
  const attributes = [
    "aria-autocomplete",
    "aria-haspopup",
    "aria-controls",
    "aria-activedescendant",
  ];
  for (const attribute of attributes)
    await expect(input).not.toHaveAttribute(attribute);
  for (const close of ["escape", "accept", "blur", "disable"]) {
    await input.fill(":smile");
    const list = page.getByRole("listbox", { name: "Emoji suggestions" });
    await expect(list).toBeVisible();
    await expect(input).toHaveRole("textbox");
    expect(await input.evaluate((el) => el.tagName)).toBe("TEXTAREA");
    await expect(input).toHaveAttribute("aria-autocomplete", "list");
    await expect(input).toHaveAttribute("aria-haspopup", "listbox");
    await expect(input).toHaveAttribute(
      "aria-controls",
      await list.getAttribute("id"),
    );
    await expect(input).toHaveAttribute(
      "aria-activedescendant",
      await list.getByRole("option", { selected: true }).getAttribute("id"),
    );
    if (close === "escape") await input.press("Escape");
    else if (close === "accept") await input.press("Tab");
    else if (close === "blur") await input.evaluate((el) => el.blur());
    else
      await page.evaluate(() =>
        window.mentionFixture.change("disable", "buzz.emoji"),
      );
    await expect(list).toHaveCount(0);
    for (const attribute of attributes)
      await expect(input).not.toHaveAttribute(attribute);
    await expect(input).toHaveRole("textbox");
  }
});
test("late publications cannot cross edits, ABA, Escape, blur, plugin replacement or destinations", async ({
  page,
}) => {
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/typeahead.html`,
  );
  const input = page.getByRole("textbox", { name: "Message #Test" });
  const latest = async () => {
    await expect
      .poll(() =>
        page.evaluate(() => window.completionFixture.queries().length),
      )
      .toBeGreaterThan(0);
    return page.evaluate(() => window.completionFixture.queries().length - 1);
  };
  const publish = (index, text = "chosen") =>
    page.evaluate(
      ({ index, text }) =>
        window.completionFixture.publish(index, {
          items: [{ id: text, label: text, edit: { text } }],
        }),
      { index, text },
    );
  await input.fill("!a");
  const old = await latest();
  await input.fill("!b");
  await input.fill("!a");
  await expect.poll(latest).toBeGreaterThan(old);
  expect(await publish(old, "STALE ABA")).toBe(false);
  const current = await latest();
  expect(await publish(current)).toBe(true);
  await expect(
    page.getByRole("option", { name: "chosen", exact: true }),
  ).toBeVisible();
  await input.press("Escape");
  expect(await publish(current, "STALE ESCAPE")).toBe(false);
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await input.fill("!blur");
  const blurred = await latest();
  await page.getByRole("textbox", { name: "Message #Other" }).focus();
  expect(await publish(blurred)).toBe(false);
  await input.focus();
  const removed = await latest();
  await page.evaluate(() => window.completionFixture.change("disable"));
  expect(await publish(removed)).toBe(false);
  await page.evaluate(() => window.completionFixture.change("enable"));
  expect(await publish(removed)).toBe(false);
  await input.fill("!scope");
  const scoped = await latest();
  await page.getByRole("button", { name: "Switch session" }).click();
  expect(await publish(scoped)).toBe(false);
  await expect(
    page.getByRole("textbox", { name: "Message #Test" }),
  ).toHaveValue("");
});
test("selection follows IDs through reordering and rejected replacement never falls through to send", async ({
  page,
}) => {
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/typeahead.html`,
  );
  const input = page.getByRole("textbox", { name: "Message #Test" });
  await input.fill("!order");
  await expect
    .poll(() => page.evaluate(() => window.completionFixture.queries().length))
    .toBeGreaterThan(0);
  const index = await page.evaluate(
    () => window.completionFixture.queries().length - 1,
  );
  const publish = (items) =>
    page.evaluate(
      ({ index, items }) => window.completionFixture.publish(index, { items }),
      { index, items },
    );
  const a = { id: "a", label: "Alpha", edit: { text: "A" } },
    b = { id: "b", label: "Beta", edit: { text: "B" } };
  expect(await publish([a, b])).toBe(true);
  await input.press("ArrowDown");
  await expect(page.getByRole("option", { name: "Beta" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(await publish([b, a])).toBe(true);
  await expect(page.getByRole("option").first()).toHaveText("Beta");
  await expect(page.getByRole("option", { name: "Beta" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await input.press("Enter");
  await expect(input).toHaveValue("B ");
  await input.fill("!limit");
  const next = await page.evaluate(
    () => window.completionFixture.queries().length - 1,
  );
  await page.evaluate(
    (index) =>
      window.completionFixture.publish(index, {
        items: [
          { id: "long", label: "Too long", edit: { text: "x".repeat(16001) } },
        ],
      }),
    next,
  );
  await input.press("Enter");
  await expect(input).toHaveValue("!limit");
  await expect(page.getByRole("alert")).toContainText("too long");
  expect(
    await page.evaluate(() => window.completionFixture.publications.length),
  ).toBe(0);
});
test("current custom catalog drives typeahead and signed tags across community replacement", async ({
  page,
}) => {
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/emoji.html`,
  );
  const input = page.getByRole("textbox", { name: "Message #general" });
  await input.fill(":party-par");
  const first = page.getByRole("option", {
    name: ":party-parrot: Community emoji",
    exact: true,
  });
  await expect(first).toBeVisible();
  await first.click();
  await expect(input).toHaveValue(":party-parrot: ");
  await input.press("Enter");
  await expect
    .poll(() =>
      page.evaluate(() => window.emojiFixture.report.publications.length),
    )
    .toBe(1);
  expect(
    await page.evaluate(
      () => window.emojiFixture.report.publications[0].event.tags,
    ),
  ).toContainEqual([
    "emoji",
    "party-parrot",
    "https://a.test/media/parrot.png",
  ]);
  await input.fill(":party");
  await expect(
    page.getByRole("option", { name: ":party: Community emoji", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => window.emojiFixture.remove());
  await expect(
    page.getByRole("option", { name: ":party: Community emoji", exact: true }),
  ).toHaveCount(0);
  await input.press("Escape");
  await page.getByRole("button", { name: "Switch community" }).click();
  await input.fill(":party");
  await page
    .getByRole("option", { name: ":party: Community emoji", exact: true })
    .click();
  await input.press("Enter");
  await expect
    .poll(() =>
      page.evaluate(() => window.emojiFixture.report.publications.length),
    )
    .toBe(2);
  expect(
    await page.evaluate(
      () => window.emojiFixture.report.publications[1].event.tags,
    ),
  ).toContainEqual(["emoji", "party", "https://b.test/media/1.png"]);
});

test("mention choices survive unrelated list updates but revoke removed membership", async ({
  page,
}) => {
  const input = await open(page);
  const keys = await page.evaluate(() => ({
    first: window.mentionFixture.first,
    second: window.mentionFixture.second,
  }));
  await input.fill("@Ho");
  const first = page.getByRole("option", {
    name: `Honey ${keys.first}`,
    exact: true,
  });
  const second = page.getByRole("option", {
    name: `Honey ${keys.second}`,
    exact: true,
  });
  await expect(first).toBeVisible();
  await page.evaluate(() => window.mentionFixture.refresh());
  await expect(first).toBeVisible();
  await page.evaluate(() => window.mentionFixture.otherMessage());
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.mentionFixture.list().channels.find((c) => c.id === "other")
            ?.preview,
      ),
    )
    .toBe("Unrelated preview");
  await expect(first).toBeVisible();
  await page.evaluate(() => window.mentionFixture.removeFirst());
  await expect(first).toHaveCount(0);
  await expect(second).toBeVisible();
  await second.click();
  await expect(input).toHaveValue("@Honey ");
  await input.press("Enter");
  await expect
    .poll(() => page.evaluate(() => window.mentionFixture.publications.length))
    .toBe(1);
  expect(
    await page.evaluate(() =>
      window.mentionFixture.publications[0].tags.filter(([tag]) => tag === "p"),
    ),
  ).toEqual([["p", keys.second]]);
});

test("cold multi-word mention query wakes when profiles arrive without another keystroke", async ({
  page,
}) => {
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/mentions.html?delayed-profiles`,
  );
  const input = page.getByRole("textbox", { name: "Message #General" });
  await input.fill("@Mary J");
  await expect(page.getByRole("option", { name: /^Mary Jane / })).toHaveCount(
    0,
  );
  await page.evaluate(() => window.mentionFixture.releaseProfiles());
  const choice = page.getByRole("option", { name: /^Mary Jane / });
  await expect(choice).toBeVisible();
  await input.press("Enter");
  await expect(input).toHaveValue("@Mary Jane ");
  await expect(page.getByRole("listbox")).toHaveCount(0);
});

test("recovery is a keyboard-selectable action without transferring editor focus", async ({
  page,
}) => {
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/typeahead.html`,
  );
  const input = page.getByRole("textbox", { name: "Message #Test" });
  for (const withChoice of [false, true]) {
    await input.fill(`!retry-${withChoice}`);
    const index = await page.evaluate(
      () => window.completionFixture.queries().length - 1,
    );
    await page.evaluate(
      ({ index, withChoice }) =>
        window.completionFixture.fail(index, withChoice),
      { index, withChoice },
    );
    if (withChoice) await input.press("ArrowUp");
    const retry = page.getByRole("option", { name: "Retry suggestions" });
    await expect(retry).toHaveAttribute("aria-selected", "true");
    await input.press("Enter");
    await expect(page.getByRole("option", { name: "Recovered" })).toBeVisible();
    await expect(input).toBeFocused();
    await expect(input).toHaveValue(`!retry-${withChoice}`);
    await input.press("Tab");
    await expect(input).toHaveValue("recovered ");
  }
  expect(await page.evaluate(() => window.completionFixture.retries())).toBe(2);
  expect(
    await page.evaluate(() => window.completionFixture.publications.length),
  ).toBe(0);
});

test("channel and actual ThreadPanel composers keep separate completion and draft ownership", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 520 });
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/messages.html`,
  );
  const main = page.getByRole("textbox", { name: "Message #one" });
  const thread = page.getByRole("textbox", { name: "Reply to thread" });
  await expect(thread).toBeVisible();
  await main.fill(":smile");
  await expect(page.getByRole("option").first()).toBeVisible();
  const mainControls = await main.getAttribute("aria-controls");
  await thread.fill("@Fixture");
  const option = page.getByRole("option", { name: /^Fixture Reader / });
  await expect(option).toBeVisible();
  await expect(main).not.toHaveAttribute("aria-controls");
  expect(await thread.getAttribute("aria-controls")).not.toBe(mainControls);
  await option.click();
  await expect(thread).toBeFocused();
  await expect(thread).toHaveValue("@Fixture Reader ");
  await expect(main).toHaveValue(":smile");
  await main.focus();
  await expect(page.getByRole("option").first()).toContainText(":smile:");
  await main.press("Tab");
  await expect(main).toHaveValue("😄 ");
  await expect(thread).toHaveValue("@Fixture Reader ");
});

test("disabled and read-only DOM state reject late publications and displayed choices", async ({
  page,
}) => {
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/typeahead.html`,
  );
  const input = page.getByRole("textbox", { name: "Message #Test" });
  await input.fill("!disabled");
  const old = await page.evaluate(
    () => window.completionFixture.queries().length - 1,
  );
  await page.getByRole("button", { name: "Toggle disabled" }).click();
  await expect(input).toBeDisabled();
  expect(
    await page.evaluate(
      (index) =>
        window.completionFixture.publish(index, {
          items: [{ id: "bad", label: "Bad", edit: { text: "bad" } }],
        }),
      old,
    ),
  ).toBe(false);
  await page.getByRole("button", { name: "Toggle disabled" }).click();
  await input.fill("!readonly");
  const current = await page.evaluate(
    () => window.completionFixture.queries().length - 1,
  );
  await page.evaluate(
    (index) =>
      window.completionFixture.publish(index, {
        items: [{ id: "bad", label: "Bad", edit: { text: "bad" } }],
      }),
    current,
  );
  await expect(page.getByRole("option", { name: "Bad" })).toBeVisible();
  await input.evaluate((el) => {
    el.readOnly = true;
  });
  await input.press("Enter");
  await expect(input).toHaveValue("!readonly");
  expect(
    await page.evaluate(() => window.completionFixture.publications.length),
  ).toBe(0);
});

test("a later emoji trigger wins after a mention without discarding recipient intent", async ({
  page,
}) => {
  const input = await open(page);
  const key = await page.evaluate(() => window.mentionFixture.first);
  await input.fill("@Ho");
  await page.getByRole("option", { name: `Honey ${key}`, exact: true }).click();
  await input.pressSequentially(":smile");
  await expect(page.getByRole("option").first()).toContainText(":smile:");
  await input.press("Tab");
  await expect(input).toHaveValue("@Honey 😄 ");
  await input.press("Enter");
  await expect
    .poll(() => page.evaluate(() => window.mentionFixture.publications.length))
    .toBe(1);
  expect(
    await page.evaluate(() =>
      window.mentionFixture.publications[0].tags.filter(([tag]) => tag === "p"),
    ),
  ).toEqual([["p", key]]);
  await input.fill("@Honey :smile");
  await expect(page.getByRole("option").first()).toContainText(":smile:");
  await input.press("Tab");
  await expect(input).toHaveValue("@Honey 😄 ");
  await expect(
    page.getByRole("region", { name: "Notification recipients" }),
  ).toHaveCount(0);
});

test("portal bounds hold when the focused composer moves outside the viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 300 });
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/typeahead.html`,
  );
  const input = page.getByRole("textbox", { name: "Message #Test" });
  await input.fill("!geometry");
  const index = await page.evaluate(
    () => window.completionFixture.queries().length - 1,
  );
  await page.evaluate(
    (index) =>
      window.completionFixture.publish(index, {
        items: Array.from({ length: 20 }, (_, i) => ({
          id: String(i),
          label: `Choice ${i}`,
          edit: { text: `choice-${i}` },
        })),
      }),
    index,
  );
  const popup = page.getByRole("region", { name: "Delayed suggestions" });
  await expect(popup).toBeVisible();
  for (const y of [2000, -2000, 0]) {
    await input.evaluate((el, y) => {
      el.closest("form").style.transform = `translateY(${y}px)`;
      window.dispatchEvent(new Event("resize"));
    }, y);
    await expect
      .poll(() =>
        popup.evaluate((el) => {
          const r = el.getBoundingClientRect();
          const viewport = window.visualViewport;
          return (
            r.top >= viewport.offsetTop &&
            r.bottom <= viewport.offsetTop + viewport.height
          );
        }),
      )
      .toBe(true);
    await expect(input).toBeFocused();
  }
});
