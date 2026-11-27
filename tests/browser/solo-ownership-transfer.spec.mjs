import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";

const channel = "11111111-1111-4111-8111-111111111111";
const chat = "33333333-3333-4333-8333-333333333333";
test.use({
  productionBroker: true,
  colorScheme: "dark",
  pluginFixtures: true,
  openingAdminSetup: true,
  channelLifecycle: true,
  channelIds: [channel, chat],
  channelNames: { [channel]: "Project updates", [chat]: "Recovery chat" },
  soloChannels: [chat],
  ownSoloChannels: [chat],
  soloAgentNames: ["First agent", "Transferring agent"],
  savedCommunities: ["primary"],
  historyCounts: { [channel]: 0, [chat]: 0 },
});

for (const opening of [true, false])
  test(`${opening ? "opening" : "later addition"} rechecks a received ownership transfer before the next grant`, async ({
    page,
    app,
  }, info) => {
    const createdAt = Math.floor(Date.now() / 1000);
    const keys = app.soloAgents.map((agent) => agent.pubkey);
    app.report.setupReceiverTime = createdAt;
    const creation = app.sign({
      kind: 9007,
      created_at: createdAt,
      content: "",
      tags: [["h", chat], ...keys.map((key) => ["p", key])],
    });
    const message = app.sign({
      kind: 9,
      created_at: createdAt,
      content: "Opening ownership transfer",
      tags: [["h", chat], ...keys.map((key) => ["p", key])],
    });
    if (opening) {
      app.report.setupCreation = creation;
      await page.addInitScript(
        ({ scope, creation, message, keys }) => {
          localStorage.setItem(
            `buzz-outbox-v1:${scope}`,
            JSON.stringify([
              {
                event: creation,
                signed: creation,
                delivery: "accepted",
                recovery: {
                  key: `solo-initial-admins:${creation.tags[0][1]}`,
                  value: JSON.stringify(keys),
                },
              },
              { event: message, signed: message, delivery: "failed" },
            ]),
          );
        },
        {
          scope: `https://primary.example:${app.viewer}`,
          creation,
          message,
          keys,
        },
      );
    } else {
      // Model absent members, then their relay-confirmed roles. The real reader
      // verifies each relay-signed roster; no client membership state is injected.
      await page.route("**/api/relay/primary/query", async (route) => {
        const response = await route.fetch();
        const events = await response.json();
        await route.fulfill({
          response,
          json: events.map((event) => {
            if (
              event.kind !== 39002 ||
              !event.tags.some(([tag, value]) => tag === "d" && value === chat)
            )
              return event;
            const tags = event.tags.filter(
              ([tag, key]) => tag !== "p" || !keys.includes(key),
            );
            for (const key of keys) {
              const grant = app.report.publications.find(
                ({ event }) =>
                  event.kind === 9000 &&
                  event.tags.some(
                    ([tag, value]) => tag === "p" && value === key,
                  ),
              );
              if (grant)
                tags.push([
                  "p",
                  key,
                  "",
                  grant.event.tags.find(([tag]) => tag === "role")[1],
                ]);
            }
            return app.signRelay({
              ...event,
              tags,
              created_at:
                event.created_at + 100 + app.report.publications.length,
            });
          }),
        });
      });
    }
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    let signingStarted = false;
    await page.route("**/member-administration-sign", async (route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      signingStarted = true;
      await held;
      await route.fulfill({ response });
    });
    try {
      await page.goto(app.origin);
      await openPage(page, "Messages");
      if (opening) {
        // Launch selects its first conversation; choose the chat only after that.
        const sidebar = page.locator('aside[aria-label="Sidebar"]');
        await expect(sidebar).not.toHaveAttribute("data-buzz-launch-pending");
        await expect(sidebar).not.toHaveAttribute("aria-busy", "true");
        await page
          .getByRole("button", { name: "Recovery chat", exact: true })
          .click();
        await page
          .getByRole("button", { name: "Retry", exact: true })
          .first()
          .click();
      } else {
        await page
          .getByRole("button", { name: "Project updates", exact: true })
          .click();
        await page.evaluate(
          async ({ chat, keys }) => {
            const session = window.fixtureRelay.snapshot().session;
            await session.agentChoices.refresh("templates");
            window.ownershipAddition = "pending";
            void session.channelWrites.addAgents(chat, keys).then(
              () => {
                window.ownershipAddition = "complete";
              },
              (error) => {
                window.ownershipAddition = String(error);
              },
            );
          },
          { chat, keys },
        );
      }
      await expect.poll(() => signingStarted).toBe(true);
      const profile = app.transferSoloAgent(keys[1]);
      await page.evaluate(async (key) => {
        await window.fixtureRelay
          .snapshot()
          .session.read([{ kinds: [0], authors: [key], limit: 1 }], {
            fresh: true,
          });
      }, keys[1]);
      await expect
        .poll(() =>
          page.evaluate((key) => {
            const profiles = window.fixtureRelay.snapshot().session.profiles;
            return { id: profiles.event(key)?.id, owner: profiles.owner(key) };
          }, keys[1]),
        )
        .toEqual({ id: profile.id, owner: profile.tags[0][1] });
      release();
      if (opening)
        await expect
          .poll(() =>
            app.report.publications
              .filter(({ event }) => event.kind === 9)
              .map(({ event }) => event),
          )
          .toEqual([message]);
      else
        await expect
          .poll(() => page.evaluate(() => window.ownershipAddition))
          .toBe("complete");
      const grants = app.report.publications
        .filter(({ event }) => event.kind === 9000)
        .map(({ event }) => ({
          key: event.tags.find(([tag]) => tag === "p")[1],
          role: event.tags.find(([tag]) => tag === "role")[1],
        }));
      await info.attach("received-transfer-grants", {
        body: JSON.stringify({ profile, grants }, null, 2),
        contentType: "application/json",
      });
      expect(grants).toEqual(
        opening
          ? [{ key: keys[0], role: "admin" }]
          : [
              { key: keys[0], role: "admin" },
              { key: keys[1], role: "bot" },
            ],
      );
      await page.screenshot({
        path: info.outputPath("RECEIVED_OWNERSHIP_TRANSFER.png"),
      });
    } finally {
      release();
    }
  });
