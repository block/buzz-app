import { openPage } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";

test.use({ productionBroker: true, historyCounts: { alpha: 1, beta: 1 } });

/** Every refused request is one expected console error, matched by URL. */
function expectRefusals(page, app) {
  app.report.relayFailures = [];
  page.on("response", (response) => {
    if ([401, 403].includes(response.status()))
      app.report.relayFailures.push(response.url());
  });
}

// A key the community does not admit connects (discovery is public), then
// the relay refuses every signed request with its plain-text NIP-FI denial.
// That is one fact about the whole community, said once, not a raw status
// repeated by every feature that tried to read.
test("a community that refuses this key says so once, with no raw status", async ({
  page,
  app,
}, testInfo) => {
  expectRefusals(page, app);
  app.relay.refuseSigned(403, "authorization denied\n");
  await page.goto(app.origin);
  const main = page.getByRole("main");
  await expect(
    main.getByRole("heading", {
      name: "You don’t have access to this community",
    }),
  ).toBeVisible();
  // Said once: the sidebar does not repeat it or offer a second Try again.
  await expect(page.getByText(/have access to this/)).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(1);
  await expect(page.getByText(/Relay request failed|\(403\)/)).toHaveCount(0);
  await expect(page.getByText("Loading workspaces…")).toHaveCount(0);
  await expect(
    page.getByText("Saved sidebar preferences couldn’t refresh"),
  ).toHaveCount(0);
  await expect(
    page.getByRole("dialog", { name: "Buzz is having trouble connecting" }),
  ).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("refused.png") });

  // Once the community admits the key, Try again opens it.
  app.relay.refuseSigned();
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(
    page.getByRole("button", { name: "Beta", exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/have access to this/)).toHaveCount(0);
});

// A session that was working loses its sign-in: the next read's refusal
// replaces the whole community with one sign-in prompt.
test("a sign-in that ends mid-session asks to sign in again, once", async ({
  page,
  app,
}, testInfo) => {
  expectRefusals(page, app);
  await page.goto(app.origin);
  await openPage(page, "Messages");
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
  app.relay.refuseSigned(403, "evidence rejected\n");
  await page.getByRole("button", { name: "Beta", exact: true }).click();
  await expect(
    page.getByRole("main").getByRole("heading", {
      name: "Sign in again to open this community",
    }),
  ).toBeVisible();
  await expect(page.getByText(/Sign in again/)).toHaveCount(1);
  await expect(page.getByText(/Relay request failed|\(403\)/)).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("sign-in-ended.png") });
});
