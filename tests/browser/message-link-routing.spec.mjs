import { pauseClock } from "./clock.mjs";
import { test, expect } from "./fixture.mjs";
import { hoverMessage } from "./message-actions.mjs";
import {
  closeSettings,
  openSettings,
  selectSettingsSection,
} from "./navigation.mjs";
import { setPluginEnabled } from "./plugin-settings.mjs";
import { activate, open } from "./timeline.mjs";

test.use({
  pluginFixtures: true,
  enabledPlugins: ["fixture.message-link"],
  historyCounts: { alpha: 3, beta: 0 },
});

const scope = (app) => ({
  viewer: app.viewer,
  communityOrigin: "https://primary.example",
});
const state = (page) =>
  page.evaluate(() => window.fixtureNavigation.snapshot());
const offers = (page) => page.evaluate(() => window.fixtureMessageLinks.seen);
const destination = (page) =>
  page.getByText("Contributed message destination", { exact: true });
const row = (page, id) => page.locator(`[data-message-id="${id}"]`);

async function holdRead(page, matches) {
  let intercepted;
  const started = new Promise((resolve) => {
    intercepted = resolve;
  });
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("**/api/relay/primary/query", async (route) => {
    if (route.request().postDataJSON().some(matches)) {
      intercepted();
      await held;
    }
    await route.continue().catch(() => {});
  });
  return { started, release };
}

async function links(page, app) {
  await open(page, app);
  const root = app.append("primary", "alpha", "Original message");
  const reply = app.append(
    "primary",
    "alpha",
    "Linked reply",
    true,
    true,
    root.id,
  );
  const plain = app.append("primary", "alpha", "Standalone message");
  const href = (channel, id) => `buzz://message?channel=${channel}&id=${id}`;
  const urls = [
    `${href("alpha", reply.id)}&thread=${"f".repeat(64)}`,
    href("alpha", plain.id),
    href("beta", reply.id),
    `${href("alpha", root.id)}&thread=${root.id}`,
    `${href("alpha", reply.id)}&thread=${root.id}`,
  ];
  const source = app.append(
    "primary",
    "alpha",
    urls.map((url) => `<${url}>`).join(" "),
  );
  await expect(row(page, source.id)).toBeVisible();
  const activate = async (index) => {
    const link = row(page, source.id).locator(`a[href="${urls[index]}"]`);
    await expect(link).toBeVisible();
    await link.press("Enter");
  };
  return { root, reply, plain, activate };
}

test("a verified link resolves in place and rechecks the message on reclick and Forward", async ({
  page,
  app,
}) => {
  const { root, reply, activate } = await links(page, app);
  const source = (await state(page)).entry;
  await activate(0);
  await expect(destination(page)).toBeVisible();
  const resolved = (await state(page)).entry;
  expect(resolved.target).toMatchObject({
    kind: "page",
    scope: scope(app),
    route: { version: 1, params: reply.id },
  });
  const admitted = {
    scope: scope(app),
    channelId: "alpha",
    messageId: reply.id,
    threadRootId: root.id,
  };
  expect(await offers(page)).toEqual([admitted]);

  // The browser address is still the exact original message link. Reopening
  // that address should make a fresh offer without adding a duplicate visit.
  const address = page.url();
  await page.evaluate((target) => window.fixtureNavigation.open(target), {
    version: 1,
    kind: "conversation",
    scope: scope(app),
    channelId: "alpha",
    messageId: reply.id,
    threadRootId: "f".repeat(64),
    messageLink: true,
  });
  await expect(destination(page)).toBeVisible();
  expect(await offers(page)).toEqual([admitted, admitted]);
  expect((await state(page)).entry.id).toBe(resolved.id);
  expect(page.url()).toBe(address);
  await page.goBack();
  await expect.poll(async () => (await state(page)).entry.id).toBe(source.id);
  await expect(destination(page)).toHaveCount(0);
  await page.goForward();
  await expect(destination(page)).toBeVisible();
  expect((await state(page)).entry.id).toBe(resolved.id);
  expect(await offers(page)).toEqual([admitted, admitted, admitted]);
});

test("declined, failed, invalid and disabled providers leave the ordinary reveal intact", async ({
  page,
  app,
}) => {
  const { plain, reply, activate } = await links(page, app);
  const linked = row(page, plain.id);
  for (const [index, mode] of ["decline", "fail", "invalid"].entries()) {
    await page.evaluate((mode) => {
      window.fixtureMessageLinks.mode = mode;
    }, mode);
    await activate(1);
    await expect(linked).toBeFocused();
    await expect.poll(async () => (await state(page)).status).toBe("opened");
    expect(await offers(page)).toHaveLength(index + 1);
  }
  // A declined reply still opens and settles when revisiting its reading place.
  await activate(0);
  await expect(row(page, reply.id)).toBeFocused();
  await expect.poll(async () => (await state(page)).status).toBe("opened");
  await page.goBack();
  await expect(linked).toBeVisible();
  await page.goForward();
  await expect.poll(async () => (await state(page)).status).toBe("opened");
  expect((await state(page)).entry.target.messageId).toBe(reply.id);
  const beforeDisable = await offers(page);
  expect(
    beforeDisable.filter(({ messageId }) => messageId === reply.id),
  ).toHaveLength(2);
  await openSettings(page);
  await selectSettingsSection(page, "Manage plugins");
  await setPluginEnabled(page, "Message link fixture", false);
  await closeSettings(page);
  await activate(1);
  await expect(linked).toBeFocused();
  await expect.poll(async () => (await state(page)).status).toBe("opened");
  expect(await offers(page)).toEqual(beforeDisable);
  await expect(destination(page)).toHaveCount(0);
});

test("denied channels and mismatched messages never reach the provider", async ({
  page,
  app,
}) => {
  const { reply, activate } = await links(page, app);
  await activate(2);
  await expect.poll(async () => (await state(page)).status).toBe("failed");
  expect((await state(page)).reason).toBe("not-found");
  expect(await offers(page)).toEqual([]);

  const result = await page.evaluate(
    (target) => window.fixtureNavigation.open(target),
    {
      version: 1,
      kind: "conversation",
      scope: scope(app),
      channelId: "5ec2e700-0000-4000-8000-000000000001",
      messageId: reply.id,
      messageLink: true,
    },
  );
  expect(result.status).toBe("failed");
  expect(await offers(page)).toEqual([]);
  await expect(destination(page)).toHaveCount(0);
});

test("leaving while a provider decides aborts its offer and ignores its late result", async ({
  page,
  app,
}) => {
  await page.clock.install();
  const { activate } = await links(page, app);
  await page.evaluate(() => {
    window.fixtureMessageLinks.mode = "hold";
  });
  await pauseClock(page);
  try {
    await activate(1);
    await expect
      .poll(() => page.evaluate(() => !!window.fixtureMessageLinks.release))
      .toBe(true);
    await page
      .getByRole("button", { name: "Beta", exact: true })
      .press("Enter");
    await expect
      .poll(async () => (await state(page)).entry.target.channelId)
      .toBe("beta");
    await expect
      .poll(() =>
        page.evaluate(() => window.fixtureMessageLinks.signal.reason?.name),
      )
      .toBe("AbortError");
  } finally {
    await page.clock.resume();
    await page.evaluate(() => window.fixtureMessageLinks.release?.());
  }
  await expect.poll(async () => (await state(page)).status).toBe("opened");
  expect((await state(page)).entry.target.channelId).toBe("beta");
  await expect(destination(page)).toHaveCount(0);
});

test("changing tabs cancels offers from retained thread and timeline readers", async ({
  page,
  app,
}) => {
  await page.clock.install();
  await page.addInitScript(() =>
    localStorage.setItem("buzz-thread-placement.v1", "main"),
  );
  const { activate } = await links(page, app);
  await page.evaluate(() => {
    window.fixtureMessageLinks.mode = "hold";
  });
  const conversation = page
    .locator("[data-main-workspace]")
    .getByRole("tab", { name: "Alpha", exact: true });
  // Give the relay time to prove the root and keep the provider deadline
  // paused until the tab change cancels the offer.
  await pauseClock(page);
  try {
    await activate(0);
    await expect
      .poll(() => page.evaluate(() => !!window.fixtureMessageLinks.release))
      .toBe(true);
    await conversation.press("Enter");
    await expect(conversation).toHaveAttribute("aria-selected", "true");
    await expect
      .poll(() =>
        page.evaluate(() => window.fixtureMessageLinks.signal.reason?.name),
      )
      .toBe("AbortError");
    await expect.poll(async () => (await state(page)).status).toBe("opened");
  } finally {
    await page.clock.resume();
    await page.evaluate(() => window.fixtureMessageLinks.release?.());
  }
  await expect(conversation).toHaveAttribute("aria-selected", "true");
  await expect(destination(page)).toHaveCount(0);

  await page.evaluate(() => {
    delete window.fixtureMessageLinks.release;
  });
  const thread = page.locator(
    '[data-main-workspace] [role="tab"][data-tab-value^="thread:"]',
  );
  await pauseClock(page);
  try {
    await activate(1);
    await expect
      .poll(() => page.evaluate(() => !!window.fixtureMessageLinks.release))
      .toBe(true);
    await thread.press("Enter");
    await expect(thread).toHaveAttribute("aria-selected", "true");
    await expect
      .poll(() =>
        page.evaluate(() => window.fixtureMessageLinks.signal.reason?.name),
      )
      .toBe("AbortError");
    await expect.poll(async () => (await state(page)).status).toBe("opened");
  } finally {
    await page.clock.resume();
    await page.evaluate(() => window.fixtureMessageLinks.release?.());
  }
  await expect(thread).toHaveAttribute("aria-selected", "true");
  await expect(destination(page)).toHaveCount(0);
});

test("an explicit root link waits for fresh proof when a closed thread has a resume", async ({
  page,
  app,
}) => {
  const base = Date.now();
  await page.clock.install({ time: base });
  const { root, reply, activate } = await links(page, app);
  await page.evaluate((target) => window.fixtureNavigation.open(target), {
    version: 1,
    kind: "conversation",
    scope: scope(app),
    channelId: "alpha",
    messageId: root.id,
    threadRootId: root.id,
  });
  await expect(row(page, reply.id)).toBeVisible();
  await page
    .locator(
      '.buzz-tabs-item:has([data-tab-value^="thread:"][aria-selected="true"]) > button[aria-label^="Close "], button[aria-label="Close thread"]',
    )
    .click();
  await expect(row(page, reply.id)).toHaveCount(0);

  await page.clock.pauseAt(base + 30_000);
  const read = await holdRead(page, (filter) => filter.depth_limit);
  try {
    await activate(3);
    await read.started;
    await expect(row(page, reply.id)).toBeVisible();
    expect((await state(page)).status).toBe("opening");
    expect(await offers(page)).toEqual([]);
  } finally {
    read.release();
    await page.clock.resume();
  }
  await expect(destination(page)).toBeVisible();
  expect(await offers(page)).toEqual([
    {
      scope: scope(app),
      channelId: "alpha",
      messageId: root.id,
      threadRootId: root.id,
    },
  ]);
});

const withCompanion = test.extend({ companionFixture: true });
withCompanion(
  "closing Settings returns to the same message visit and reevaluates the provider",
  async ({ page, app }) => {
    const { plain, activate } = await links(page, app);
    await activate(1);
    await expect(destination(page)).toBeVisible();
    const visit = (await state(page)).entry.id;
    const address = page.url();
    expect(decodeURIComponent(new URL(address).hash)).not.toContain(
      "messageLink",
    );
    const draft = page.getByRole("textbox", { name: "Destination draft" });
    const companion = page.getByRole("complementary", {
      name: "Companion fixture",
      exact: true,
    });
    await page
      .getByRole("button", { name: "Companion fixture", exact: true })
      .and(page.locator("button[aria-expanded]"))
      .click();
    await expect(companion).toBeVisible();
    const retainedCompanion = await companion.elementHandle();
    await draft.fill("Keep this draft");
    await draft.focus();
    await page.evaluate(() => {
      void window.fixtureNavigation.open({ version: 1, kind: "settings" });
    });
    const modal = page.getByRole("dialog", { name: "Settings", exact: true });
    await expect(modal).toBeVisible();
    await expect
      .poll(() =>
        modal.evaluate((element) => element.contains(document.activeElement)),
      )
      .toBe(true);
    await page.keyboard.press("Escape");
    await expect(modal).toHaveCount(0);
    await expect(draft).toHaveValue("Keep this draft");
    await expect(draft).toBeFocused();
    expect(
      await retainedCompanion.evaluate((element) => element.isConnected),
    ).toBe(true);
    expect((await state(page)).entry.id).toBe(visit);
    expect(await offers(page)).toHaveLength(2);

    await openSettings(page);
    await page.evaluate(() => {
      window.fixtureMessageLinks.mode = "decline";
    });
    await closeSettings(page);
    await expect(row(page, plain.id)).toBeVisible();
    await expect.poll(async () => (await state(page)).status).toBe("opened");
    await expect(draft).toHaveCount(0);
    expect((await state(page)).entry.id).toBe(visit);
    expect(page.url()).toBe(address);

    const composer = page.getByRole("textbox", {
      name: "Message #Alpha",
      exact: true,
    });
    await composer.focus();
    await expect(composer).toBeFocused();
    await page.evaluate(() => {
      void window.fixtureNavigation.open({ version: 1, kind: "settings" });
    });
    await expect(modal).toBeVisible();
    await page.evaluate(() => {
      window.fixtureMessageLinks.mode = "match";
    });
    await closeSettings(page);
    await expect(composer).toBeFocused();
    await expect.poll(async () => (await state(page)).status).toBe("opened");
    expect(await offers(page)).toHaveLength(3);
    expect((await state(page)).entry.id).toBe(visit);
    expect(page.url()).toBe(address);

    await activate(1);
    await expect(destination(page)).toBeVisible();
    await expect(draft).toHaveValue("");
    expect((await state(page)).entry.id).toBe(visit);
    expect(page.url()).toBe(address);
    expect(await offers(page)).toHaveLength(4);
  },
);

test("a verified reply still reveals while a legacy thread read withholds its root", async ({
  page,
  app,
}) => {
  const { reply, activate } = await links(page, app);
  const read = await holdRead(page, (filter) => filter.depth_limit);
  try {
    await activate(0);
    await read.started;
    await expect(row(page, reply.id)).toBeFocused();
    await expect.poll(async () => (await state(page)).status).toBe("opened");
    expect(await offers(page)).toEqual([]);
  } finally {
    read.release();
  }
});

test.describe("Inline thread placement", () => {
  test.use({ threadPlacement: "inline" });

  const sheet = (page) =>
    page.locator("[data-details-sheet-surface]").filter({
      has: page.getByRole("heading", { name: "Thread", exact: true }),
    });
  const dismiss = (page) =>
    sheet(page)
      .getByRole("button", { name: "Close", exact: true })
      .first()
      .click();

  test("an admitted inline link preserves its visit and restores draft and focus from Settings", async ({
    page,
    app,
  }) => {
    const { root, reply, activate } = await links(page, app);
    const source = (await state(page)).entry.id;
    await activate(4);
    await expect(destination(page)).toBeVisible();
    const id = (await state(page)).entry.id;
    const address = page.url();
    const proof = {
      scope: scope(app),
      channelId: "alpha",
      messageId: reply.id,
      threadRootId: root.id,
    };
    expect(await offers(page)).toEqual([proof]);
    await page.evaluate((target) => window.fixtureNavigation.open(target), {
      version: 1,
      kind: "conversation",
      ...proof,
      messageLink: true,
    });
    await expect(destination(page)).toBeVisible();
    expect((await state(page)).entry.id).toBe(id);
    expect(page.url()).toBe(address);

    const draft = page.getByRole("textbox", { name: "Destination draft" });
    await draft.fill("Keep the draft");
    await draft.focus();
    await page.evaluate(() => {
      void window.fixtureNavigation.open({ version: 1, kind: "settings" });
    });
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(draft).toHaveValue("Keep the draft");
    await expect(draft).toBeFocused();
    expect((await state(page)).entry.id).toBe(id);
    expect(await offers(page)).toEqual([proof, proof, proof]);

    await page.goBack();
    await expect.poll(async () => (await state(page)).entry.id).toBe(source);
    await expect(destination(page)).toHaveCount(0);
    await page.goForward();
    await expect(destination(page)).toBeVisible();
    expect((await state(page)).entry.id).toBe(id);
    expect(page.url()).toBe(address);
    expect(await offers(page)).toEqual([proof, proof, proof, proof]);
  });

  test("declined and disabled offers keep the ordinary inline address and reveal", async ({
    page,
    app,
  }) => {
    const { root, reply, activate } = await links(page, app);
    await page.evaluate(() => {
      window.fixtureMessageLinks.mode = "decline";
    });
    const linked = sheet(page).locator(row(page, reply.id));
    await activate(4);
    await expect(linked).toBeVisible();
    await expect.poll(async () => (await state(page)).status).toBe("opened");
    expect((await state(page)).entry.target).toMatchObject({
      inline: root.id,
      inlineMessage: reply.id,
    });
    const address = page.url();
    expect(await offers(page)).toHaveLength(1);
    await page.goBack();
    await expect(sheet(page)).toHaveCount(0);
    await page.goForward();
    await expect(linked).toBeVisible();
    expect(await offers(page)).toHaveLength(1);

    await dismiss(page);
    await openSettings(page);
    await selectSettingsSection(page, "Manage plugins");
    await setPluginEnabled(page, "Message link fixture", false);
    await closeSettings(page);
    await activate(4);
    await expect(linked).toBeVisible();
    expect(page.url()).toBe(address);
    expect(await offers(page)).toHaveLength(1);
  });

  test("a side-tab link verifies its own reply while a different thread stays inline", async ({
    page,
    app,
  }) => {
    await page.addInitScript(() => {
      const key = "buzzodz.plugins.v1";
      const choices = JSON.parse(localStorage.getItem(key) ?? "null") ?? {
        version: 3,
        enabled: { "buzz.reminders": false, "buzz.workflows": false },
      };
      // The catch-all panel fixture claims links opened from the side pane.
      choices.enabled["fixture.notes"] = false;
      choices.enabled["fixture.message-link"] = true;
      localStorage.setItem(key, JSON.stringify(choices));
    });
    await open(page, app);
    await page.evaluate(() => {
      window.fixtureMessageLinks.mode = "decline";
    });
    const sourceRoot = app.append("primary", "alpha", "Side-tab source");
    const inlineRoot = app.append("primary", "alpha", "Inline thread");
    const linkedRoot = app.append("primary", "alpha", "Linked thread");
    const linked = app.append(
      "primary",
      "alpha",
      "Reply in the linked thread",
      true,
      false,
      linkedRoot.id,
    );
    const url = `buzz://message?channel=alpha&id=${linked.id}&thread=${linkedRoot.id}`;
    const source = app.append(
      "primary",
      "alpha",
      `<${url}>`,
      true,
      false,
      sourceRoot.id,
    );
    app.append("primary", "alpha", "Inline reply", true, false, inlineRoot.id);
    const openThread = async (id) => {
      const message = page.locator(
        `[data-channel-timeline] [data-message-id="${id}"]`,
      );
      await hoverMessage(message);
      await message.getByRole("button", { name: "Reply", exact: true }).click();
    };
    const side = page.locator("[data-panel-workspace]");
    const linkedTab = side.locator(
      `[role="tab"][data-tab-value="thread:alpha:${linkedRoot.id}"]`,
    );
    await openThread(sourceRoot.id);
    await sheet(page)
      .getByRole("button", { name: "Move to side panel", exact: true })
      .click();
    await openThread(inlineRoot.id);
    await expect(
      sheet(page).getByRole("textbox", {
        name: "Reply to thread",
        exact: true,
      }),
    ).toBeFocused();
    await activate(
      side.locator(row(page, source.id)).locator(`a[href="${url}"]`),
    );
    await expect(side.locator(row(page, linked.id))).toBeVisible();
    await expect
      .poll(() => offers(page))
      .toEqual([
        {
          scope: scope(app),
          channelId: "alpha",
          messageId: linked.id,
          threadRootId: linkedRoot.id,
        },
      ]);
    await expect(
      sheet(page).getByText("Inline thread", { exact: true }),
    ).toBeVisible();
    await dismiss(page);
    await expect(sheet(page)).toHaveCount(0);
    await expect(linkedTab).toHaveAttribute("aria-selected", "true");
  });

  test("closing an inline thread cancels the pending offer and retires its visit", async ({
    page,
    app,
  }) => {
    await page.clock.install();
    const { activate } = await links(page, app);
    await page.evaluate(() => {
      window.fixtureMessageLinks.mode = "hold";
    });
    await pauseClock(page);
    try {
      await activate(4);
      // Let the sheet mount its reader before waiting for the offer.
      await page.clock.runFor(50);
      await expect
        .poll(() => page.evaluate(() => !!window.fixtureMessageLinks.release))
        .toBe(true);
      await dismiss(page);
      await expect(sheet(page)).toHaveCount(0);
      await expect
        .poll(() =>
          page.evaluate(() => window.fixtureMessageLinks.signal.reason?.name),
        )
        .toBe("AbortError");
    } finally {
      await page.clock.resume();
      await page.evaluate(() => window.fixtureMessageLinks.release?.());
    }
    await expect(destination(page)).toHaveCount(0);
    await page.goBack();
    await page.goForward();
    await expect(sheet(page)).toHaveCount(0);
    expect(await offers(page)).toHaveLength(1);
  });
});
