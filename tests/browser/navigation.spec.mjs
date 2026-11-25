import { setPluginEnabled } from "./plugin-settings.mjs";
import { test, expect } from "./fixture.mjs";
import { clickRow, open } from "./timeline.mjs";
import {
  openPage,
  openSettings,
  settingsDialog,
  settingsSections,
} from "./navigation.mjs";

test.use({ historyCounts: { alpha: 1, beta: 0 } });

const button = (page, name) => page.getByRole("button", { name, exact: true });
const composer = (page, name) =>
  page.getByRole("textbox", { name: `Message #${name}`, exact: true });
const entry = (page) =>
  page.evaluate(() => history.state.buzzNavigationV1.entry);

const brief = "buzz://plugin?id=fixture.page-placement&page=brief";
const preview = `${brief}&route.view=preview`;
const pluginLinkTest = test.extend({
  pluginFixtures: true,
  enabledPlugins: ["fixture.page-placement", "fixture.notes"],
  colorScheme: "dark",
  video: "on",
});

pluginLinkTest(
  "plugin links in messages fall back to the page or restore the owning panel",
  async ({ page, app }, info) => {
    await open(page, app);
    app.append(
      "primary",
      "alpha",
      `[Read the brief](${brief}) or [Preview the brief](${preview}).`,
    );
    const conversation = composer(page, "Alpha");
    const project = page.getByRole("heading", { name: "Project brief" });
    const panel = page.getByText("Review the launch plan.", { exact: true });

    await page.getByRole("link", { name: "Read the brief" }).press("Enter");
    await expect(project).toBeVisible();
    await page.goBack();
    await expect(conversation).toBeVisible();

    await page.getByRole("link", { name: "Preview the brief" }).press("Enter");
    await expect(panel).toBeVisible();
    await expect(conversation).toBeVisible();
    await page.goBack();
    await expect(panel).toBeHidden();
    await page.goForward();
    await expect(panel).toBeVisible();
    await page.mouse.move(0, 0);
    await page.screenshot({
      path: info.outputPath("brief-beside-messages.png"),
    });
  },
);

for (const placement of ["side", "inline"])
  pluginLinkTest.describe(`Plugin links with ${placement} threads`, () => {
    pluginLinkTest.use({
      threadPlacement: placement,
      productionBroker: true,
      readState: true,
      threadUnread: true,
      historyCounts: { alpha: 2, beta: 1 },
    });

    pluginLinkTest(
      "plugin links from a thread restore the panel and fall back when the link will not fit history",
      async ({ page, app }) => {
        await open(page, app);
        // The link parser ignores unrelated query parameters. The history
        // entry must store the entire URL, including its padding.
        const longLink = `${preview}&padding=${"x".repeat(4096)}`;
        const root = app.histories
          .get("primary/alpha")
          .find((row) => row.content === "Thread root 0");
        await clickRow(
          page,
          page
            .locator(`[data-channel-timeline] [data-message-id="${root.id}"]`)
            .getByRole("button", { name: /^View thread:/ }),
        );
        const thread =
          placement === "inline"
            ? page.getByRole("dialog", { name: "Thread", exact: true })
            : page.getByRole("tabpanel", { name: /^Thread root/ });
        await expect(thread.getByText("Unread reply 0")).toBeVisible();
        app.append(
          "primary",
          "alpha",
          `[Short preview](${preview}) or [Long preview](${longLink}).`,
          true,
          false,
          root.id,
        );
        const panel = page.getByText("Review the launch plan.", {
          exact: true,
        });
        await thread.getByRole("link", { name: "Short preview" }).click();
        await expect(panel).toBeVisible();
        await expect
          .poll(async () => {
            const target = (await entry(page)).target;
            return placement === "inline" ? target.layer : target.detail;
          })
          .toMatchObject({
            target: preview,
            rootId: root.id,
            ...(placement === "inline" && { threadId: root.id }),
          });
        await page.goBack();
        await expect(panel).toBeHidden();
        await expect(thread).toBeVisible();
        await page.goForward();
        await expect(panel).toBeVisible();
        await page.goBack();
        await thread.getByRole("link", { name: "Long preview" }).click();
        await expect(
          page.getByRole("heading", { name: "Project brief" }),
        ).toBeVisible();
        await expect(page.getByText("Brief view: preview")).toBeVisible();
        await page.goBack();
        await expect(
          thread.getByRole("link", { name: "Long preview" }),
        ).toBeVisible();
      },
    );
  });

const providerTest = test.extend({ pluginFixtures: true });
providerTest(
  "Settings provider closes before its parent and retires only its own return path",
  async ({ page, app }) => {
    await open(page, app);
    const alpha = await entry(page);
    await button(page, "Beta").click();
    await expect(composer(page, "Beta")).toBeVisible();
    const beta = await entry(page);
    await openSettings(page);
    await settingsSections(page)
      .getByRole("button", { name: "Manage plugins", exact: true })
      .click();
    await setPluginEnabled(page, "Provider fixture", true);
    await settingsSections(page)
      .getByRole("button", { name: "Agent setup", exact: true })
      .click();
    const parent = await entry(page);
    await button(page, "Fixture provider, ready").click();
    const dialog = page.getByRole("dialog", {
      name: "Fixture provider",
      exact: true,
    });
    await expect(dialog).toBeVisible();
    const provider = await entry(page);
    await page.goBack();
    await expect(dialog).toHaveCount(0);
    await expect(settingsDialog(page)).toBeVisible();
    expect(await entry(page)).toEqual(parent);
    await page.goForward();
    await expect(dialog).toBeVisible();
    // The history shortcuts traverse the same nested provider visit.
    await page.keyboard.press("ControlOrMeta+BracketLeft");
    await expect(dialog).toHaveCount(0);
    await expect(settingsDialog(page)).toBeVisible();
    expect(await entry(page)).toEqual(parent);
    await page.keyboard.press("ControlOrMeta+BracketRight");
    await expect(dialog).toBeVisible();
    expect(await entry(page)).toEqual(provider);
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(await entry(page)).toEqual(parent);
    // Settings intentionally makes the shell toolbar inert and inaccessible.
    await expect(
      page.locator('button[aria-label="Go forward"]'),
    ).toBeDisabled();
    await button(page, "Fixture provider, ready").click();
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(await entry(page)).toEqual(parent);
    await settingsDialog(page)
      .getByRole("button", { name: "Close Settings", exact: true })
      .click();
    await expect(settingsDialog(page)).toHaveCount(0);
    expect(await entry(page)).toEqual(beta);
    await page.goBack();
    await expect(composer(page, "Alpha")).toBeVisible();
    expect(await entry(page)).toEqual(alpha);
    await page.goForward();
    await expect(settingsDialog(page)).toHaveCount(0);
    await expect(button(page, "Go forward")).toBeDisabled();
  },
);
providerTest(
  "Agents provider Back is reversible; Close skips its visit and returns to Agents",
  async ({ page, app }) => {
    await open(page, app);
    await openSettings(page);
    await settingsSections(page)
      .getByRole("button", { name: "Manage plugins", exact: true })
      .click();
    await setPluginEnabled(page, "Provider fixture", true);
    await settingsDialog(page)
      .getByRole("button", { name: "Close Settings", exact: true })
      .click();
    await expect(settingsDialog(page)).toHaveCount(0);
    const alpha = await entry(page);
    await openPage(page, "Agents");
    const agents = await entry(page);
    const provider = {
      ...agents.target,
      route: { version: 1, params: { provider: "fixture.provider/sample" } },
    };
    await page.evaluate((target) => {
      location.hash = `#buzz=${encodeURIComponent(JSON.stringify(target))}`;
    }, provider);
    const dialog = page.getByRole("dialog", {
      name: "Fixture provider",
      exact: true,
    });
    await expect(dialog).toBeVisible();
    const visit = await entry(page);
    await page.goBack();
    await expect(dialog).toHaveCount(0);
    expect(await entry(page)).toEqual(agents);
    await page.goForward();
    await expect(dialog).toBeVisible();
    // The history shortcuts traverse the same provider visit.
    await page.keyboard.press("ControlOrMeta+BracketLeft");
    await expect(dialog).toHaveCount(0);
    expect(await entry(page)).toEqual(agents);
    await page.keyboard.press("ControlOrMeta+BracketRight");
    await expect(dialog).toBeVisible();
    expect(await entry(page)).toEqual(visit);
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(await entry(page)).toEqual(agents);
    await page.goBack();
    await expect(composer(page, "Alpha")).toBeVisible();
    expect(await entry(page)).toEqual(alpha);
    await page.goForward();
    await expect(button(page, "Go forward")).toBeDisabled();
    await expect(dialog).toHaveCount(0);
  },
);

// Native popstate/hashchange and modal focus are the integration boundary here;
// identity matching and scope isolation are covered in the owner tests.
test("Settings Back is reversible; explicit Close retires every section visit", async ({
  page,
  app,
}) => {
  await open(page, app);
  const alpha = await entry(page);
  await button(page, "Beta").click();
  await expect(composer(page, "Beta")).toBeVisible();
  const beta = await entry(page);
  await openSettings(page);
  await page.goBack();
  await expect(settingsDialog(page)).toHaveCount(0);
  expect(await entry(page)).toEqual(beta);
  await page.goForward();
  await expect(settingsDialog(page)).toBeVisible();
  await settingsSections(page)
    .getByRole("button", { name: "Appearance", exact: true })
    .click();
  await page.goBack();
  await expect(
    settingsSections(page).getByRole("button", {
      name: "Profile",
      exact: true,
    }),
  ).toHaveAttribute("aria-current", "page");
  await settingsDialog(page)
    .getByRole("button", { name: "Close Settings", exact: true })
    .click();
  await expect(settingsDialog(page)).toHaveCount(0);
  expect(await entry(page)).toEqual(beta);
  await page.goBack();
  await expect(composer(page, "Alpha")).toBeVisible();
  expect(await entry(page)).toEqual(alpha);
  await page.goForward();
  await expect(composer(page, "Beta")).toBeVisible();
  await expect(button(page, "Go forward")).toBeDisabled();
  await openSettings(page);
  await page.keyboard.press("Escape");
  await expect(settingsDialog(page)).toHaveCount(0);
  await expect(button(page, "Go forward")).toBeDisabled();
});

test("a collapsible sidebar yields to narrow drawer styles during resize", async ({
  page,
  app,
}) => {
  await open(page, app);
  const navigation = page.locator("#shell-navigation");
  await expect(navigation).toHaveAttribute("data-sidebar-collapsible", "true");

  await page.setViewportSize({ width: 390, height: 900 });
  // Model the desktop marker remaining for a frame until React observes the
  // media-query change; narrow drawer CSS must still win during that interval.
  await navigation.evaluate((element) => {
    element.setAttribute("data-sidebar-collapsible", "true");
  });
  await expect(navigation).toHaveCSS("display", "none");

  await button(page, "Show navigation").click();
  await expect(navigation).toHaveAttribute("data-expanded", "true");
  await expect(navigation).toHaveCSS("display", "flex");
  await expect(navigation).toBeVisible();
});

test("a retired contributed Settings destination promptly reports the plugin turned off on Back", async ({
  page,
  app,
}) => {
  await open(page, app);
  await openSettings(page);
  const sections = settingsSections(page);
  await sections
    .getByRole("button", { name: "Manage plugins", exact: true })
    .click();
  await setPluginEnabled(page, "Pair mobile", true);
  const pairing = sections.getByRole("button", {
    name: "Pair mobile",
    exact: true,
  });
  await expect(pairing).toBeVisible();
  await pairing.click();
  await expect(pairing).toHaveAttribute("aria-current", "page");
  await sections
    .getByRole("button", { name: "Manage plugins", exact: true })
    .click();
  await setPluginEnabled(page, "Pair mobile", false);
  await expect(pairing).toHaveCount(0);
  // The shell toolbar is inert behind the Settings modal; traverse history.
  await page.goBack();
  const card = page.getByRole("alert");
  await expect(
    card.getByRole("heading", {
      name: "Pair mobile is turned off",
      exact: true,
    }),
  ).toBeVisible({ timeout: 3000 });
  await expect(
    card.getByRole("button", { name: "Manage plugins", exact: true }),
  ).toBeVisible();
  await expect(
    card.getByRole("button", { name: "Go to Messages" }),
  ).toHaveCount(0);
});

test("channel visits, toolbar, browser traversal and Settings sections share one history", async ({
  page,
  app,
}) => {
  await open(page, app);
  const alpha = await entry(page);
  expect(alpha.target.channelId).toBe("alpha");
  await button(page, "Beta").click();
  await expect(composer(page, "Beta")).toBeVisible();
  const beta = await entry(page);
  expect(beta.id).not.toBe(alpha.id);
  await button(page, "Go back").click();
  await expect(composer(page, "Alpha")).toBeVisible();
  expect((await entry(page)).id).toBe(alpha.id);
  // Reclick is retry, not a new visit or forward-stack truncation.
  await button(page, "Alpha").click();
  expect((await entry(page)).id).toBe(alpha.id);
  await expect(button(page, "Go forward")).toBeEnabled();
  await button(page, "Go forward").click();
  await expect(composer(page, "Beta")).toBeVisible();
  expect((await entry(page)).id).toBe(beta.id);
  await page.goBack();
  await expect(composer(page, "Alpha")).toBeVisible();
  await page.goForward();
  await expect(composer(page, "Beta")).toBeVisible();
  await openSettings(page);
  const sections = settingsSections(page);
  await expect(
    sections.getByRole("button", { name: "Profile", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await sections
    .getByRole("button", { name: "Appearance", exact: true })
    .click();
  await expect(
    sections.getByRole("button", { name: "Appearance", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  // Option/Alt arrows are native editing controls, not Buzz history shortcuts.
  await page.keyboard.press("Alt+ArrowLeft");
  await page.keyboard.press("Alt+ArrowRight");
  await expect(
    sections.getByRole("button", { name: "Appearance", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await page.reload();
  await expect(
    sections.getByRole("button", { name: "Appearance", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  // The shell toolbar is inert behind the Settings modal; traverse history.
  await page.goBack();
  await expect(
    sections.getByRole("button", { name: "Profile", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await page.goBack();
  await expect(settingsDialog(page)).toHaveCount(0);
  await expect(composer(page, "Beta")).toBeVisible();
});
