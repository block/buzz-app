import { test, expect } from "./fixture.mjs";
import { generateSecretKey, verifyEvent } from "nostr-tools";
import { openPage } from "./navigation.mjs";

const id = "33333333-3333-4333-8333-333333333333";
const destination = "55555555-5555-4555-8555-555555555555";
const other = "44444444-4444-4444-8444-444444444444";
// Real pointer/keyboard menu behavior, dialog focus and pane geometry require a browser.
test.use({
  pluginFixtures: true,
  productionBroker: true,
  channelIds: [id, other, destination],
  channelNames: { [id]: "Alpha", [other]: "Beta", [destination]: "Team" },
  sessionChannels: [id, other],
  meChannels: [id, other],
  historyCounts: { [id]: 2, [other]: 1, [destination]: 0 },
});

test("Me has full-width chat and matching context/overflow actions without navigating", async ({
  page,
  app,
}) => {
  const agents = ["Blossom", "Bubbles"].map((name) =>
    app.serveProfile(generateSecretKey(), { name, is_agent: true }),
  );
  await page.route("**/api/relay/**/query", async (route) => {
    const filters = route.request().postDataJSON();
    if (!filters.some((filter) => filter.kinds?.includes(39002)))
      return route.continue();
    const response = await route.fetch();
    const events = await response.json();
    await route.fulfill({
      json: events.map((event) =>
        event.kind === 39002 &&
        event.tags.some(([key, value]) => key === "d" && value === id)
          ? app.signRelay({
              ...event,
              tags: [
                ...event.tags,
                ...agents.map((agent) => ["p", agent.pubkey, "", "bot"]),
              ],
            })
          : event,
      ),
    });
  });
  await page.goto(app.origin);
  await openPage(page, "Me");
  const sidebar = page.getByRole("navigation", { name: "Me conversations" });
  const row = sidebar.getByRole("button", { name: "Alpha", exact: true });
  await expect(row).toBeVisible();
  const composer = page.getByRole("textbox", {
    name: "Message your agents",
    exact: true,
  });
  await expect(composer).toBeVisible();
  for (const scale of [1, 2]) {
    await page.evaluate(
      (value) =>
        document.documentElement.style.setProperty(
          "--buzz-text-scale",
          String(value),
        ),
      scale,
    );
    await expect
      .poll(() =>
        composer.evaluate(
          (el) =>
            el.closest("form").getBoundingClientRect().width /
            el.closest("section").getBoundingClientRect().width,
        ),
      )
      .toBeGreaterThan(0.9);
  }
  await page.evaluate(() =>
    document.documentElement.style.setProperty("--buzz-text-scale", "1"),
  );
  await row.click({ button: "right" });
  const menu = page.getByRole("menu", {
    name: "Actions for Alpha",
    exact: true,
  });
  await expect(menu).toBeVisible();
  const actions = await menu.getByRole("menuitem").allTextContents();
  expect(actions).toContain("Share…");
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("heading", { name: "New conversation", exact: true }),
  ).toBeVisible();
  await expect(row).toBeFocused();
  await sidebar
    .getByRole("button", { name: "Actions for Alpha", exact: true })
    .click();
  await expect(menu).toBeVisible();
  expect(await menu.getByRole("menuitem").allTextContents()).toEqual(actions);
  await page.keyboard.press("Escape");
  await row.focus();
  await row.press("Shift+F10");
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "Share…", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Share session",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("combobox", { name: "People or channel" }),
  ).toBeFocused();
  const individual = dialog.getByRole("region", { name: "Individual access" });
  await expect(individual.getByText("Blossom", { exact: true })).toBeVisible();
  await expect(individual.getByText("Bubbles", { exact: true })).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: /Other access/ }),
  ).toHaveCount(0);
  await expect(
    dialog.getByText(/^The original sharing destination/),
  ).toHaveCount(0);
  await expect(
    dialog.getByText("Session participants", { exact: true }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Done", exact: true }),
  ).toBeEnabled();
  await page.screenshot({ path: test.info().outputPath("me-share.png") });
  await page.keyboard.press("Escape");
  await expect(row).toBeFocused();
  await row.click();
  await expect(
    page.getByRole("heading", { name: "Alpha", exact: true }),
  ).toBeVisible();
  for (const scale of [1, 2]) {
    await page.evaluate(
      (value) =>
        document.documentElement.style.setProperty(
          "--buzz-text-scale",
          String(value),
        ),
      scale,
    );
    await expect
      .poll(() =>
        composer.evaluate((el) => {
          const pane = el
            .closest("[data-attachment-drop-zone]")
            .getBoundingClientRect();
          return el.closest("form").getBoundingClientRect().width / pane.width;
        }),
      )
      .toBeGreaterThan(0.9);
    await expect(composer).toBeInViewport();
  }
  await page.screenshot({ path: test.info().outputPath("me-full-width.png") });
});

test("moving a conversation expands unfiled Conversations and keeps keyboard focus", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Me");
  const sidebar = page.getByRole("navigation", { name: "Me conversations" });
  const row = sidebar.getByRole("button", { name: "Alpha", exact: true });
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to", exact: true }).hover();
  await page.getByRole("menuitem", { name: "New group…" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Section name" }).fill("Work");
  await dialog.getByRole("button", { name: "Create and move" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(sidebar.getByText("Saving section…")).not.toBeVisible();
  await expect(sidebar.getByRole("alert")).toHaveCount(0);
  await expect(
    sidebar.getByRole("button", { name: "Work", exact: true }),
  ).toBeVisible();
  const unfiled = sidebar.getByRole("button", {
    name: "Conversations",
    exact: true,
  });
  await unfiled.click();
  await expect(unfiled).toHaveAttribute("aria-expanded", "false");
  await row.focus();
  await row.press("Shift+F10");
  await page.getByRole("menuitem", { name: "Move to", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await page
    .getByRole("menuitem", { name: "Conversations", exact: true })
    .click();
  await expect(unfiled).toHaveAttribute("aria-expanded", "true");
  await expect(row).toBeVisible();
  await expect(row).toBeFocused();
  await expect(
    page.getByRole("heading", { name: "New conversation", exact: true }),
  ).toBeVisible();
});

// App wiring proof: grants and the normal link publication preserve Me placement,
// identity/history and navigation, with a held signed grant readback barrier.
test("Share grants access and posts a link without promoting or moving Me", async ({
  page,
  app,
}) => {
  const person = app.serveProfile(generateSecretKey(), { name: "Aria" });
  const grants = [];
  const evidence = [];
  let signalReadback;
  const requestedReadback = new Promise((resolve) => {
    signalReadback = resolve;
  });
  let releaseReadback;
  const heldReadback = new Promise((resolve) => {
    releaseReadback = resolve;
  });
  let readbackHeld = false;
  let rosterTime = Math.floor(Date.now() / 1000);
  await page.route("**/api/relay/**/query", async (route) => {
    const filters = route.request().postDataJSON();
    if (
      filters.some(
        (filter) => filter.kinds?.includes(0) && filter.search === "Aria",
      )
    ) {
      return route.fulfill({ json: [person] });
    }
    const response = await route.fetch();
    const events = await response.json();
    if (filters.some((filter) => filter.kinds?.includes(39002))) {
      if (
        !readbackHeld &&
        grants.length &&
        filters.some(
          (filter) =>
            filter.kinds?.includes(39002) &&
            filter["#d"]?.includes(id) &&
            filter.consistency === "strong",
        ) &&
        events.some(
          (event) =>
            event.kind === 39002 &&
            event.tags.some(([key, value]) => key === "d" && value === id),
        )
      ) {
        readbackHeld = true;
        evidence.push("readback-requested");
        signalReadback();
        await heldReadback;
        evidence.push("readback-released");
      }
      return route.fulfill({
        json: events.map((event) => {
          if (
            event.kind !== 39002 ||
            event.tags.find(([key]) => key === "d")?.[1] !== id
          )
            return event;
          return app.signRelay({
            kind: 39002,
            content: "",
            created_at: ++rosterTime,
            tags: [
              ...event.tags,
              ...grants.map((grant) => [
                "p",
                grant.tags.find(([key]) => key === "p")[1],
                "",
                "member",
              ]),
            ],
          });
        }),
      });
    }
    return route.fulfill({ response });
  });
  await page.route("**/api/relay/**/publish", async (route) => {
    const event = route.request().postDataJSON();
    if (event.kind === 9) evidence.push("link");
    if (event.kind !== 9000) return route.continue();
    expect(verifyEvent(event)).toBe(true);
    expect(event.pubkey).toBe(app.viewer);
    grants.push(event);
    evidence.push("grant");
    await route.fulfill({ json: { accepted: true, event_id: event.id } });
  });
  await page.goto(app.origin);
  await openPage(page, "Me");
  const sidebar = page.getByRole("navigation", { name: "Me conversations" });
  const row = sidebar.getByRole("button", { name: "Alpha", exact: true });
  await row.click();
  await expect(
    page.getByText(`primary ${id} message 0`, { exact: false }),
  ).toBeVisible();
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Share…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Share session" });
  const search = dialog.getByRole("combobox", { name: "People or channel" });
  await search.fill("Aria");
  await page.getByRole("option", { name: /Aria/ }).click();
  await search.fill("Team");
  await page.getByRole("option", { name: "Team", exact: true }).click();
  const primary = dialog.getByRole("button", {
    name: "Share",
    exact: true,
  });
  const copy = dialog.getByRole("button", { name: "Copy link", exact: true });
  const convert = dialog.getByRole("button", {
    name: "Convert to channel",
    exact: true,
  });
  // Me has a leading conversion action as well as Copy/Share. Real flex wrapping
  // in that selected-channel state is invisible to mounted DOM tests.
  for (const mode of ["light", "dark"]) {
    await page.evaluate(
      (value) => (document.documentElement.dataset.colorMode = value),
      mode,
    );
    for (const width of [950, 1280]) {
      await page.setViewportSize({ width, height: 850 });
      await expect
        .poll(async () => {
          const rows = await Promise.all(
            [convert, copy, primary].map((control) =>
              control.evaluate((element) => {
                const bounds = element.getBoundingClientRect();
                return bounds.top + bounds.height / 2;
              }),
            ),
          );
          return Math.max(...rows) - Math.min(...rows);
        })
        .toBeLessThanOrEqual(1);
      await page.screenshot({
        path: test
          .info()
          .outputPath(`share-channel-footer-${mode}-${width}.png`),
      });
    }
  }
  // At a narrow viewport Convert may wrap, but Copy and Share stay together,
  // including enlarged text. The existing footer may scroll instead of splitting.
  await page.setViewportSize({ width: 390, height: 850 });
  for (const scale of [1, 2]) {
    await page.evaluate((value) => {
      document.documentElement.style.setProperty(
        "--buzz-text-scale",
        String(value),
      );
    }, scale);
    await expect
      .poll(async () => {
        const centers = await Promise.all(
          [copy, primary].map((control) =>
            control.evaluate((element) => {
              const bounds = element.getBoundingClientRect();
              return bounds.top + bounds.height / 2;
            }),
          ),
        );
        return Math.abs(centers[0] - centers[1]);
      })
      .toBeLessThanOrEqual(1);
    if (scale === 2) {
      const actions = dialog.locator(".buzz-dialog-actions > div:last-child");
      await expect
        .poll(() => actions.evaluate((el) => getComputedStyle(el).overflowX))
        .toBe("auto");
      await expect
        .poll(() => actions.evaluate((el) => el.scrollWidth > el.clientWidth))
        .toBe(true);
      // Focus the preceding body control, then let native Tab reveal each action.
      await search.focus();
      for (const action of [copy, primary]) {
        for (
          let step = 0;
          !(await action.evaluate((el) => el === document.activeElement));
          step++
        ) {
          expect(step).toBeLessThan(12);
          await page.keyboard.press("Tab");
        }
        await expect(action).toBeInViewport();
        await expect
          .poll(() =>
            action.evaluate((element) => {
              const r = element.getBoundingClientRect();
              return element.contains(
                document.elementFromPoint(
                  r.x + r.width / 2,
                  r.y + r.height / 2,
                ),
              );
            }),
          )
          .toBe(true);
      }
    }
    await page.screenshot({
      path: test
        .info()
        .outputPath(`share-channel-footer-dark-390-text-${scale}.png`),
    });
  }
  await page.evaluate(() =>
    document.documentElement.style.setProperty("--buzz-text-scale", "1"),
  );
  await page.setViewportSize({ width: 1280, height: 850 });
  const hint = page.getByRole("tooltip").filter({
    hasText: "Sharing grants access and posts a link in the selected channel.",
  });
  await primary.hover();
  await expect(hint).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(hint).not.toBeVisible();
  await copy.focus();
  await page.keyboard.press("Tab");
  await expect(primary).toBeFocused();
  await expect(hint).toBeVisible();
  await expect(primary).toHaveAccessibleDescription(
    "Sharing grants access and posts a link in the selected channel.",
  );
  // Tooltip dismissal consumes only its own Escape, not the enclosing modal.
  await page.keyboard.press("Escape");
  await expect(hint).not.toBeVisible();
  await expect(dialog).toBeVisible();
  const footerBounds = () =>
    dialog.locator("footer").evaluate((footer) =>
      [...footer.querySelectorAll("button")].map((button) => {
        const { x, y, width, height } = button.getBoundingClientRect();
        return { label: button.textContent, x, y, width, height };
      }),
    );
  const beforeShare = await footerBounds();
  try {
    await page.keyboard.press("Enter");
    await requestedReadback;
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Start over" }),
    ).toHaveCount(0);
    await expect(primary).toHaveAttribute("aria-busy", "true");
    await expect.poll(footerBounds).toEqual(beforeShare);
    // Held grant readback proves the real initial -> pending layout transition,
    // including light/dark and a narrow viewport where the footer already wraps.
    for (const mode of ["light", "dark"]) {
      await page.evaluate((value) => {
        document.documentElement.dataset.colorMode = value;
      }, mode);
      for (const width of [1280, 950, 390]) {
        await page.setViewportSize({ width, height: 850 });
        await expect(convert).toBeInViewport();
        await expect(primary).toBeInViewport();
        if (width > 390) {
          await expect
            .poll(async () => {
              const rows = await footerBounds();
              return (
                Math.max(...rows.map((row) => row.y)) -
                Math.min(...rows.map((row) => row.y))
              );
            })
            .toBeLessThanOrEqual(1);
        }
        await page.screenshot({
          path: test.info().outputPath(`share-pending-${mode}-${width}.png`),
        });
      }
    }
    await expect(
      dialog.getByRole("combobox", { name: "People or channel" }),
    ).toBeDisabled();
    await expect(
      dialog.getByRole("button", { name: "Close", exact: true }),
    ).toBeDisabled();
    expect(evidence).toEqual(["grant", "readback-requested"]);
    expect(
      app.report.publications.filter(({ event }) => event.kind === 9),
    ).toHaveLength(0);
    // Restore the desktop sidebar before asserting its retained row after close.
    await page.setViewportSize({ width: 1280, height: 850 });
    releaseReadback();
    await expect(dialog).not.toBeVisible();
    expect(evidence).toEqual([
      "grant",
      "readback-requested",
      "readback-released",
      "link",
    ]);
  } finally {
    releaseReadback();
  }
  await expect(row).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Alpha", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(`primary ${id} message 0`, { exact: false }),
  ).toBeVisible();
  expect(grants).toHaveLength(1);
  expect(grants[0].tags).toContainEqual(["h", id]);
  expect(grants[0].tags).toContainEqual(["p", person.pubkey]);
  expect(app.report.detailsPublications ?? []).toHaveLength(0);
  expect(
    (app.report.sidebarPublications ?? []).filter((entry) =>
      entry.coordinate.startsWith("buzz-me-kit"),
    ),
  ).toHaveLength(0);
  const links = app.report.publications.filter(({ event }) => event.kind === 9);
  expect(links).toHaveLength(1);
  expect(links[0].event.tags).toContainEqual(["h", destination]);
  expect(links[0].event.tags.filter(([key]) => key === "p")).toHaveLength(0);
  expect(links[0].event.content).toBe(
    `[Session · 33333333](buzz://channel/${id})`,
  );
});

// App composition boundary: signed metadata switches Messages discoverability
// without a route handoff, a new conversation, or a Me preference write.
test("explicit conversion moves the same conversation from Me to Messages and keeps history", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Me");
  const sidebar = page.getByRole("navigation", { name: "Me conversations" });
  const row = sidebar.getByRole("button", { name: "Alpha", exact: true });
  await row.click();
  await expect(
    page.getByText(`primary ${id} message 0`, { exact: false }),
  ).toBeVisible();
  const shareTrigger = page.getByRole("button", { name: "Share", exact: true });
  await shareTrigger.click();
  const share = page.getByRole("dialog", { name: "Share session" });
  const shareConvert = share.getByRole("button", {
    name: "Convert to channel",
    exact: true,
  });
  await expect(shareConvert).toBeEnabled();
  for (const width of [390, 950, 1280]) {
    await page.setViewportSize({ width, height: 850 });
    await expect(shareConvert).toBeInViewport();
    await expect(
      share.getByRole("button", { name: "Done", exact: true }),
    ).toBeInViewport();
    await expect
      .poll(() =>
        shareConvert.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return element.contains(
            document.elementFromPoint(
              rect.x + rect.width / 2,
              rect.y + rect.height / 2,
            ),
          );
        }),
      )
      .toBe(true);
  }
  await page.setViewportSize({ width: 390, height: 850 });
  await page.evaluate(() =>
    document.documentElement.style.setProperty("--buzz-text-scale", "2"),
  );
  await share.getByRole("combobox", { name: "People or channel" }).focus();
  let tabs = 0;
  while (
    tabs < 20 &&
    !(await shareConvert.evaluate((el) => el === document.activeElement))
  ) {
    await page.keyboard.press("Tab");
    tabs++;
  }
  await expect(shareConvert).toBeFocused();
  await expect(shareConvert).toBeInViewport();
  await expect
    .poll(() =>
      shareConvert.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return element.contains(
          document.elementFromPoint(
            rect.x + rect.width / 2,
            rect.y + rect.height / 2,
          ),
        );
      }),
    )
    .toBe(true);
  await page.screenshot({
    path: test.info().outputPath("share-convert-enlarged-390.png"),
  });
  await page.evaluate(() =>
    document.documentElement.style.setProperty("--buzz-text-scale", "1"),
  );
  await shareConvert.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", {
    name: "Convert to channel",
    exact: true,
  });
  await expect(share).not.toBeVisible();
  await expect(
    dialog.getByRole("radio", { name: "Private", exact: true }),
  ).toBeChecked();
  await expect(
    dialog.getByRole("radio", { name: "Public", exact: true }),
  ).toHaveAccessibleDescription(
    "Everyone in this community will be able to view this channel’s full history.",
  );
  const convert = dialog.getByRole("button", {
    name: "Convert to channel",
    exact: true,
  });
  await expect(convert).toBeEnabled();
  for (const mode of ["light", "dark"]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.colorMode = value;
    }, mode);
    for (const width of [390, 950, 1280]) {
      await page.setViewportSize({ width, height: 850 });
      await expect(convert).toBeEnabled();
      await expect(convert).toBeInViewport();
      await page.screenshot({
        path: test.info().outputPath(`convert-${mode}-${width}.png`),
      });
    }
  }
  await page.evaluate(() =>
    document.documentElement.style.setProperty("--buzz-text-scale", "2"),
  );
  await expect(convert).toBeEnabled();
  await page.screenshot({
    path: test.info().outputPath("convert-enlarged.png"),
  });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(convert).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Enter");
  await page.evaluate(() =>
    document.documentElement.style.setProperty("--buzz-text-scale", "1"),
  );
  await expect(dialog).not.toBeVisible();
  await expect(shareTrigger).toBeFocused();
  expect(app.report.detailsPublications ?? []).toHaveLength(0);
  await row.focus();
  await row.press("Shift+F10");
  await page
    .getByRole("menuitem", { name: "Convert to channel", exact: true })
    .click();
  await expect(convert).toBeEnabled();
  const publicChoice = dialog.getByRole("radio", {
    name: "Public",
    exact: true,
  });
  await publicChoice.click();
  await expect(publicChoice).toBeChecked();
  expect(app.report.detailsPublications ?? []).toHaveLength(0);
  await convert.click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByText("Converted to channel.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Channel actions" }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeFocused();
  await expect(sidebar).toHaveCount(0);
  await expect(
    page.getByText(`primary ${id} message 0`, { exact: false }),
  ).toBeVisible();
  expect(app.report.detailsPublications).toHaveLength(1);
  const event = app.report.detailsPublications[0];
  expect(verifyEvent(event)).toBe(true);
  expect(event.kind).toBe(9002);
  expect(event.tags).toEqual([
    ["h", id],
    ["name", "Alpha"],
    ["about", ""],
    ["visibility", "open"],
  ]);
  const placements = (app.report.sidebarPublications ?? []).filter((entry) =>
    entry.coordinate.startsWith("buzz-me-kit"),
  );
  expect(placements).toHaveLength(1);
  expect(placements[0].blob.value.channels).toEqual([other]);
  expect(placements[0].blob.value.assignments[id]).toBeUndefined();
  expect(
    app.report.publications.filter(({ event }) =>
      [9, 9000, 9007, 30315].includes(event.kind),
    ),
  ).toHaveLength(0);
  await openPage(page, "Messages");
  const messages = page.getByRole("button", { name: "Alpha", exact: true });
  await expect(messages).toBeVisible();
  await messages.click();
  await expect(
    page.getByText(`primary ${id} message 0`, { exact: false }),
  ).toBeVisible();
  await openPage(page, "Me");
  await expect(row).toHaveCount(0);
  await expect(
    sidebar.getByRole("button", { name: "Beta", exact: true }),
  ).toBeVisible();
});

// Browser-only: native modal focus handoff to a replacement Messages header.
// The held metadata/completion ordering matrix lives in the mounted page test.
test("Messages conversion restores focus after its session header is replaced", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await expect
    .poll(() =>
      page.evaluate(() => window.fixtureNavigation?.snapshot().status),
    )
    .toBe("opened");
  expect(
    await page.evaluate((target) => window.fixtureNavigation.open(target), {
      version: 1,
      kind: "conversation",
      channelId: id,
      scope: { viewer: app.viewer, communityOrigin: "https://primary.example" },
    }),
  ).toEqual({ status: "opened" });
  const trigger = page.getByRole("button", { name: "Share", exact: true });
  await trigger.click();
  const share = page.getByRole("dialog", { name: "Share session" });
  await share.getByRole("button", { name: "Convert to channel" }).click();
  const dialog = page.getByRole("dialog", { name: "Convert to channel" });
  await expect(
    dialog.getByRole("button", { name: "Convert to channel" }),
  ).toBeEnabled();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(trigger).toBeFocused();
  await trigger.press("Enter");
  await share.getByRole("button", { name: "Convert to channel" }).click();
  const confirm = dialog.getByRole("button", { name: "Convert to channel" });
  await expect(confirm).toBeEnabled();
  await confirm.focus();
  await confirm.press("Enter");
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByText("Converted to channel.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Channel actions" }),
  ).toBeFocused();
  await expect(
    page.getByText(`primary ${id} message 0`, { exact: false }),
  ).toBeVisible();
  await expect(trigger).toHaveCount(0);
  expect(app.report.detailsPublications).toHaveLength(1);
  expect(app.report.detailsPublications[0].tags).toEqual([
    ["h", id],
    ["name", "Alpha"],
    ["about", ""],
  ]);
  const placements = (app.report.sidebarPublications ?? []).filter((entry) =>
    entry.coordinate.startsWith("buzz-me-kit"),
  );
  expect(placements).toHaveLength(1);
  expect(placements[0].blob.value.channels).toEqual([other]);
});
