import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";
import { openChannelDetails } from "./channel-details.mjs";

const channel = "11111111-1111-4111-8111-111111111111";
const chat = "33333333-3333-4333-8333-333333333333";
test.use({
  productionBroker: true,
  openingAdminSetup: true,
  channelLifecycle: true,
  channelIds: [channel, chat],
  channelNames: { [channel]: "Project updates", [chat]: "Recovery chat" },
  soloChannels: [chat],
  ownSoloChannels: [chat],
  soloAgentNames: ["Recovery agent"],
  savedCommunities: ["primary"],
  historyCounts: { [channel]: 0, [chat]: 0 },
});

async function openOutbox(page, origin) {
  await page.goto(origin);
  await openPage(page, "Messages");
  await page
    .getByRole("button", { name: "Project updates", exact: true })
    .click();
  await openChannelDetails(page);
  const panel = page.getByRole("complementary", {
    name: "Channel settings",
    exact: true,
  });
  await panel.getByText("Diagnostics", { exact: true }).click();
  const summary = panel.locator("summary").filter({ hasText: /^Outbox ·/ });
  await summary.click();
  return summary.locator("..");
}

// Browser-only: separate windows share the production IndexedDB journal and
// Web Locks while each has its own session, signing request and cancellation.
for (const mode of ["cross-window", "same-window", "failed-storage"])
  test(`expired setup abandonment fences held signing (${mode})`, async ({
    page,
    context,
    app,
  }) => {
    const createdAt = Math.floor(Date.now() / 1000);
    const agent = app.soloAgents[0].pubkey;
    const creation = app.sign({
      kind: 9007,
      created_at: createdAt,
      content: "",
      tags: [
        ["h", chat],
        ["p", agent],
      ],
    });
    const message = app.sign({
      kind: 9,
      created_at: createdAt,
      content: "Opening work",
      tags: [
        ["h", chat],
        ["p", agent],
      ],
    });
    const recovery = {
      key: `solo-initial-admins:${chat}`,
      value: JSON.stringify([agent]),
    };
    app.report.setupCreation = creation;
    const scope = `https://primary.example:${app.viewer}`;
    app.report.setupReceiverTime = createdAt + 895;
    await page.clock.setFixedTime(new Date((createdAt + 899) * 1000));
    await page.addInitScript(
      ({ scope, creation, message, recovery }) => {
        localStorage.setItem(
          `buzz-outbox-v1:${scope}`,
          JSON.stringify([
            {
              event: creation,
              signed: creation,
              delivery: "accepted",
              recovery,
            },
            { event: message, signed: message, delivery: "failed" },
          ]),
        );
      },
      { scope, creation, message, recovery },
    );
    let release = () => {};
    let signingStarted = false;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    await page.route("**/member-administration-sign", async (route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      signingStarted = true;
      await held;
      await route.fulfill({ response });
    });
    let other;
    try {
      const a = await openOutbox(page, app.origin);
      const row = a.getByRole("listitem").filter({ hasText: "Opening work" });
      await row.getByRole("button", { name: "Retry", exact: true }).click();
      await expect.poll(() => signingStarted).toBe(true);
      await page.clock.setFixedTime(new Date((createdAt + 900) * 1000));
      other = mode === "same-window" ? page : await context.newPage();
      if (other !== page) {
        app.watchPageErrors(other);
        await other.clock.setFixedTime(new Date((createdAt + 900) * 1000));
      }
      const b = other === page ? a : await openOutbox(other, app.origin);
      if (mode === "same-window") {
        // The view was opened before expiry: first click exposes explicit consent.
        await b
          .getByRole("button", { name: "Remove from outbox", exact: true })
          .first()
          .click();
      }
      if (mode === "failed-storage")
        await other.evaluate(
          ({ scope, id }) => {
            const remove = IDBObjectStore.prototype.delete;
            IDBObjectStore.prototype.delete = function (key) {
              if (Array.isArray(key) && key[0] === scope && key[1] === id) {
                IDBObjectStore.prototype.delete = remove;
                this.transaction.abort();
              }
              return remove.call(this, key);
            };
          },
          { scope, id: creation.id },
        );
      await b
        .getByRole("button", { name: "Abandon admin setup", exact: true })
        .click();
      if (mode === "failed-storage")
        await expect(b.getByRole("alert")).toBeVisible();
      else
        await expect(
          b.getByRole("button", { name: "Abandon admin setup", exact: true }),
        ).toHaveCount(0);
      // Dismissal's UI completes only after the strict IndexedDB commit.
      release();
      if (mode === "failed-storage") {
        await expect
          .poll(
            () =>
              app.report.publications.filter(({ event }) => event.kind === 9)
                .length,
          )
          .toBe(1);
        const grants = app.report.publications.filter(
          ({ event }) => event.kind === 9000,
        );
        expect(grants).toHaveLength(1);
        expect(app.report.setupReceiverTime - grants[0].event.created_at).toBe(
          895,
        );
        expect(
          app.report.publications.find(({ event }) => event.kind === 9).event,
        ).toEqual(message);
      } else {
        await expect(row).toContainText("Not sent");
        expect(
          app.report.publications.filter(({ event }) =>
            [9000, 9].includes(event.kind),
          ),
        ).toEqual([]);
        await expect(
          row.getByRole("button", { name: "Retry", exact: true }),
        ).toBeEnabled();
        if (mode === "cross-window") {
          await other
            .getByRole("button", { name: "Recovery chat", exact: true })
            .click();
          const composer = other.getByRole("textbox", {
            name: "Message your agents",
            exact: true,
          });
          await composer.fill("Continue with current roles");
          await composer.press("Enter");
          await expect
            .poll(
              () =>
                app.report.publications.filter(({ event }) => event.kind === 9)
                  .length,
            )
            .toBe(1);
          expect(
            app.report.publications.filter(({ event }) => event.kind === 9000),
          ).toEqual([]);
          const fresh = app.report.publications.find(
            ({ event }) => event.kind === 9,
          ).event;
          expect(fresh.id).not.toBe(message.id);
          expect(fresh.content).toBe("Continue with current roles");
        }
      }
    } finally {
      release();
      await page.unrouteAll({ behavior: "wait" });
      if (other && other !== page) {
        await other.unrouteAll({ behavior: "wait" });
        await other.close();
      }
    }
  });
