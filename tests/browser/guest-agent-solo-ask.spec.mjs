import { test, expect } from "./source-fixture.mjs";
import { watchPageErrors } from "./page-errors.mjs";

// Real browser walk for an agent that can't reply in a channel: the viewer's own
// agent is a Guest (Viewing only) in a private channel. The chooser says so, a
// send addressed only to it offers your Solo chat with it for that channel,
// and the question there links back.
// Set GUEST_ASK_SHOTS to a directory to keep demo screenshots.
const shots = process.env.GUEST_ASK_SHOTS;
async function shot(page, name, { project }) {
  if (!shots || project.name !== "chromium") return;
  // Dialogs and toasts animate in; capture them settled.
  await page.evaluate(() =>
    Promise.all(
      document.getAnimations().map((animation) => animation.finished),
    ),
  );
  await page.screenshot({ path: `${shots}/${name}.png` });
}

async function mention(page, composer, text) {
  await composer.click();
  await page.keyboard.type("@Poll");
  const row = page.getByRole("option", { name: /^Pollen / });
  await expect(row).toContainText(
    "Viewing only · Answers in your DM or a Solo chat",
  );
  return row.click().then(() => page.keyboard.type(` ${text}`));
}

// A conversation's pane is named after it.
const pane = (page, name) => page.getByRole("region", { name, exact: true });
// Opened from the confirmation, the Solo chat is a tab beside the channel.
const soloChat = (page) =>
  page.getByRole("tabpanel", { name: "launch-ask-pollen", exact: true });

/** Sends the composer's draft to Pollen through "Ask in a Solo chat", then
 * opens that chat from the confirmation. */
async function askInSolo(page) {
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Pollen can’t reply here" });
  await dialog.getByRole("button", { name: "Ask in a Solo chat" }).click();
  await expect(dialog).toBeHidden();
  // An earlier ask's confirmation may still be showing: the stack puts the
  // newest in front.
  const toast = page
    .locator('[data-sonner-toast][data-front="true"]')
    .getByRole("dialog", {
      name: "Asked Pollen in your Solo chat from #launch.",
    });
  await expect(toast).toBeVisible();
  return toast;
}

test("a Viewing-only agent is asked in your Solo chat, which later asks from the channel continue", async ({
  page,
}, testInfo) => {
  const errors = watchPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/tests/fixtures/guest-agent-solo-ask.html");
  await page
    .getByRole("button", { name: "Launch channel", exact: true })
    .click();
  const composer = page.getByRole("textbox", { name: "Message launch" });
  await composer.click();
  await page.keyboard.type("@Poll");
  const row = page.getByRole("option", { name: /^Pollen / });
  // Pollen is the viewer's Bestie, named ahead of the unchanged detail.
  await expect(row).toContainText(
    "Bestie · Viewing only · Answers in your DM or a Solo chat",
  );
  await shot(page, "1-chooser", testInfo);
  await row.click();
  await page.keyboard.type(" are we still on for Thursday?");
  await page.keyboard.press("Enter");

  const dialog = page.getByRole("dialog", { name: "Pollen can’t reply here" });
  await expect(dialog).toContainText(
    "Pollen is viewing only in #launch. Make it a member so it can reply here, or ask it in a Solo chat.",
  );
  await expect(
    dialog.getByRole("button", { name: "Send here anyway" }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Make member and send" }),
  ).toBeVisible();
  await shot(page, "2-dialog", testInfo);
  await dialog.getByRole("button", { name: "Ask in a Solo chat" }).click();
  await expect(dialog).toBeHidden();
  const toast = page.getByRole("dialog", {
    name: "Asked Pollen in your Solo chat from #launch.",
  });
  await expect(toast).toBeVisible();

  // The draft went to the Solo chat; nothing was posted in the channel, and
  // the viewer stays in it.
  await expect(composer).toHaveText("");
  await expect(
    pane(page, "launch").filter({ hasText: "are we still on for Thursday?" }),
  ).toHaveCount(0);
  await shot(page, "3-asked", testInfo);

  // A second ask from #launch continues the same chat.
  await mention(page, composer, "and who owns the checklist?");
  await (await askInSolo(page))
    .getByRole("button", { name: "Open", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => window.soloCreates))
    .toEqual([
      expect.objectContaining({
        name: "launch-ask-pollen",
        about: expect.stringMatching(
          /^Questions for Pollen from #launch: buzz:\/\/channel\/[0-9a-f-]{36}$/,
        ),
        members: [expect.any(String)],
        labels: expect.arrayContaining([
          "buzz.solo",
          expect.stringMatching(/^buzz\.ask:[0-9a-f-]{36}$/),
        ]),
      }),
    ]);
  // One chat in Solo, opened beside #launch, which stays open.
  await expect(
    page
      .locator('[data-sidebar-section="solo"]')
      .getByRole("button", { name: "launch-ask-pollen", exact: true }),
  ).toHaveCount(1);
  await expect(composer).toBeVisible();
  const chat = soloChat(page);
  await expect(chat).toContainText(
    /are we still on for Thursday\?\s*\(Asked from #launch, where you can’t reply\.\)/,
  );
  await expect(chat).toContainText(
    /and who owns the checklist\?\s*\(Asked from #launch, where you can’t reply\.\)/,
  );
  await shot(page, "4-solo-chat", testInfo);
  expect(errors.unexplained()).toEqual([]);
});

test("each channel asks in its own Solo chat", async ({ page }) => {
  const errors = watchPageErrors(page);
  await page.goto("/tests/fixtures/guest-agent-solo-ask.html");
  await page
    .getByRole("button", { name: "Launch channel", exact: true })
    .click();
  const composer = page.getByRole("textbox", { name: "Message launch" });
  await mention(page, composer, "first?");
  await askInSolo(page);
  // A thread in the same channel continues the channel's chat.
  const root = page
    .locator("[data-message-id]")
    .filter({ hasText: "Should we launch on Thursday?" })
    .first();
  await root.getByRole("button", { name: /1 reply/ }).click();
  const thread = page.getByRole("textbox", { name: /Reply/i });
  await mention(page, thread, "can you summarize this thread?");
  await (await askInSolo(page))
    .getByRole("button", { name: "Open", exact: true })
    .click();
  await expect(soloChat(page)).toContainText(
    /can you summarize this thread\?\s*\(Asked from a thread you can’t reply in: You in #launch\)/,
  );
  expect(
    (await page.evaluate(() => window.soloCreates)).map((chat) => chat.name),
  ).toEqual(["launch-ask-pollen"]);
  expect(errors.unexplained()).toEqual([]);
});

test("Send here anyway posts in the channel, and an agent outside it asks only once", async ({
  page,
}, testInfo) => {
  const errors = watchPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/tests/fixtures/guest-agent-solo-ask.html");
  await page
    .getByRole("button", { name: "Launch channel", exact: true })
    .click();
  const composer = page.getByRole("textbox", { name: "Message launch" });
  await mention(page, composer, "post this here please");
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Pollen can’t reply here" });
  await dialog.getByRole("button", { name: "Send here anyway" }).click();
  await expect(
    page
      .getByRole("region", { name: "launch", exact: true })
      .locator("[data-message-id]")
      .filter({ hasText: "post this here please" }),
  ).toHaveCount(1);
  await expect(composer).not.toContainText("post this here please");

  await page.goto("/tests/fixtures/guest-agent-solo-ask.html?guest=outside");
  await page
    .getByRole("button", { name: "Launch channel", exact: true })
    .click();
  await composer.click();
  await page.keyboard.type("@Poll");
  const row = page.getByRole("option", { name: /^Pollen / });
  await expect(row).toContainText("Not in channel");
  await row.click();
  await page.keyboard.type(" are you around?");
  await page.keyboard.press("Enter");
  await expect(dialog).toContainText(
    "Pollen isn’t in #launch. Add it to the channel so it can reply here, or ask it in a Solo chat.",
  );
  await shot(page, "5-outside-dialog", testInfo);
  await dialog.getByRole("button", { name: "Send here anyway" }).click();
  // This dialog already asked; the outside-people prompt doesn't follow it.
  await expect(
    page
      .getByRole("region", { name: "launch", exact: true })
      .locator("[data-message-id]")
      .filter({ hasText: "are you around?" }),
  ).toHaveCount(1);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await shot(page, "6-outside-send-anyway", testInfo);
  expect(errors.unexplained()).toEqual([]);
});

test("Make member and send lets a Viewing-only agent reply in the channel", async ({
  page,
}, testInfo) => {
  const errors = watchPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/tests/fixtures/guest-agent-solo-ask.html");
  await page
    .getByRole("button", { name: "Launch channel", exact: true })
    .click();
  const composer = page.getByRole("textbox", { name: "Message launch" });
  await mention(page, composer, "are we still on for Thursday?");
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Pollen can’t reply here" });
  await shot(page, "8-make-member-dialog", testInfo);
  await dialog.getByRole("button", { name: "Make member and send" }).click();
  await expect(dialog).toBeHidden();
  // The role change is confirmed first, then the draft posts here, notifying
  // Pollen, with no other prompt.
  const sent = page
    .getByRole("region", { name: "launch", exact: true })
    .locator("[data-message-id]")
    .filter({ hasText: "are we still on for Thursday?" });
  await expect(sent).toHaveCount(1);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(composer).not.toContainText("are we still on for Thursday?");
  // The chooser follows the new role on its own.
  await composer.click();
  await page.keyboard.type("@Poll");
  const row = page.getByRole("option", { name: /^Pollen / });
  await expect(row).toBeVisible();
  await expect(row).not.toContainText("Viewing only");
  await shot(page, "9-member-chooser", testInfo);
  await row.click();
  await page.keyboard.type(" thanks!");
  await page.keyboard.press("Enter");
  await expect(
    page
      .getByRole("region", { name: "launch", exact: true })
      .locator("[data-message-id]")
      .filter({ hasText: "thanks!" }),
  ).toHaveCount(1);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(errors.unexplained()).toEqual([]);
});

test("Add to channel and send adds an outside agent with one prompt", async ({
  page,
}, testInfo) => {
  const errors = watchPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/tests/fixtures/guest-agent-solo-ask.html?guest=outside");
  await page
    .getByRole("button", { name: "Launch channel", exact: true })
    .click();
  const composer = page.getByRole("textbox", { name: "Message launch" });
  await composer.click();
  await page.keyboard.type("@Poll");
  const row = page.getByRole("option", { name: /^Pollen / });
  await expect(row).toContainText("Not in channel");
  await row.click();
  await page.keyboard.type(" are you around?");
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Pollen can’t reply here" });
  await dialog.getByRole("button", { name: "Add to channel and send" }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page
      .getByRole("region", { name: "launch", exact: true })
      .locator("[data-message-id]")
      .filter({ hasText: "are you around?" }),
  ).toHaveCount(1);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await composer.click();
  await page.keyboard.type("@Poll");
  await expect(
    page.getByRole("option", { name: /^Pollen / }),
  ).not.toContainText("Not in channel");
  await shot(page, "10-added-chooser", testInfo);
  expect(errors.unexplained()).toEqual([]);
});

test("a refused role change keeps the draft and says why", async ({
  page,
}, testInfo) => {
  const errors = watchPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/tests/fixtures/guest-agent-solo-ask.html?refuse");
  await page
    .getByRole("button", { name: "Launch channel", exact: true })
    .click();
  const composer = page.getByRole("textbox", { name: "Message launch" });
  await mention(page, composer, "are we still on for Thursday?");
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Pollen can’t reply here" });
  await dialog.getByRole("button", { name: "Make member and send" }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Only channel owners and admins can change roles. Your draft is kept.",
  );
  await shot(page, "11-refused", testInfo);
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();
  await expect(composer).toContainText("are we still on for Thursday?");
  await expect(
    page
      .getByRole("region", { name: "launch", exact: true })
      .locator("[data-message-id]")
      .filter({ hasText: "are we still on for Thursday?" }),
  ).toHaveCount(0);
  expect(errors.unexplained()).toEqual([]);
});

test("a draft replaced in another window while the dialog is open isn't asked", async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await page.goto("/tests/fixtures/guest-agent-solo-ask.html");
  await page
    .getByRole("button", { name: "Launch channel", exact: true })
    .click();
  const composer = page.getByRole("textbox", { name: "Message launch" });
  await mention(page, composer, "are we still on for Thursday?");
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Pollen can’t reply here" });
  await expect(dialog).toBeVisible();
  // Another window of the app replaces #launch's saved draft.
  const other = await page.context().newPage();
  await other.goto("/tests/fixtures/guest-agent-solo-ask.html");
  await expect
    .poll(() =>
      other.evaluate(() => {
        const key = Object.keys(localStorage).find((item) =>
          /"draft:[0-9a-f-]{36}"\]$/.test(item),
        );
        if (!key) return false;
        localStorage.setItem(
          key,
          JSON.stringify({ text: "A newer question", recipients: [] }),
        );
        return true;
      }),
    )
    .toBe(true);
  await other.close();
  await dialog.getByRole("button", { name: "Ask in a Solo chat" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "This draft changed elsewhere.",
  );
  // Nothing was asked: no chat, no question, and this draft is kept.
  expect(await page.evaluate(() => window.soloCreates)).toEqual([]);
  expect(await page.evaluate(() => window.soloMessages)).toEqual([]);
  await expect(composer).toContainText("are we still on for Thursday?");
  expect(errors.unexplained()).toEqual([]);
});

test("a Solo chat the relay refuses gives the question back", async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await page.goto("/tests/fixtures/guest-agent-solo-ask.html?refuse-create");
  await page
    .getByRole("button", { name: "Launch channel", exact: true })
    .click();
  const composer = page.getByRole("textbox", { name: "Message launch" });
  await mention(page, composer, "are we still on for Thursday?");
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Pollen can’t reply here" });
  // Watch for the confirmation from the moment of the ask: a toast that shows
  // briefly and is replaced still counts.
  await page.evaluate(() => {
    const text = "Asked Pollen in your Solo chat from #launch.";
    const seen = () => document.body.innerText.includes(text);
    window.sawAskConfirmation = seen();
    new MutationObserver(() => {
      if (seen()) window.sawAskConfirmation = true;
    }).observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  });
  await dialog.getByRole("button", { name: "Ask in a Solo chat" }).click();
  await expect(
    page.getByRole("dialog", {
      name: "Couldn’t start your Solo chat with Pollen, so the question wasn’t sent. It’s back in your draft in #launch.",
    }),
  ).toBeVisible();
  await expect(composer).toContainText("are we still on for Thursday?");
  // Only the refusal is shown: no confirmation for a chat that never started.
  expect(await page.evaluate(() => window.sawAskConfirmation)).toBe(false);
  // The chat that never started is gone from Solo.
  await expect(
    page
      .locator('[data-sidebar-section="solo"]')
      .getByRole("button", { name: "launch-ask-pollen", exact: true }),
  ).toHaveCount(0);
  expect(errors.unexplained()).toEqual([]);
});

test("a refused chat gives the question back when clearing the draft had failed", async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await page.goto(
    "/tests/fixtures/guest-agent-solo-ask.html?refuse-create=held",
  );
  await page
    .getByRole("button", { name: "Launch channel", exact: true })
    .click();
  const composer = page.getByRole("textbox", { name: "Message launch" });
  await mention(page, composer, "are we still on for Thursday?");
  // Edits are saved after a pause in typing; wait until the question is saved.
  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.keys(localStorage).some(
          (key) =>
            key.includes('"draft:') &&
            localStorage
              .getItem(key)
              ?.includes("are we still on for Thursday?"),
        ),
      ),
    )
    .toBe(true);
  // The saved question can't be replaced with the cleared draft.
  await page.evaluate(() => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (window.failDraftWrites && key.includes('"draft:'))
        throw new DOMException("Storage is full.", "QuotaExceededError");
      return set.call(this, key, value);
    };
    window.failDraftWrites = true;
  });
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Pollen can’t reply here" });
  await dialog.getByRole("button", { name: "Ask in a Solo chat" }).click();
  const cleanup = page.getByRole("button", { name: "Retry draft cleanup" });
  await expect(cleanup).toBeVisible();
  await page.evaluate(() => window.refuseCreate());
  await expect(
    page.getByRole("dialog", {
      name: "Couldn’t start your Solo chat with Pollen, so the question wasn’t sent. It’s back in your draft in #launch.",
    }),
  ).toBeVisible();
  await expect(composer).toContainText("are we still on for Thursday?");
  // The cleanup is retired with the ask, so it can't erase the question.
  await expect(cleanup).toHaveCount(0);
  await page.evaluate(() => {
    window.failDraftWrites = false;
  });
  await composer.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Or Friday?");
  await expect(composer).toContainText(
    "are we still on for Thursday? Or Friday?",
  );
  expect(errors.unexplained()).toEqual([]);
});

test("a second ask while the first chat is still starting keeps both questions", async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  // Intercept only the OS clipboard boundary.
  await page.addInitScript(() => {
    window.copiedText = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text) => window.copiedText.push(text) },
    });
  });
  await page.clock.install();
  await page.goto(
    "/tests/fixtures/guest-agent-solo-ask.html?refuse-create=held",
  );
  await page
    .getByRole("button", { name: "Launch channel", exact: true })
    .click();
  const composer = page.getByRole("textbox", { name: "Message launch" });
  await mention(page, composer, "FIRST question, ");
  // Formatting is a mark on the editor's text, absent from its plain text.
  const bold = process.platform === "darwin" ? "Meta+b" : "Control+b";
  await page.keyboard.press(bold);
  await page.keyboard.type("urgent");
  await page.keyboard.press(bold);
  await expect(composer.locator("strong")).toHaveText("urgent");
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Pollen can’t reply here" });
  await dialog.getByRole("button", { name: "Ask in a Solo chat" }).click();
  await expect(dialog).toBeHidden();
  await expect(composer).not.toContainText("FIRST question");
  // The relay hasn't answered the first chat's create yet.
  await mention(page, composer, "SECOND question");
  await page.keyboard.press("Enter");
  await dialog.getByRole("button", { name: "Ask in a Solo chat" }).click();
  await expect(
    page.getByText(
      "Your Solo chat with Pollen is still starting. Ask again once it’s ready. Your draft is kept.",
    ),
  ).toBeVisible();
  await expect(composer).toContainText("SECOND question");
  // Only the first question waits on the chat.
  expect(
    await page.evaluate(() =>
      window.soloMessages.filter((message) =>
        message.content.includes("SECOND question"),
      ),
    ),
  ).toEqual([]);
  await page.evaluate(() => window.refuseCreate());
  const refused = page.getByRole("dialog", {
    name: "Couldn’t start your Solo chat with Pollen, so the question wasn’t sent.",
  });
  await expect(refused).toBeVisible();
  // The question in the draft is never replaced or lost.
  await expect(composer).toContainText("SECOND question");
  // The first question, which can't go back into the occupied draft, stays
  // on offer until it is copied, past an ordinary notice's 8 seconds.
  await page.clock.runFor(9000);
  await refused.getByRole("button", { name: "Copy question" }).click();
  await expect(
    page.getByRole("dialog", { name: "Question copied" }),
  ).toBeVisible();
  const [copied] = await page.evaluate(() => window.copiedText);
  expect(copied).toContain("FIRST question");
  expect(copied).toContain("**urgent**");
  await expect(composer).toContainText("SECOND question");
  expect(errors.unexplained()).toEqual([]);
});

for (const away of [false, true])
  test(`a file added while the chat starts keeps its draft when the relay refuses${
    away ? ", after the composer remounts" : ""
  }`, async ({ page }) => {
    const errors = watchPageErrors(page);
    await page.goto(
      "/tests/fixtures/guest-agent-solo-ask.html?refuse-create=held&files",
    );
    const launch = page.getByRole("button", {
      name: "Launch channel",
      exact: true,
    });
    await launch.click();
    const composer = page.getByRole("textbox", { name: "Message launch" });
    await mention(page, composer, "are we still on for Thursday?");
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", {
      name: "Pollen can’t reply here",
    });
    await dialog.getByRole("button", { name: "Ask in a Solo chat" }).click();
    await expect(composer).not.toContainText("Thursday");
    const form = page.locator("form").filter({ has: composer });
    await form.getByLabel("Choose attachments").setInputFiles({
      name: "later.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("later"),
    });
    await expect(
      form.getByRole("button", { name: "Remove later.txt" }),
    ).toBeVisible();
    if (away)
      await page
        .getByRole("button", { name: "Design channel", exact: true })
        .click();
    await page.evaluate(() => window.refuseCreate());
    // The newer file draft is the author's: the question isn't put back in it.
    await expect(
      page.getByRole("dialog", {
        name: "Couldn’t start your Solo chat with Pollen, so the question wasn’t sent.",
        exact: true,
      }),
    ).toBeVisible();
    if (away) await launch.click();
    await expect(
      form.getByRole("button", { name: "Remove later.txt" }),
    ).toBeVisible();
    await expect(composer).not.toContainText("Thursday");
    await expect(composer.getByText("@Pollen")).toHaveCount(0);
    expect(errors.unexplained()).toEqual([]);
  });

test("the question's skill and folder chips go with it to the Solo chat", async ({
  page,
}) => {
  const errors = watchPageErrors(page);
  await page.goto("/tests/fixtures/guest-agent-solo-ask.html?chips");
  await page
    .getByRole("button", { name: "Launch channel", exact: true })
    .click();
  const composer = page.getByRole("textbox", { name: "Message launch" });
  await expect(composer).toContainText("Use review in launch");
  await composer.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" @Poll");
  await page.getByRole("option", { name: /^Pollen / }).click();
  await askInSolo(page);
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.soloMessages.map((item) => ({
          content: item.content,
          tokens: item.tokens && JSON.parse(item.tokens),
        })),
      ),
    )
    .toEqual([
      {
        content: expect.stringMatching(
          /^Use \$review in \/work\/launch @Pollen/,
        ),
        tokens: [
          {
            kind: "skill",
            id: "/work/skills/review/SKILL.md",
            label: "review",
            target: expect.stringMatching(/^[0-9a-f]{64}$/),
          },
          { kind: "folder", id: "/work/launch", label: "launch" },
        ],
      },
    ]);
  expect(errors.unexplained()).toEqual([]);
});

for (const [guest, title] of [
  [
    "other",
    "someone else's Viewing-only agent sends as before, with no dialog",
  ],
  [
    "forged",
    "an agent whose profile falsely names you as owner is someone else's: no dialog",
  ],
])
  test(title, async ({ page }, testInfo) => {
    const errors = watchPageErrors(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/tests/fixtures/guest-agent-solo-ask.html?guest=${guest}`);
    await page
      .getByRole("button", { name: "Launch channel", exact: true })
      .click();
    const composer = page.getByRole("textbox", { name: "Message launch" });
    await composer.click();
    await page.keyboard.type("@Poll");
    const row = page.getByRole("option", { name: /^Pollen / });
    await expect(row).toContainText("Viewing only · Can’t reply here");
    await expect(row).not.toContainText("Bestie");
    if (guest === "other") await shot(page, "12-other-chooser", testInfo);
    await row.click();
    await page.keyboard.type(" can you take a look?");
    await page.keyboard.press("Enter");
    await expect(
      page
        .getByRole("region", { name: "launch", exact: true })
        .locator("[data-message-id]")
        .filter({ hasText: "can you take a look?" }),
    ).toHaveCount(1);
    // Its owner decides whether it joins; the viewer isn't asked.
    await expect(page.getByRole("dialog")).toHaveCount(0);
    if (guest === "other") await shot(page, "13-other-sent", testInfo);
    expect(errors.unexplained()).toEqual([]);
  });

test("a cold start labels the Viewing-only agent once the relay confirms membership", async ({
  page,
}, testInfo) => {
  const errors = watchPageErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  // As on app launch: Launch opens from saved membership before the relay
  // confirms it, and roles can't be read until then.
  await page.goto("/tests/fixtures/guest-agent-solo-ask.html?guest=cold");
  await page
    .getByRole("button", { name: "Launch channel", exact: true })
    .click();
  const composer = page.getByRole("textbox", { name: "Message launch" });
  await expect(composer).toBeVisible();
  await page.getByRole("button", { name: "Confirm membership" }).click();
  // No members panel: the first mention already knows Pollen is Viewing only.
  await composer.click();
  await page.keyboard.type("@Poll");
  const row = page.getByRole("option", { name: /^Pollen / });
  await expect(row).toContainText(
    "Viewing only · Answers in your DM or a Solo chat",
  );
  await shot(page, "7-cold-start-chooser", testInfo);
  await row.click();
  await page.keyboard.type(" are we still on for Thursday?");
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("dialog", { name: "Pollen can’t reply here" }),
  ).toBeVisible();
  expect(errors.unexplained()).toEqual([]);
});
