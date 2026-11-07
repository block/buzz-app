import { test, expect } from "./fixture.mjs";
import { open, end, settle } from "./timeline.mjs";
import { hoverMessage } from "./message-actions.mjs";
import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools";

test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  historyCounts: { alpha: 40, beta: 1 },
});

// Real browser geometry, virtualizer ownership, and native focus cannot be
// established by DOM-emulator tests.
for (const inThread of [false, true]) {
  test(`incoming activity follows the bottom and retains focus through append (${inThread ? "thread" : "channel"})`, async ({
    page,
    app,
  }) => {
    const key = generateSecretKey();
    const pubkey = getPublicKey(key);
    await page.route("**/agent-library", (route) =>
      route.fulfill({
        json: {
          definitions: [],
          identities: [{ pubkey, name: "Working agent" }],
        },
      }),
    );
    app.serveProfile(key, { name: "Working agent", is_agent: true });
    await open(page, app);
    const root = app.append("primary", "alpha", "Activity lifecycle request");
    let history = page.getByRole("region", { name: "Channel message history" });
    if (inThread) {
      const row = history.locator(`[data-message-id="${root.id}"]`);
      await hoverMessage(row);
      await row.getByRole("button", { name: "Reply", exact: true }).click();
      history = page.getByRole("region", { name: "Thread messages" });
      for (let i = 0; i < 25; i++)
        app.append(
          "primary",
          "alpha",
          `Earlier reply ${i}\n\nDetails for this reply.`,
          true,
          true,
          root.id,
        );
      await expect(
        history.getByText("Earlier reply 24", { exact: false }),
      ).toBeVisible();
      await history.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
        el.dispatchEvent(new Event("scroll"));
      });
    } else await end(page);
    await settle(page, history);
    const tags = [
      ["h", "alpha"],
      ...(inThread
        ? [
            ["e", root.id, "", "root"],
            ["e", root.id, "", "reply"],
          ]
        : []),
    ];
    let timestamp = Math.floor(Date.now() / 1000);
    const publish = (kind, content, extra = []) => {
      timestamp =
        kind === 20002
          ? Math.floor(Date.now() / 1000)
          : Math.max(timestamp + 1, Math.floor(Date.now() / 1000) + 2);
      return app.relay.publish(
        "primary",
        finalizeEvent(
          {
            kind,
            content,
            tags: [...tags, ...extra],
            created_at: timestamp,
          },
          key,
        ),
      );
    };
    publish(20002, "");
    const trigger = history.getByRole("button", {
      name: "Activity: Working agent working",
    });
    await expect(trigger).toBeVisible();
    await expect
      .poll(() =>
        history.evaluate((el) =>
          el.querySelector("[data-conversation-activity]")
            ? el.scrollHeight - el.clientHeight - el.scrollTop
            : Number.POSITIVE_INFINITY,
        ),
      )
      .toBeLessThan(2);
    if (!inThread) {
      const tailHeight = await history
        .locator("[data-conversation-activity]")
        .evaluate((el) => el.getBoundingClientRect().height);
      const editor = page.getByRole("textbox", {
        name: "Message #Alpha",
        exact: true,
      });
      await editor.fill("Sending while the agent is working");
      await editor.press("Enter");
      await expect(
        history.getByText("Sending while the agent is working", {
          exact: true,
        }),
      ).toBeVisible();
      await expect
        .poll(() =>
          history.evaluate((el) =>
            el.querySelector("[data-conversation-activity]")
              ? el.scrollHeight - el.clientHeight - el.scrollTop
              : Number.POSITIVE_INFINITY,
          ),
        )
        .toBeLessThan(2);
      expect(
        await history
          .locator("[data-conversation-activity]")
          .evaluate((el) => el.getBoundingClientRect().height),
      ).toBe(tailHeight);
    }
    // Real pointer hit-testing and the host's profile route: the working
    // row's avatar and name open the agent's profile, as an author's do.
    const working = history.locator("[data-conversation-activity]");
    const profile = page.getByRole("region", {
      name: "Profile details",
      exact: true,
    });
    const closeProfile = page.getByRole("button", {
      name: "Close Working agent tab",
      exact: true,
    });
    for (const identity of [
      working.getByRole("button", {
        name: "View Working agent profile",
        exact: true,
      }),
      working.getByRole("button", { name: "Working agent", exact: true }),
    ]) {
      // A typing pulse lasts 8 seconds; renew it before each round trip so
      // slow runs keep the working row.
      publish(20002, "");
      await identity.click();
      await expect(profile).toBeVisible();
      await closeProfile.click();
      await expect(profile).toHaveCount(0);
      // Closing a profile beside a thread does not restore focus to its
      // origin, as for any reply author's avatar; the channel does.
      if (!inThread) await expect(identity).toBeFocused();
    }
    // Renew it once more: the append below must find this same row working.
    publish(20002, "");
    await trigger.focus();
    const original = await trigger.elementHandle();
    app.append(
      "primary",
      "alpha",
      "Another person adds a message",
      true,
      true,
      inThread ? root.id : undefined,
    );
    await expect(
      history.getByText("Another person adds a message", { exact: true }),
    ).toBeVisible();
    await expect(trigger).toBeFocused();
    expect(await original.evaluate((el) => el.isConnected)).toBe(true);

    publish(9, "Checking the lifecycle", [["audience", "agents"]]);
    const disclosure = history.getByRole("button", {
      name: /Show activity history:.*Checking the lifecycle/,
    });
    await expect(disclosure).toBeVisible();
    await expect
      .poll(() =>
        history.evaluate(
          (el) =>
            el.contains(document.activeElement) &&
            document.activeElement !== document.body,
        ),
      )
      .toBe(true);
    // The activity run that replaces the working row opens the profile too.
    await disclosure
      .locator("xpath=ancestor::*[@data-agent-response-preview]")
      .getByRole("button", { name: "View Working agent profile", exact: true })
      .click();
    await expect(profile).toBeVisible();
    await closeProfile.click();
    await expect(profile).toHaveCount(0);
    await disclosure.click();
    const collapse = history.getByRole("button", {
      name: /Collapse activity history/,
    });
    await collapse.focus();
    publish(9, "Completed lifecycle work");
    await expect(
      history.getByText("Completed lifecycle work", { exact: true }),
    ).toBeVisible();
    // A public reply retires the live treatment, not the expanded history.
    await expect(collapse).toBeVisible();
    await expect(collapse).toBeFocused();
    await collapse.click();
    await expect(disclosure).toBeVisible();
    await expect(disclosure).toBeFocused();
    await disclosure.click();
    await expect(collapse).toBeVisible();
  });
}

// The opener is gone when the profile closes: only the real page shows where
// the panel host sends focus after a live row replaces it.
test("closing a profile opened from a working row returns focus to the agent's activity that replaced it", async ({
  page,
  app,
}) => {
  const key = generateSecretKey();
  const pubkey = getPublicKey(key);
  await page.route("**/agent-library", (route) =>
    route.fulfill({
      json: {
        definitions: [],
        identities: [{ pubkey, name: "Working agent" }],
      },
    }),
  );
  app.serveProfile(key, { name: "Working agent", is_agent: true });
  await open(page, app);
  await end(page);
  const history = page.getByRole("region", { name: "Channel message history" });
  await settle(page, history);
  const publish = (kind, content, tags, createdAt) =>
    app.relay.publish(
      "primary",
      finalizeEvent(
        {
          kind,
          content,
          tags: [["h", "alpha"], ...tags],
          created_at: createdAt,
        },
        key,
      ),
    );
  const now = Math.floor(Date.now() / 1000);
  publish(20002, "", [], now);
  const name = history
    .locator("[data-conversation-activity]")
    .getByRole("button", { name: "Working agent", exact: true });
  await name.click();
  const profile = page.getByRole("region", {
    name: "Profile details",
    exact: true,
  });
  await expect(profile).toBeVisible();
  publish(9, "Checking the lifecycle", [["audience", "agents"]], now + 2);
  const run = history
    .getByRole("button", {
      name: /Show activity history:.*Checking the lifecycle/,
    })
    .locator("xpath=ancestor::*[@data-agent-response-preview]");
  await expect(run).toBeVisible();
  await expect(name).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(profile).toHaveCount(0);
  // Not the channel menu: the same agent's avatar or name in its activity.
  await expect(run.locator(":focus")).toHaveAccessibleName(
    /^(View )?Working agent( profile)?$/,
  );
});
