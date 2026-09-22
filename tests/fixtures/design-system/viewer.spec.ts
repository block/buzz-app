import { expect, test } from "@playwright/test";
import { COMPONENTS } from "../../../src/shared/design-system/ui/registry";
import { PHOSPHOR_ICONS } from "../../../src/shared/design-system/icons/inventory";

const viewer = "/tests/fixtures/design-system.html";

test("built viewer loads every specimen and foundation without app connections", async ({
  page,
}) => {
  const failures: string[] = [];
  const sockets: string[] = [];
  page.on("pageerror", (e) => failures.push(e.message));
  page.on("response", (r) => {
    if (r.status() >= 400) failures.push(`${r.status()} ${r.url()}`);
  });
  page.on("websocket", (ws) => sockets.push(ws.url()));
  await page.goto(viewer);
  await expect(
    page.getByRole("heading", { name: "Buzz Design System", exact: true }),
  ).toBeVisible();
  const nav = page.getByRole("navigation", { name: "Design system" });
  for (const component of COMPONENTS) {
    await nav.getByRole("link", { name: component.name, exact: true }).click();
    await expect(
      page.getByRole("heading", { name: component.name, exact: true }).first(),
    ).toBeVisible();
  }
  for (const name of [
    "Color",
    "Token table",
    "Typography",
    "Icons",
    "Spacing",
    "Radius",
    "Elevation",
    "Glass",
    "Motion",
    "Base UI backing",
    "Foundation alignment",
    "Maintaining the system",
    "DESIGN.md",
    "AGENTS.md",
  ]) {
    await nav.getByRole("link", { name, exact: true }).click();
    await expect(page.locator("main h1")).toBeVisible();
    await page.reload();
    await expect(page.locator("main h1")).toBeVisible();
  }
  await expect(
    nav.getByRole("link", { name: /Conversation|Agent work/ }),
  ).toHaveCount(0);
  expect(failures).toEqual([]);
  expect(sockets).toEqual([]);
});

test("composer documents interactive, pending, failure and narrow states", async ({
  page,
}) => {
  await page.goto(`${viewer}#/design/components/composer`);
  const interactive = page.getByRole("form", { name: "Interactive message" });
  const input = interactive.getByRole("textbox", {
    name: "Interactive message",
  });
  const send = interactive.getByRole("button", { name: "Send message" });

  await expect(send).toBeDisabled();
  await input.fill("Ready to review");
  await expect(send).toBeEnabled();
  await send.click();
  await expect(input).toHaveValue("");
  await expect(interactive.getByRole("status")).toHaveText(
    "Message sent in this local preview.",
  );

  const sending = page.getByRole("form", { name: "Sending message" });
  await expect(sending).toHaveAttribute("aria-busy", "true");
  await expect(
    sending.getByRole("button", { name: "Sending message" }),
  ).toBeDisabled();

  const failed = page.getByRole("form", { name: "Message with error" });
  await expect(failed.getByRole("alert")).toContainText(
    "Custom emoji could not be prepared.",
  );
  await failed.getByRole("button", { name: "Retry" }).click();
  await expect(failed.getByRole("alert")).toHaveCount(0);
  await expect(failed.getByRole("status")).toHaveText(
    "Message preparation recovered.",
  );

  for (const width of [390, 800, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await expect(
      page.getByRole("form", { name: "Narrow message" }),
    ).toBeVisible();
  }
});

test("icon inventory is routed, complete, decorative, and responsive", async ({
  page,
}) => {
  await page.goto(`${viewer}#/design/icons`);
  await expect(
    page.getByRole("heading", { name: "Icons", exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(/#\/design\/icons$/);

  const phosphorList = page.getByRole("list", {
    name: "Available Phosphor icons",
  });
  await expect(phosphorList.getByRole("listitem")).toHaveCount(
    PHOSPHOR_ICONS.length,
  );
  await expect(page.getByRole("img")).toHaveCount(0);
  await expect(page.locator("main svg:not([aria-hidden='true'])")).toHaveCount(
    0,
  );
  await expect(
    page.getByText("Open GitHub issue", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Microsoft OneDrive link", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("22 × 22px", { exact: true })).toBeVisible();
  await expect(page.getByText("14 × 14px", { exact: true })).toBeVisible();
  // CSS visibility alone misses captions hidden from assistive technology.
  for (const [meaning, caption] of [
    ["Open GitHub issue", "22 × 22px"],
    ["Microsoft OneDrive link", "14 × 14px"],
  ] as const) {
    const example = page
      .getByRole("article")
      .filter({
        has: page.getByRole("heading", { name: meaning, exact: true }),
      })
      .locator(".custom-icon-examples");
    await expect(example).toMatchAriaSnapshot(`- text: ${caption}`);
  }

  for (const width of [390, 800, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await expect(phosphorList.getByRole("listitem").first()).toBeVisible();
  }
});

test("foundation proposals are independent, local, and usable in both modes", async ({
  page,
}) => {
  await page.goto(`${viewer}#/design/foundation-alignment`);
  const current = page.getByRole("region", {
    name: "Current tokens",
    exact: true,
  });
  const proposal = page.getByRole("region", {
    name: "Selected proposal",
    exact: true,
  });
  const color = page.getByRole("switch", { name: "Status color" });
  const reading = page.getByRole("switch", { name: "Larger reading text" });
  const spacing = page.getByRole("switch", { name: "More section space" });

  for (const mode of ["light", "dark"]) {
    const theme = page.getByRole("button", { name: `Use ${mode} mode` });
    if (await theme.count()) await theme.click();
    await expect(proposal.locator("[data-reading]")).toHaveCSS(
      "font-size",
      "16px",
    );
    await expect(proposal.locator(".alignment-project")).toHaveCSS(
      "row-gap",
      "32px",
    );
    const neutral = await current
      .locator("[data-status]")
      .evaluate((el) => getComputedStyle(el).color);
    await expect(proposal.locator("[data-status]")).toHaveCSS("color", neutral);

    await color.click();
    await expect(proposal.locator("[data-status]")).not.toHaveCSS(
      "color",
      neutral,
    );
    await expect(proposal.locator("[data-reading]")).toHaveCSS(
      "font-size",
      "16px",
    );
    await expect(proposal.locator(".alignment-project")).toHaveCSS(
      "row-gap",
      "32px",
    );
    await reading.focus();
    await page.keyboard.press("Space");
    await expect(reading).toBeChecked();
    await expect(proposal.locator("[data-reading]")).toHaveCSS(
      "font-size",
      "20px",
    );
    await spacing.click();
    await expect(proposal.locator(".alignment-project")).toHaveCSS(
      "row-gap",
      "64px",
    );
    await expect(current.locator("[data-reading]")).toHaveCSS(
      "font-size",
      "16px",
    );
    await expect(current.locator(".alignment-project")).toHaveCSS(
      "row-gap",
      "32px",
    );
    await expect(current.locator("[data-status]")).toHaveCSS("color", neutral);

    for (const width of [390, 800, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(page.getByRole("table")).toHaveCount(3);
      await expect(page.getByRole("table").first()).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
    }
    await color.click();
    await reading.click();
    await spacing.focus();
    await page.keyboard.press("Space");
    await expect(spacing).not.toBeChecked();
  }
  await proposal
    .getByRole("button", { name: "Follow project", exact: true })
    .click();
  await expect(
    proposal.getByRole("button", { name: "Following project" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    current.getByRole("button", { name: "Follow project", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await page.reload();
  await expect(color).not.toBeChecked();
  await expect(reading).not.toBeChecked();
  await expect(spacing).not.toBeChecked();
});

test("narrow, intermediate and wide layouts preserve theme and keyboard interaction", async ({
  page,
  browserName,
}) => {
  for (const width of [390, 800, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${viewer}#/design/components/button`);
    const toggle = page.getByRole("button", { name: "Use dark mode" });
    if (await toggle.count()) await toggle.click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.reload();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.getByRole("button", { name: "Use light mode" }).click();
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  }
  const primary = page.getByRole("button", { name: "prominent", exact: true });
  await primary.click();
  await expect(page.locator("html")).not.toHaveAttribute(
    "data-keyboard-navigation",
  );
  const tab =
    browserName === "webkit" && process.platform === "darwin"
      ? "Alt+Tab"
      : "Tab";
  await page.keyboard.press(tab);
  await expect(
    page.getByRole("button", { name: "subtle", exact: true }),
  ).toBeFocused();
  await expect(page.locator("html")).toHaveAttribute(
    "data-keyboard-navigation",
    "",
  );
  await primary.click();
  await expect(page.locator("html")).not.toHaveAttribute(
    "data-keyboard-navigation",
  );
  await page.keyboard.press(tab);
  await expect(
    page.getByRole("button", { name: "subtle", exact: true }),
  ).toBeFocused();
  await expect(page.locator("html")).toHaveAttribute(
    "data-keyboard-navigation",
    "",
  );
});

test("switch keyboard activation matches pointer state and focus in both modes", async ({
  page,
  browserName,
}) => {
  await page.goto(`${viewer}#/design/components/switch`);
  const switches = page.getByRole("switch", { name: "Show agent activity" });
  const control = switches.nth(0);
  const tab =
    browserName === "webkit" && process.platform === "darwin"
      ? "Alt+Tab"
      : "Tab";
  for (const width of [390, 800, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const mode of ["light", "dark"]) {
      const toggle = page.getByRole("button", { name: `Use ${mode} mode` });
      if (await toggle.count()) await toggle.click();
      await expect(control).not.toBeChecked();
      await control.click();
      await expect(control).toBeChecked();
      await expect(control).toHaveCSS("outline-style", "none");
      await page.keyboard.press(tab);
      await expect(switches.nth(1)).toBeFocused();
      await page.keyboard.press(`Shift+${tab}`);
      await expect(control).toBeFocused();
      await expect(control).toHaveCSS("outline-style", "solid");
      await expect(control).toHaveCSS("outline-width", "2px");
      await page.keyboard.press("Space");
      await expect(control).not.toBeChecked();
      await page.keyboard.press("Enter");
      await expect(control).toBeChecked();
      await control.click();
      await expect(control).not.toBeChecked();
    }
  }
});

test("disabled switch exposes its state, skips Tab and rejects activation", async ({
  page,
  browserName,
}) => {
  await page.goto(`${viewer}#/design/components/switch`);
  const switches = page.getByRole("switch", { name: "Show agent activity" });
  const disabled = switches.nth(2);
  await expect(disabled).toBeDisabled();
  await expect(disabled).not.toBeChecked();
  await switches.nth(1).click();
  await page.keyboard.press(
    browserName === "webkit" && process.platform === "darwin"
      ? "Alt+Tab"
      : "Tab",
  );
  await expect(disabled).not.toBeFocused();
  await disabled.click({ force: true });
  await disabled.press("Space");
  await disabled.press("Enter");
  await expect(disabled).not.toBeChecked();
});

test("viewer does not replace host styles or appearance ownership", async ({
  page,
  context,
}) => {
  await page.goto("http://localhost:1444");
  await expect(
    page.getByRole("heading", { name: "Make yourself at home." }),
  ).toBeVisible();
  const readHost = () =>
    page.evaluate(() => ({
      storage: JSON.stringify(
        Object.entries(localStorage)
          .filter(([key]) => key !== "buzz-design-viewer-color-scheme")
          .sort(),
      ),
      mode: document.documentElement.getAttribute("data-color-mode"),
      background: getComputedStyle(document.body).backgroundColor,
      systemToken: getComputedStyle(document.documentElement).getPropertyValue(
        "--purple-9",
      ),
    }));
  const before = await readHost();
  expect(before.systemToken.trim()).toBe("#8e4ec6");
  await page.goto("http://localhost:1445");
  await expect(
    page.getByRole("heading", { name: "Make yourself at home." }),
  ).toBeVisible();
  const sameOriginBefore = await readHost();
  const other = await context.newPage();
  await other.goto(`http://localhost:1445${viewer}`);
  await other.getByRole("button", { name: /Use (dark|light) mode/ }).click();
  expect(await readHost()).toEqual(sameOriginBefore);
  await other.close();
});

test("documentation retains table guidance and storage failure stays usable", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => {
      throw new Error("Storage denied");
    };
    Storage.prototype.setItem = () => {
      throw new Error("Storage denied");
    };
  });
  await page.goto(`${viewer}#/design/design-guide`);
  // A real cell in a real row, so run-on prose or a dropped table both fail.
  const roleRow = page
    .locator("main table tbody tr")
    .filter({ hasText: "Component recipes and product screens." });
  await expect(roleRow.locator("td").first()).toHaveText("Roles");
  await expect(
    page.locator("main table thead th").filter({ hasText: "Layer" }),
  ).toHaveCount(1);
  await expect(page.locator("main")).not.toContainText("|---|");
  // A token is one word: it may sit on its own line, never break across two.
  const split = await page
    .locator("main table code")
    .evaluateAll((nodes) =>
      nodes
        .filter((node) => node.getClientRects().length > 1)
        .map((node) => node.textContent ?? ""),
    );
  expect(split).toEqual([]);
  await expect(page.getByRole("status")).toContainText(
    "Appearance is temporary",
  );
  const before = await page.locator("html").getAttribute("class");
  await page.getByRole("button", { name: /Use (light|dark) mode/ }).click();
  await expect
    .poll(() => page.locator("html").getAttribute("class"))
    .not.toBe(before);
  await expect(page.getByRole("status")).toContainText("Toggle again to retry");
});

test("built component references retain anatomy and fallback identity", async ({
  page,
}) => {
  await page.goto(`${viewer}#/design/components/tabs`);
  const selectedTabRow = page
    .locator("tbody tr")
    .filter({ hasText: "Unselected tab" })
    .first();
  await expect(selectedTabRow).toContainText("text-subtle");
  await expect(selectedTabRow.locator("td")).toHaveCount(6);

  await page.goto(`${viewer}#/design/components/avatar`);
  await expect(page.getByRole("img", { name: "Cynthia Chen" })).toHaveCount(3);
  await expect(page.getByRole("img", { name: "Morgan Martin" })).toHaveCount(5);
});

test("a small pane drag settles on release and Escape", async ({ page }) => {
  await page.goto(`${viewer}#/design/components/swap-workspace`);
  const playground = page.getByRole("region", { name: "3 panels playground" });
  const pane = playground.locator('[data-group="One"]');
  const header = pane.locator(".multi-swap-header");

  const dragWithinPane = async (cancel: boolean) => {
    const startTransform = await pane.evaluate(
      (element) => element.style.transform,
    );
    const box = await header.boundingBox();
    if (!box) throw new Error("Missing pane header geometry");
    await page.mouse.move(box.x + box.width - 20, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width, box.y + box.height / 2 + 20);
    if (cancel) await page.keyboard.press("Escape");
    else await page.mouse.up();
    await expect
      .poll(() => pane.evaluate((element) => element.style.transform))
      .toBe(startTransform);
    if (cancel) await page.mouse.up();
  };

  await dragWithinPane(false);
  await dragWithinPane(true);
});

test("a stale or renamed link explains itself instead of rendering blank", async ({
  page,
}) => {
  const failures: string[] = [];
  page.on("pageerror", (e) => failures.push(e.message));
  for (const hash of [
    "#/design/components/renamed-away",
    "#/design/colours",
    "#/design/nope/deeper",
  ]) {
    await page.goto(`${viewer}${hash}`);
    await expect(
      page.getByRole("heading", { name: "Not in the system" }),
    ).toBeVisible();
    await expect(
      page.getByRole("navigation", { name: "Design system" }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Go to the overview" }).click();
    await expect(
      page.getByRole("heading", { name: "Buzz Design System", exact: true }),
    ).toBeVisible();
  }
  expect(failures).toEqual([]);
});

test("switch labels activate the control and busy switches preserve focus", async ({
  page,
}) => {
  await page.goto(`${viewer}#/design/components/switch`);
  const control = page
    .getByRole("switch", { name: "Show agent activity" })
    .first();
  await expect(control).not.toBeChecked();
  await page
    .locator("label")
    .filter({ hasText: "Show agent activity" })
    .first()
    .click();
  await expect(control).toBeChecked();
  const busy = page.getByRole("switch", { name: "Enable busy plugin" });
  await expect(busy).toHaveAttribute("aria-disabled", "true");
  await busy.focus();
  await expect(busy).toBeFocused();
  for (const key of ["Space", "Enter"]) {
    await page.keyboard.press(key);
    await expect(busy).toBeChecked();
    await expect(busy).toBeFocused();
  }
  await busy.click({ force: true });
  await expect(busy).toBeChecked();
});

test("avatar specimens preserve human and agent identity shapes in both modes", async ({
  page,
}) => {
  await page.goto(`${viewer}#/design/components/avatar`);
  for (const mode of ["light", "dark"]) {
    const change = page.getByRole("button", { name: `Use ${mode} mode` });
    if (await change.count()) await change.click();
    const agent = page.getByRole("img", { name: "Brain", exact: true });
    await expect(agent).toHaveCSS("border-radius", "0px");
    await expect(agent).toHaveCSS("mask-image", /^url\(/);
    const human = page.getByRole("img", { name: "Alex Lee", exact: true });
    expect(
      await human.evaluate(
        (element) =>
          parseFloat(getComputedStyle(element).borderTopLeftRadius) >=
          element.clientWidth / 2,
      ),
    ).toBe(true);
    for (const name of ["View Morgan profile", "View Alex profile"]) {
      const button = page.getByRole("button", { name, exact: true });
      await button.scrollIntoViewIfNeeded();
      const artwork = button.locator(".buzz-avatar");
      const inner = await button.evaluate((element) => ({
        width: element.clientWidth,
        height: element.clientHeight,
      }));
      await expect(artwork).toHaveCSS("width", `${inner.width}px`);
      await expect(artwork).toHaveCSS("height", `${inner.height}px`);
      if (name === "View Morgan profile") {
        await expect(artwork.locator("img")).toHaveAttribute(
          "data-loaded",
          "true",
        );
        await expect(artwork.locator("img")).toHaveCSS("opacity", "1");
      } else {
        await expect(artwork).toHaveText("A");
      }
    }
    const sizes = page.getByRole("img", { name: "Morgan Martin", exact: true });
    for (const [index, size] of [24, 32, 40].entries()) {
      await expect(sizes.nth(index)).toHaveCSS("width", `${size}px`);
    }
  }
});

test("typography shows the size ramp and renders xsmall mono details", async ({
  page,
}) => {
  await page.goto(`${viewer}#/design/typography`);
  for (const size of [12, 14, 16, 18, 20, 24, 28, 32, 36, 44, 56, 72, 96]) {
    await expect(page.getByText(`size.${size}`, { exact: true })).toBeVisible();
  }
  const samples = page.getByText("createChannel(name, members)", {
    exact: true,
  });
  await expect(samples).toHaveCount(3);
  for (const sample of await samples.all()) {
    await expect(sample).toHaveCSS("font-size", "12px");
    await expect(sample).toHaveCSS("line-height", "16px");
    await expect(sample).toHaveCSS("font-family", /JetBrains Mono/);
  }
  await expect(
    page.getByRole("link", { name: "Typography source specification" }),
  ).toHaveAttribute(
    "href",
    "https://github.com/squareup/design-blockinterface/blob/eff766161ba8aaee3258ca107f0d904dd542c708/blockUI/docs/type.resolution.draft.json",
  );
});

// Native label focus and reset/FormData behavior must agree in real engines.
// Detailed cancellation, controlled state and external form cases live in RTL.
test("textarea labels focus explicit IDs and preserve edits", async ({
  page,
}) => {
  await page.goto(`${viewer}#/design/components/textarea`);
  const textarea = page.getByRole("textbox", {
    name: "Description",
    exact: true,
  });
  await page
    .locator("label")
    .filter({ hasText: /^Description$/ })
    .click();
  await expect(textarea).toBeFocused();
  await textarea.fill("Updated summary");
  await expect(textarea).toHaveValue("Updated summary");
});

test("native form reset keeps choice appearance and submitted values together", async ({
  page,
}) => {
  await page.goto(`${viewer}#/design/components/radio-group`);
  const form = page.getByRole("form", { name: "Notification preferences" });
  const checkbox = form.getByRole("checkbox", { name: "Include a summary" });
  const all = form.getByRole("radio", { name: "All updates" });
  const mentions = form.getByRole("radio", { name: "Mentions only" });
  await checkbox.click();
  await mentions.click();
  await expect(checkbox).not.toBeChecked();
  await expect(mentions).toBeChecked();
  expect(
    await form.evaluate((element) =>
      Object.fromEntries(new FormData(element as HTMLFormElement)),
    ),
  ).toEqual({ notifications: "mentions" });
  await form.getByRole("button", { name: "Reset preferences" }).click();
  await expect(checkbox).toBeChecked();
  await expect(all).toBeChecked();
  await expect(mentions).not.toBeChecked();
  expect(
    await form.evaluate((element) =>
      Object.fromEntries(new FormData(element as HTMLFormElement)),
    ),
  ).toEqual({ notifications: "all", summary: "yes" });
});

test("invalid input and textarea boundaries remain visible in both themes", async ({
  page,
}) => {
  await page.goto(`${viewer}#/design/components/field`);
  for (const mode of ["light", "dark"]) {
    const toggle = page.getByRole("button", { name: `Use ${mode} mode` });
    if (await toggle.count()) await toggle.click();
    const controls = page.getByRole("textbox");
    await expect(controls).toHaveCount(2);
    for (const control of await controls.all()) {
      await expect(control).toHaveAttribute("aria-invalid", "true");
      const ratio = await control.evaluate((element) => {
        const style = getComputedStyle(element);
        const luminance = (color: string) => {
          const components = color
            .match(/[\d.]+/g)
            ?.slice(0, 3)
            .map(Number);
          if (components?.length !== 3)
            throw new Error(`Unexpected color ${color}`);
          const linear = components.map((component) => {
            const value = component / 255;
            return value <= 0.04045
              ? value / 12.92
              : ((value + 0.055) / 1.055) ** 2.4;
          });
          const [red = 0, green = 0, blue = 0] = linear;
          return red * 0.2126 + green * 0.7152 + blue * 0.0722;
        };
        const border = luminance(style.borderTopColor);
        const background = luminance(style.backgroundColor);
        return (
          (Math.max(border, background) + 0.05) /
          (Math.min(border, background) + 0.05)
        );
      });
      expect(ratio).toBeGreaterThanOrEqual(3);
    }
  }
});

// These cases verify native reset against actual hidden form inputs, not only ARIA.
test("controlled choices keep the owner's unchanged values after native reset", async ({
  page,
}) => {
  await page.goto(`${viewer}#/design/components/radio-group`);
  const form = page.getByRole("form", { name: "Controlled preferences" });
  const checkbox = form.getByRole("checkbox", { name: "Include a summary" });
  const mentions = form.getByRole("radio", { name: "Mentions only" });
  await checkbox.click();
  await mentions.click();
  await expect(checkbox).toBeChecked();
  await expect(mentions).toBeChecked();
  await form.getByRole("button", { name: "Reset preferences" }).click();
  await expect(checkbox).toBeChecked();
  await expect(mentions).toBeChecked();
  await expect(
    form.locator('input[type="radio"][value="mentions"]'),
  ).toBeChecked();
  await expect(
    form.locator('input[type="checkbox"][name="summary"]'),
  ).toBeChecked();
  expect(
    await form.evaluate((element) =>
      Object.fromEntries(new FormData(element as HTMLFormElement)),
    ),
  ).toEqual({ delivery: "mentions", summary: "yes" });
});

test("radios enabled after mount remain synchronized on native reset", async ({
  page,
}) => {
  await page.goto(`${viewer}#/design/components/radio-group`);
  const form = page.getByRole("form", { name: "Deferred preferences" });
  const all = form.getByRole("radio", { name: "All updates" });
  const mentions = form.getByRole("radio", { name: "Mentions only" });
  await expect(all).toBeDisabled();
  await form.getByRole("button", { name: "Enable choices" }).click();
  await mentions.click();
  await expect(mentions).toBeChecked();
  await form.getByRole("button", { name: "Reset preferences" }).click();
  await expect(all).toBeChecked();
  await expect(mentions).not.toBeChecked();
  expect(
    await form.evaluate((element) =>
      Object.fromEntries(new FormData(element as HTMLFormElement)),
    ),
  ).toEqual({ delivery: "all" });
});
