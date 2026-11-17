import { test, expect } from "./fixture.mjs";
import { channelRow, newChat, openPage, rail } from "./navigation.mjs";
import { showChannels, showRail } from "./rail-helpers.mjs";

// Browser-only boundaries: native insets, resize geometry, and real App wiring
// between Team, Solo chats and the pages the rail lists. Contract matrices
// stay in RTL.
test.use({ pluginFixtures: true, enabledPlugins: ["buzz.drafts-and-sent"] });

// The rail's Plugins card lists primary pages.
const plugins = (page) =>
  rail(page).locator('[data-rail-section="navigation"]');
const pageEntry = (page, name) =>
  plugins(page).getByRole("button", { name, exact: true });

test("shared navigation preserves drafts and history across Solo and rail pages", async ({
  page,
  app,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "buzzodz.plugins.v1",
      JSON.stringify({
        version: 3,
        enabled: { "buzz.reminders": true, "buzz.workflows": true },
      }),
    );
  });
  await page.goto(app.origin);
  await showChannels(page);
  await channelRow(page, "alpha").click();
  const composer = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  await expect(composer).toBeVisible();
  await composer.fill("Keep this draft");
  await expect(
    plugins(page).getByRole("button", {
      name: /^(Reminders|Agents|Workflows)$/,
    }),
  ).toHaveText(["Reminders", "Agents", "Workflows"]);
  const railNode = await rail(page).elementHandle();
  await newChat(page);
  await expect(
    page.getByRole("textbox", { name: "Message your agents", exact: true }),
  ).toBeVisible();
  await expect(rail(page)).toBeVisible();
  expect(await railNode.evaluate((element) => element.isConnected)).toBe(true);
  await expect(composer).toHaveCount(0);
  await expect(page.locator("#shell-rail")).not.toHaveAttribute("data-compact");
  await page.getByRole("button", { name: "Hide sidebar", exact: true }).click();
  // A wide window keeps the hidden sidebar as its compact rail.
  await expect(page.locator("#shell-rail")).toHaveAttribute(
    "data-compact",
    "true",
  );
  await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
  await newChat(page);
  await expect(
    page.getByRole("textbox", { name: "Message your agents", exact: true }),
  ).toBeFocused();
  // Pick the original conversation from Team's list to restore its draft.
  await showChannels(page);
  await channelRow(page, "alpha").click();
  await expect(composer).toHaveText("Keep this draft");
  const reminders = pageEntry(page, "Reminders");
  const channels = rail(page).locator('[data-rail-team-view="channels"]');
  // Enter the page through keyboard activation, not programmatic panel focus.
  for (const mode of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: mode });
    for (const activation of ["Enter", "Space"]) {
      await reminders.focus();
      await reminders.press(activation);
      const heading = page.getByRole("heading", {
        name: "Reminders",
        exact: true,
      });
      await expect(heading).toBeVisible();
      // The real destination and its mount effects must settle before checking focus.
      await heading.evaluate(
        (element) =>
          new Promise((resolve) => {
            requestAnimationFrame(() => resolve(element.isConnected));
          }),
      );
      await expect(reminders).toHaveAttribute("aria-current", "page");
      // A rail destination hands focus to the page it opened.
      await expect(page.getByRole("main")).toBeFocused();
      await channels.focus();
      await channels.press(activation);
      await expect(reminders).not.toHaveAttribute("aria-current");
      await channelRow(page, "alpha").focus();
      await channelRow(page, "alpha").press(activation);
      await expect(composer).toHaveText("Keep this draft");
    }
  }
  const workflows = pageEntry(page, "Workflows");
  await workflows.click();
  await expect(workflows).toHaveAttribute("aria-current", "page");
  await page.reload();
  await expect(workflows).toHaveAttribute("aria-current", "page");
  await reminders.click();
  await expect(reminders).toHaveAttribute("aria-current", "page");
  await page.goBack();
  await expect(workflows).toHaveAttribute("aria-current", "page");
  await page.goForward();
  await expect(reminders).toHaveAttribute("aria-current", "page");
  await showChannels(page);
  await channelRow(page, "alpha").click();
  await expect(composer).toHaveText("Keep this draft");
  await openPage(page, "Settings");
  await expect(plugins(page).locator('[aria-current="page"]')).toHaveCount(0);
});

test("rail destinations and titlebar controls remain reachable through scale and resize", async ({
  page,
  app,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("buzz-appearance.v1", "system");
    localStorage.setItem(
      "buzzodz.plugins.v1",
      JSON.stringify({
        version: 2,
        enabled: {
          "fixture.page-placement": true,
          "buzz.reminders": true,
          "buzz.workflows": true,
        },
      }),
    );
  });
  await page.goto(app.origin);
  await openPage(page, "Team");
  // Dock and toolbar placements predate the rail, which lists them as pages.
  const toolbar = pageEntry(page, "Toolbar destination");
  await toolbar.click();
  await expect(
    page.getByRole("heading", { name: "Toolbar destination" }),
  ).toBeVisible();
  await expect(toolbar).toHaveAttribute("aria-current", "page");
  await openPage(page, "Team");
  // Simulate the native control reserve; native dragging itself needs desktop testing.
  await page
    .locator(".shell-header")
    .evaluate((header) => header.classList.add("shell-header-mac"));
  for (const mode of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: mode });
    await expect(page.locator("html")).toHaveAttribute("data-color-mode", mode);
    for (const scale of [1, 2]) {
      await page.evaluate((scale) => {
        document.documentElement.style.fontSize = `${scale * 100}%`;
      }, scale);
      for (const width of [1600, 1024, 800, 650, 480, 390]) {
        await page.setViewportSize({ width, height: 950 });
        // A narrow window keeps the rail behind its toggle in the titlebar.
        if (width > 650) await expect(rail(page)).toBeVisible();
        else
          await expect(
            page.getByRole("button", { name: "Show navigation", exact: true }),
          ).toBeInViewport({ ratio: 1 });
        // Below 480px of unscaled width the titlebar's own controls are
        // wider than the window; search stays reachable by its shortcut.
        if (width < 480 * scale) continue;
        const search = page.getByRole("button", {
          name: "Search Buzz",
          exact: true,
        });
        await expect(search).toBeInViewport({ ratio: 1 });
        await expect
          .poll(() =>
            page.locator(".shell-header").evaluate((header) => {
              const search = header
                .querySelector(".shell-search")
                .getBoundingClientRect();
              const history = header
                .querySelector(".shell-history")
                .getBoundingClientRect();
              const actions = header
                .querySelector(".shell-actions")
                .getBoundingClientRect();
              return (
                Math.abs(
                  search.y + search.height / 2 - history.y - history.height / 2,
                ) < 1 &&
                Math.abs(
                  search.y + search.height / 2 - actions.y - actions.height / 2,
                ) < 1
              );
            }),
          )
          .toBe(true);

        // Search keeps a capped middle track: centred in the window, and
        // between the titlebar's wings once they size to their content.
        await expect
          .poll(async () => {
            const box = await search.boundingBox();
            const history = await page.locator(".shell-history").boundingBox();
            const actions = await page.locator(".shell-actions").boundingBox();
            const overlap = Math.max(
              0,
              history.x + history.width - box.x,
              box.x + box.width - actions.x,
            );
            const offCentre = Math.abs(box.x + box.width / 2 - width / 2);
            // A wing wider than its half of the window, as at large text,
            // moves search aside instead of sitting under it.
            const pushed =
              history.x + history.width > (width - box.width) / 2 - 1 ||
              actions.x < (width + box.width) / 2 + 1;
            return width <= 650 || pushed ? overlap : offCentre;
          })
          .toBeLessThan(1);
        await expect
          .poll(() =>
            page.locator(".shell-header").evaluate((header) => {
              const search = header
                .querySelector(".shell-search")
                .getBoundingClientRect();
              const others = [
                ...header.querySelectorAll(
                  ".shell-history button, .shell-community-switcher button",
                ),
              ];
              return others.every((button) => {
                const box = button.getBoundingClientRect();
                return (
                  box.right <= search.left ||
                  box.left >= search.right ||
                  box.bottom <= search.top ||
                  box.top >= search.bottom
                );
              });
            }),
          )
          .toBe(true);
        await showRail(page);
        const team = rail(page).getByRole("button", {
          name: "Team",
          exact: true,
        });
        // Enlarged text can scroll Team's card below the rail's fold.
        await team.scrollIntoViewIfNeeded();
        await expect(team).toBeInViewport({ ratio: 1 });
        if (width <= 650)
          await page
            .getByRole("button", { name: "Hide navigation", exact: true })
            .click();
        await search.click();
        const dialog = page.getByRole("dialog", {
          name: "Search Buzz",
          exact: true,
        });
        await expect(
          dialog.getByRole("combobox", { name: "Search Buzz" }),
        ).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(search).toBeFocused();
        await page.screenshot({
          path: test.info().outputPath(`dock-${mode}-${scale}-${width}.png`),
        });
      }
    }
  }
});
