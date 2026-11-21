import { test, expect } from "./fixture.mjs";
import { INVENTORY_KINDS } from "../../src/features/agents/relay-library.ts";

const chat = "33333333-3333-4333-8333-333333333333";
const team = "44444444-4444-4444-8444-444444444444";
// Browser-only: the real reader schedules the broker's read-state snapshot
// against the owner inventory read that Solo tagging waits for, and the real
// composer seeds its pill from the resulting agent choices. A longer snapshot
// deadline (#2627) left the pill empty behind "Retry agents" while every Node
// test of the reader, the inventory and seeding stayed green (#2751).
test.use({
  productionBroker: true,
  readState: true,
  channelIds: [chat, team],
  channelNames: { [chat]: "Plan the launch", [team]: "Team" },
  soloChannels: [chat],
  ownSoloChannels: [chat],
  historyCounts: { [chat]: 1, [team]: 1 },
  soloAgentNames: ["Owned Honey"],
});

const query = (request) => request.url().endsWith("/query");
const isSnapshot = (filters) =>
  filters.some((filter) => filter.read_state_snapshot === 1);
// The owner's agent inventory, which Solo needs complete before it tags.
const isInventory = (filters) =>
  filters.some(
    (filter) =>
      filter.kinds?.length === INVENTORY_KINDS.length &&
      INVENTORY_KINDS.every((kind) => filter.kinds.includes(kind)),
  );

test("a Solo chat alone with an agent tags it while a background read-state snapshot is still loading", async ({
  page,
  app,
}) => {
  // Startup's snapshot is a foreground read. After a connection gap, read
  // state has no capacity basis and takes a fresh snapshot in the background,
  // the read that outlasts other reads' deadlines on large accounts. Hold
  // that one until the pill has been decided.
  let gapped = false;
  const held = Promise.withResolvers();
  const gate = Promise.withResolvers();
  // The gap also rereads the agent inventory. Fail that reread with a
  // transient 502 until the snapshot is in flight, so the automatic retry is
  // the read scheduled against it.
  let inventoryAnswered = true;
  let refused = 0;
  await page.route("**/query", async (route) => {
    const filters = route.request().postDataJSON();
    if (isSnapshot(filters)) {
      // Only primary has the gap. Secondary's badge session waits for
      // primary's first repair, so its foreground startup snapshot can land
      // after the gap too; holding it would test the wrong read.
      if (gapped && route.request().url().includes("/api/relay/primary/")) {
        held.resolve(route.request());
        await gate.promise;
      }
    } else if (isInventory(filters) && !inventoryAnswered) {
      refused++;
      app.report.startupFailures ??= [];
      app.report.startupFailures.push(route.request().url());
      return route.fulfill({ status: 502, body: "unavailable" });
    }
    await route.continue();
  });
  const [agent] = app.soloAgents;
  // The gap leaves the chat's row carrying an unread badge in its name.
  const row = page
    .getByRole("navigation", { name: "Subscribed channels" })
    .locator(`[data-solo-destination-id="${chat}"]`);
  const pill = page.getByRole("button", {
    name: `Sending to ${agent.name}. Change agents`,
    exact: true,
  });
  // The composer shows no standing notice (#2948); the failed read says in
  // its picker that it is retrying, and offers no Retry button.
  const retrying = page.getByText("Couldn't load agents. Retrying…", {
    exact: true,
  });
  const retry = page.getByRole("button", {
    name: "Retry agent list",
    exact: true,
  });
  try {
    // Startup takes two snapshots: read state's foreground read and own
    // follow state's background recovery. Let both finish before the gap, so
    // the held snapshot is the one read state takes after it.
    let startup = 0;
    const started = Promise.withResolvers();
    const count = (response) => {
      if (
        query(response.request()) &&
        isSnapshot(response.request().postDataJSON()) &&
        ++startup === 2
      )
        started.resolve();
    };
    page.on("response", count);
    await page.goto(app.origin);
    await started.promise;
    page.off("response", count);
    await expect(row).toBeVisible();
    gapped = true;
    inventoryAnswered = false;
    app.relay.disconnect("primary");
    // A follow-up: switch from the team channel to the Solo chat.
    await row.click();
    await expect(
      page.getByRole("textbox", { name: "Message your agents", exact: true }),
    ).toBeVisible();
    const snapshot = await held.promise;
    expect(snapshot.headers()["x-buzz-read-priority"]).toBe("background");
    // The gap keeps the last whole agent list, so the chat stays addressed
    // while its reread is refused: nobody has to press Retry.
    await expect(pill).toBeVisible();
    await expect.poll(() => refused).toBeGreaterThan(0);
    // The failed reread shows quietly in the pill's menu.
    await pill.click();
    await expect(retrying).toBeVisible();
    await expect(retry).toHaveCount(0);
    // The relay answers again. The snapshot is still running, so the
    // automatic retry must not wait for it.
    inventoryAnswered = true;
    await expect(retrying).toHaveCount(0, { timeout: 20_000 });
    await expect(pill).toBeVisible();
  } finally {
    gate.resolve();
  }
  // The snapshot completing changes nothing about the addressed agent.
  await expect(pill).toBeVisible();
  await expect(retrying).toHaveCount(0);
});
