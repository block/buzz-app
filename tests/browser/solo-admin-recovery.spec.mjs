import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";

const channel = "11111111-1111-4111-8111-111111111111";
const chat = "33333333-3333-4333-8333-333333333333";
test.use({
  video: "on",
  diagnostics: false,
  productionBroker: true,
  openingAdminSetup: true,
  channelLifecycle: true,
  channelIds: [channel, chat],
  channelNames: { [channel]: "Project updates", [chat]: "Recovery chat" },
  soloChannels: [chat],
  ownSoloChannels: [chat],
  soloAgentNames: ["Recovery agent"],
  soloOutsideAgentNames: ["Shared helper"],
  savedCommunities: ["primary"],
  historyCounts: { [channel]: 0, [chat]: 0 },
});

/** Restores a created chat whose admin setup and opening message did not
 * finish, as a reload leaves them. */
async function restoreSetup(
  page,
  app,
  { createdAt, members, admins, message },
) {
  const creation = app.sign({
    kind: 9007,
    created_at: createdAt,
    content: "",
    tags: [["h", chat], ...members.map((key) => ["p", key])],
  });
  const opening = app.sign({
    kind: 9,
    created_at: createdAt,
    content: message.content,
    tags: [["h", chat], ...message.recipients.map((key) => ["p", key])],
  });
  app.report.setupCreation = creation;
  await page.addInitScript(
    ({ scope, creation, opening, admins }) => {
      localStorage.setItem(
        `buzz-outbox-v1:${scope}`,
        JSON.stringify([
          {
            event: creation,
            signed: creation,
            delivery: "accepted",
            recovery: {
              key: `solo-initial-admins:${creation.tags[0][1]}`,
              value: JSON.stringify(admins),
            },
          },
          { event: opening, signed: opening, delivery: "failed" },
        ]),
      );
    },
    {
      scope: `https://primary.example:${app.viewer}`,
      creation,
      opening,
      admins,
    },
  );
  return opening;
}

async function openChat(page, app) {
  await page.goto(app.origin);
  await openPage(page, "Messages");
  // Launch selects its first conversation; choose the chat only after that.
  const sidebar = page.locator('aside[aria-label="Sidebar"]');
  await expect(sidebar).not.toHaveAttribute("data-buzz-launch-pending");
  await expect(sidebar).not.toHaveAttribute("aria-busy", "true");
  await page
    .getByRole("button", { name: "Recovery chat", exact: true })
    .click();
}

const published = (app, kind) =>
  app.report.publications.filter(({ event }) => event.kind === kind);

// The draft's owned subset and workspace selection are covered in SoloDraft.
test("Retry in the chat grants a quiet owned default without promoting its shared recipient", async ({
  page,
  app,
}, info) => {
  const createdAt = Math.floor(Date.now() / 1000);
  const [owned, shared] = app.soloAgents;
  app.report.setupReceiverTime = createdAt;
  const message = await restoreSetup(page, app, {
    createdAt,
    members: [owned.pubkey, shared.pubkey],
    admins: [owned.pubkey],
    message: {
      content: "Only the shared helper is addressed",
      recipients: [shared.pubkey],
    },
  });
  await openChat(page, app);
  await page
    .getByRole("button", { name: "Retry", exact: true })
    .first()
    .click();
  await expect.poll(() => published(app, 9).length).toBe(1);
  const grants = published(app, 9000);
  expect(grants).toHaveLength(1);
  expect(grants[0].event.tags).toContainEqual(["p", owned.pubkey]);
  expect(grants[0].event.tags).not.toContainEqual(["p", shared.pubkey]);
  expect(published(app, 9)[0].event).toEqual(message);
  await page.screenshot({
    path: info.outputPath("OWNED_DEFAULT_SHARED_RECIPIENT.png"),
  });
});

// Release builds have no Outbox, so an expired setup must finish on its own.
test("an expired setup no longer blocks the chat's next message", async ({
  page,
  app,
}, info) => {
  const now = Math.floor(Date.now() / 1000);
  const agent = app.soloAgents[0].pubkey;
  app.report.setupReceiverTime = now;
  await restoreSetup(page, app, {
    createdAt: now - 16 * 60,
    members: [agent],
    admins: [agent],
    message: { content: "Opening work", recipients: [agent] },
  });
  await openChat(page, app);
  await page.setViewportSize({ width: 390, height: 844 });
  const composer = page.getByRole("textbox", {
    name: "Message your agents",
    exact: true,
  });
  await expect(
    page.getByRole("button", {
      name: "Sending to Recovery agent. Change agents",
      exact: true,
    }),
  ).toBeVisible();
  const send = page.getByRole("button", { name: "Send message", exact: true });
  // Each message sends, so the chat never fills with failed rows.
  for (const [index, text] of [
    "Continue with current roles",
    "And keep going",
  ].entries()) {
    await composer.fill(text);
    await expect(send).toBeEnabled();
    await send.click();
    await expect.poll(() => published(app, 9).length).toBe(index + 1);
    expect(published(app, 9)[index].event.content).toBe(text);
  }
  await expect(page.getByText("Couldn’t send this message.")).toHaveCount(1);
  expect(published(app, 9000)).toEqual([]);
  await page.screenshot({
    path: info.outputPath("EXPIRED_SETUP_NEXT_MESSAGE.png"),
  });
});
