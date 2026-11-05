import { hoverMessage } from "./message-actions.mjs";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

// Browser boundary: native DataTransfer and pointer drag connect a thread's
// attachment renderer to the sidebar and the real message publication path.
test.use({ productionBroker: true });
test("drags a thread reply attachment into another channel", async ({
  page,
  app,
}) => {
  await open(page, app);
  const root = app.append("primary", "alpha", "Forwarding root", true, true);
  const row = page
    .getByRole("region", { name: "Channel message history" })
    .locator(`[data-message-id="${root.id}"]`);
  await hoverMessage(row);
  await row.getByRole("button", { name: "Reply", exact: true }).click();
  const thread = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  await expect(
    thread.getByText("Forwarding root", { exact: true }),
  ).toBeVisible();
  const reply = app.append(
    "primary",
    "alpha",
    "Attachment reply",
    true,
    true,
    root.id,
    undefined,
    [["imeta", "url https://EXAMPLE.com:443/report.pdf", "m application/pdf"]],
  );
  const source = thread
    .locator(`[data-message-id="${reply.id}"]`)
    .getByRole("link", { name: "Open report.pdf", exact: true });
  await expect(source).toBeVisible();
  const destination = page.locator('[data-channel-id="beta"]').first();
  await source.dragTo(destination);
  await expect(
    page.getByText("Sending attachment to Beta", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(
      () =>
        app.report.publications.filter(
          ({ event }) =>
            event.kind === 9 &&
            event.tags.some(
              ([name, value]) => name === "h" && value === "beta",
            ),
        ).length,
    )
    .toBe(1);
  const sent = app.report.publications.find(
    ({ event }) =>
      event.kind === 9 &&
      event.tags.some(([name, value]) => name === "h" && value === "beta"),
  ).event;
  expect(sent.tags).toContainEqual([
    "imeta",
    "url https://EXAMPLE.com:443/report.pdf",
    "m application/pdf",
  ]);
  expect(sent.tags.some(([name]) => name === "buzz:copy-of")).toBe(false);
});
