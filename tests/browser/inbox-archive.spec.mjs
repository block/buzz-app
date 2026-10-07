import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";

const channel = "f12918e7-88d0-4ddd-aa6b-d4888ff6d3bd";
test.use({
  productionBroker: true,
  readState: true,
  inboxThreadWindow: true,
  agentPeers: true,
  inboxSessionAgent: true,
  pluginFixtures: true,
  channelIds: ["alpha", channel],
  channelNames: { [channel]: "Archive room" },
  historyCounts: { alpha: 1, [channel]: 0 },
  screenshot: "off",
});

async function choose(page, inbox, control, option) {
  await inbox.getByRole("combobox", { name: control }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
  await expect(inbox.getByRole("combobox", { name: control })).toContainText(
    option,
  );
}

test("Inbox Show filter is separate from attention filters and preserves them", async ({
  page,
  app,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(app.origin);
  await openPage(page, "Inbox");
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  const rows = inbox
    .getByRole("list", { name: "Inbox conversations" })
    .getByRole("listitem");

  await expect(inbox.getByRole("combobox", { name: "Show" })).toContainText(
    "Inbox",
  );
  await expect(
    inbox.getByRole("button", { name: "About Inbox archive" }),
  ).toHaveCount(0);
  await expect(rows).toHaveCount(1);
  const rowArchive = rows.getByRole("button", { name: /^Archive / });
  await page.mouse.move(0, 0);
  await expect(rowArchive.locator("xpath=..")).toHaveCSS("opacity", "0");
  await rows.hover();
  await expect(rowArchive.locator("xpath=..")).toHaveCSS("opacity", "1");

  await choose(page, inbox, "Activity type", "Mentions");
  await choose(page, inbox, "Sender", "Agents");
  await inbox.getByRole("checkbox", { name: "Unread only" }).check();
  await rows.getByRole("button", { name: /^Open / }).focus();
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menuitem", { name: "Archive conversation" }).click();
  await expect(rows).toHaveCount(0);

  await choose(page, inbox, "Show", "Archived");
  await expect(rows).toHaveCount(1);
  await expect(inbox.getByRole("combobox", { name: "Sender" })).toContainText(
    "Agents",
  );
  await expect(
    inbox.getByRole("checkbox", { name: "Unread only" }),
  ).toBeChecked();
  await page.mouse.move(800, 300);
  await page.screenshot({
    path: testInfo.outputPath("inbox-archived-scope.png"),
    fullPage: true,
  });

  await choose(page, inbox, "Show", "Inbox + archived");
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText("Archived");
  await choose(page, inbox, "Show", "Inbox");
  await expect(rows).toHaveCount(0);
  await expect(
    inbox.getByRole("combobox", { name: "Activity type" }),
  ).toContainText("Mentions");
  await expect(inbox.getByRole("combobox", { name: "Sender" })).toContainText(
    "Agents",
  );
  await expect(
    inbox.getByRole("checkbox", { name: "Unread only" }),
  ).toBeChecked();
});

test("Inbox archive survives reload, restores, and reopens on a new mention", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Inbox");
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  const rows = inbox
    .getByRole("list", { name: "Inbox conversations" })
    .getByRole("listitem");
  await expect(rows).toHaveCount(1);
  await rows.getByRole("button", { name: /^Open / }).click();
  await inbox.getByRole("button", { name: "Archive conversation" }).click();
  await expect(rows).toHaveCount(0);
  await expect(inbox.getByRole("region", { name: "Inbox detail" })).toHaveCount(
    0,
  );
  await page.reload();
  await openPage(page, "Inbox");
  await expect(inbox.getByText("Checking recent activity…")).toHaveCount(0);
  await expect(rows).toHaveCount(0);
  await choose(page, inbox, "Show", "Archived");
  await expect(rows).toHaveCount(1);
  await rows.getByRole("button", { name: /^Open / }).focus();
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menuitem", { name: "Restore conversation" }).click();
  await expect(rows).toHaveCount(0);
  await choose(page, inbox, "Show", "Inbox");
  await expect(rows).toHaveCount(1);
  await rows.getByRole("button", { name: /^Open / }).focus();
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menuitem", { name: "Archive conversation" }).click();
  await expect(rows).toHaveCount(0);
  const { root } = app.inboxWindow;
  const seed = app.sign({
    kind: 9,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["h", channel],
      ["e", root.id, "", "reply"],
    ],
    content: "Our current context",
  });
  app.histories.get(`primary/${channel}`).push(seed);
  app.relay.publish("primary", seed);
  app.append("primary", channel, "Agent progress", true, false, root.id);
  await choose(page, inbox, "Show", "Archived");
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText("Archive room");
  await choose(page, inbox, "Show", "Inbox");
  await expect(rows).toHaveCount(0);
  app.append(
    "primary",
    channel,
    "John, please decide",
    true,
    false,
    root.id,
    undefined,
    [["p", app.viewer]],
  );
  await expect(rows).toHaveCount(1);
  // Retirement persists even after the newer evidence is reloaded.
  await page.reload();
  await openPage(page, "Inbox");
  await expect(rows).toHaveCount(1);
});

// Browser coverage proves the real Inbox/thread/composer/outbox wiring and
// durable preferences across a full app reload, not the lower-layer matrix.
test("Inbox archive on send persists and archives only checked replies", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Inbox");
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  const rows = inbox
    .getByRole("list", { name: "Inbox conversations" })
    .getByRole("listitem");
  await expect(rows).toHaveCount(1);
  await rows.getByRole("button", { name: /^Open / }).click();
  const checkbox = inbox.getByRole("checkbox", { name: "Archive on send" });
  await expect(checkbox).toBeChecked();
  await checkbox.uncheck();
  await page.reload();
  await openPage(page, "Inbox");
  await rows.getByRole("button", { name: /^Open / }).click();
  await expect(checkbox).not.toBeChecked();
  const editor = inbox.getByRole("textbox");
  await editor.fill("Keep this conversation");
  await inbox.getByRole("button", { name: "Send message" }).click();
  await expect(editor).toHaveText("");
  await expect(rows).toHaveCount(1);
  await checkbox.check();
  await editor.fill("Finish this conversation");
  await inbox.getByRole("button", { name: "Send message" }).click();
  await expect(rows).toHaveCount(0);
  await expect(inbox.getByRole("region", { name: "Inbox detail" })).toHaveCount(
    0,
  );
  await choose(page, inbox, "Show", "Archived");
  await expect(rows).toHaveCount(1);
});
