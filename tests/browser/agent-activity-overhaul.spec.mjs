import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";
import { generateSecretKey } from "nostr-tools";

test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  historyCounts: { alpha: 2, beta: 1 },
  developmentReact: true,
});

// Browser-only boundary: real popup focus/geometry and existing tab navigation
// must retain the live thread. Identity/lifecycle matrices live in Vitest.
test("bottom activity opens one agent popup and profile Activity without losing the thread", async ({
  page,
  app,
}, testInfo) => {
  await open(page, app);
  await expect.poll(() => app.relay.hasRoute("primary", "observer")).toBe(true);
  const root = app.histories
    .get("primary/alpha")
    .find((row) => row.content.startsWith("Thread root"));
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${root.id}"]`,
  );
  await row.hover();
  await row.getByRole("button", { name: /^View thread:/ }).click();
  const thread = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  const reply = thread.getByRole("textbox", {
    name: "Reply to thread",
    exact: true,
  });
  await expect(reply).toBeVisible();
  const keys = [generateSecretKey(), generateSecretKey()];
  const send = (index, kind, seq, payload = {}) =>
    app.observer(
      {
        kind,
        seq,
        timestamp: new Date().toISOString(),
        channelId: "alpha",
        sessionId: "S",
        turnId: `working-${index}`,
        payload:
          kind === "turn_started" ? { triggeringEventIds: [root.id] } : payload,
      },
      keys[index],
    );
  keys.forEach((_, index) => {
    send(index, "turn_started", 1);
    send(index, "acp_read", 2, {
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "read",
          title: "buzz-dev-mcp__read_file",
          status: "completed",
          rawInput: { path: "/project/README.md" },
          content: [
            {
              type: "content",
              content: { type: "text", text: "Safe example output" },
            },
          ],
        },
      },
    });
    send(index, "acp_read", 3, {
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "Checking the result and explaining the next steps in ordinary prose. ".repeat(
              8,
            ),
          },
        },
      },
    });
  });
  const region = thread.getByRole("region", {
    name: "Agent activity in this thread",
    exact: true,
  });
  const entries = region.getByRole("button", { name: /^View activity for/ });
  await expect(entries).toHaveCount(2);
  const firstLabel = await entries
    .first()
    .locator(".navigation-item-label")
    .innerText();
  await reply.fill("Keep this draft while inspecting activity");
  for (const width of [1440, 800, 390]) {
    await page.setViewportSize({ width, height: 950 });
    await expect(entries.first()).toBeVisible();
    const groupBox = await region.boundingBox();
    const formBox = await thread
      .getByRole("form", { name: "Reply to thread", exact: true })
      .boundingBox();
    expect(groupBox.y + groupBox.height).toBeLessThanOrEqual(formBox.y);
    await entries.first().focus();
    await page.keyboard.press("Enter");
    const popup = page.getByRole("dialog", {
      name: firstLabel.replace(" · working…", ""),
      exact: true,
    });
    await expect(popup).toBeVisible();
    await expect(popup.getByRole("tab")).toHaveCount(0);
    await popup.getByRole("button", { name: "Read file · README.md" }).click();
    await expect(
      popup.getByText("Safe example output", { exact: true }),
    ).toBeVisible();
    await expect(
      popup.getByRole("button", { name: "Progress and responses (1)" }),
    ).toHaveAttribute("aria-expanded", "false");
    await popup
      .getByRole("button", { name: "Progress and responses (1)" })
      .click();
    await popup.getByRole("button", { name: "Response", exact: true }).click();
    const prose = popup.getByText(/^Checking the result and explaining/);
    await expect(prose).toBeVisible();
    await expect(prose).toHaveCSS("white-space", "pre-wrap");
    expect(
      await prose.evaluate((element) => ({
        fits: element.scrollWidth <= element.clientWidth,
        family: getComputedStyle(element).fontFamily,
      })),
    ).toEqual({ fits: true, family: expect.not.stringMatching(/mono/i) });
    await popup
      .getByRole("button", { name: "Progress and responses (1)" })
      .click();
    // Wait for the real disclosure expansion, not only mounted text, before geometry/screenshots.
    await expect
      .poll(() =>
        popup
          .locator(".buzz-accordion-panel[data-open]")
          .evaluateAll((panels) =>
            panels.every((panel) => panel.clientHeight >= panel.scrollHeight),
          ),
      )
      .toBe(true);
    const box = await popup.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    await page.screenshot({
      path: testInfo.outputPath(`activity-${width}.png`),
    });
    await page.keyboard.press("Escape");
    await expect(popup).toBeHidden();
    await expect(entries.first()).toBeFocused();
  }
  await page.setViewportSize({ width: 1440, height: 950 });
  await entries.first().click();
  await page
    .getByRole("dialog", {
      name: firstLabel.replace(" · working…", ""),
      exact: true,
    })
    .getByRole("button", { name: "View activity", exact: true })
    .click();
  const profile = page.getByRole("region", {
    name: "Profile details",
    exact: true,
  });
  await expect(
    profile.getByRole("tab", { name: "Activity", selected: true }),
  ).toBeVisible();
  await expect(
    profile.getByRole("combobox", { name: "Channel", exact: true }),
  ).toHaveText(/Alpha.*alpha/);
  await page.getByRole("button", { name: /^Close (?!Thread).* tab$/ }).click();
  await expect(reply).toHaveText("Keep this draft while inspecting activity");
  keys.forEach((_, index) => {
    send(index, "turn_completed", 4);
  });
  await expect(region).toHaveCount(0);
  await expect(reply).toHaveText("Keep this draft while inspecting activity");
  expect(firstLabel).toContain("working");
});
