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

// Whether rows move when the in-flow agent row ends is real browser layout
// and scroll geometry; DOM-emulator tests cannot establish it.

async function workingAgent(page, app) {
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
  return key;
}

async function openThread(page, rootId) {
  const channel = page.getByRole("region", { name: "Channel message history" });
  const rootRow = channel.locator(`[data-message-id="${rootId}"]`);
  await hoverMessage(rootRow);
  await rootRow.getByRole("button", { name: "Reply", exact: true }).click();
  return page.getByRole("region", { name: "Thread messages" });
}

async function toBottom(page, history) {
  await history.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    el.dispatchEvent(new Event("scroll"));
  });
  await settle(page, history);
}

async function bottomReader(page, app, inThread) {
  const key = await workingAgent(page, app);
  await open(page, app);
  let history = page.getByRole("region", { name: "Channel message history" });
  let root;
  if (inThread) {
    root = app.append("primary", "alpha", "Agent finish request");
    history = await openThread(page, root.id);
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
    await toBottom(page, history);
  } else {
    await end(page);
    await settle(page, history);
  }
  // Working-row expiry is the behavior under test: control its clock.
  await page.clock.install();
  const now = () => page.evaluate(() => Math.floor(Date.now() / 1000));
  const tags = [
    ["h", "alpha"],
    ...(root
      ? [
          ["e", root.id, "", "root"],
          ["e", root.id, "", "reply"],
        ]
      : []),
  ];
  const publish = async (kind, content, extra = []) =>
    app.relay.publish(
      "primary",
      finalizeEvent(
        { kind, content, tags: [...tags, ...extra], created_at: await now() },
        key,
      ),
    );
  const reply = async (content) =>
    app.append(
      "primary",
      "alpha",
      content,
      true,
      true,
      root?.id,
      undefined,
      [],
      await now(),
    );
  const activity = history.locator("[data-conversation-activity]");
  const work = async () => {
    await publish(20002, "");
    await expect(activity).toHaveCount(1);
    await expect.poll(() => distance(history)).toBeLessThan(2);
    await settle(page, history);
  };
  const expire = async () => {
    await page.clock.fastForward(9000);
    await expect(activity).toHaveCount(0);
    await settle(page, history);
  };
  // The end of the history at rest, before any working row.
  const rest = await tail(history);
  await work();
  return { history, root, publish, reply, work, expire, rest };
}

const distance = (history) =>
  history.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
// Space between the last row and the end of the history, beyond the spacer.
const tail = (history) =>
  history.evaluate((el) => {
    const row = [...el.querySelectorAll("[data-message-id]")].at(-1);
    const bottom =
      row.getBoundingClientRect().bottom -
      el.getBoundingClientRect().top +
      el.scrollTop;
    return Math.round(el.scrollHeight - bottom);
  });
const held = (history) =>
  history
    .locator("[data-activity-lane]")
    .evaluate((el) => Number.parseFloat(el.style.minHeight) || 0);

// Records the largest step down a row already on screen takes between rendered
// layouts. A bottom reader sees later content arrive below; earlier rows must
// never slide down, which reads as the conversation scrolling up on its own.
// Created after the hosts' observers, each delivery samples geometry after
// their corrections, as it is painted.
async function trackDownwardSteps(history) {
  await history.evaluate((el) => {
    const row = [...el.querySelectorAll("[data-message-id]")].at(-1);
    const offset = () =>
      row.getBoundingClientRect().top - el.getBoundingClientRect().top;
    const state = { previous: offset(), max: 0, samples: 0 };
    const observer = new ResizeObserver(() => {
      const current = offset();
      state.samples++;
      state.max = Math.max(state.max, current - state.previous);
      state.previous = current;
    });
    for (const target of [el, ...el.querySelectorAll("[data-activity-lane]")])
      observer.observe(target);
    for (const target of el.querySelectorAll(
      "[data-thread-rows], ol, [data-thread-end]",
    ))
      observer.observe(target);
    window.__steps = { state, observer };
  });
  return async () => {
    const state = await history.evaluate(() => {
      const { state, observer } = window.__steps;
      observer.disconnect();
      return state;
    });
    expect(state.samples).toBeGreaterThan(0);
    return state.max;
  };
}

for (const inThread of [true, false]) {
  const where = inThread ? "thread" : "channel";

  test(`rows stay put when a working agent goes quiet (${where})`, async ({
    page,
    app,
  }) => {
    const { history, expire } = await bottomReader(page, app, inThread);
    const steps = await trackDownwardSteps(history);
    await expire();
    expect(await steps()).toBeLessThan(1);
    expect(await distance(history)).toBeLessThan(2);
    expect(await held(history)).toBeGreaterThan(0);
  });

  test(`deleting the latest message keeps the space for the next arrival (${where})`, async ({
    page,
    app,
  }) => {
    const { history, reply, work, expire, rest } = await bottomReader(
      page,
      app,
      inThread,
    );
    await page.clock.fastForward(1000);
    const target = await reply("Message to delete");
    await expect(
      history.locator(`[data-message-id="${target.id}"]`),
    ).toBeVisible();
    await work();
    await expire();
    const before = await held(history);
    expect(before).toBeGreaterThan(0);
    app.relay.publish(
      "primary",
      app.sign({
        kind: 5,
        content: "",
        tags: [
          ["h", "alpha"],
          ["e", target.id],
          ["k", "9"],
        ],
        created_at: await page.evaluate(() => Math.floor(Date.now() / 1000)),
      }),
    );
    await expect(
      history.locator(`[data-message-id="${target.id}"]`),
    ).toHaveCount(0);
    await settle(page, history);
    expect(await held(history)).toBe(before);

    await page.clock.fastForward(1000);
    await reply("After the deletion");
    await expect(
      history.getByText("After the deletion", { exact: true }),
    ).toBeVisible();
    await settle(page, history);
    const left = await held(history);
    expect(left).toBeLessThan(before);
    expect(Math.abs((await tail(history)) - rest - left)).toBeLessThan(1.5);
  });

  test(`the next message takes a quiet agent's space (${where})`, async ({
    page,
    app,
  }) => {
    const { history, expire, reply, rest } = await bottomReader(
      page,
      app,
      inThread,
    );
    await expire();
    const before = await held(history);
    const steps = await trackDownwardSteps(history);
    await reply("Thanks!");
    await expect(history.getByText("Thanks!", { exact: true })).toBeVisible();
    await settle(page, history);
    expect(await steps()).toBeLessThan(1);
    expect(await distance(history)).toBeLessThan(2);
    const left = await held(history);
    expect(left).toBeLessThan(before);
    // The only space left under the reply is the hold it did not cover.
    expect(Math.abs((await tail(history)) - rest - left)).toBeLessThan(1.5);
  });
}

test("an agent's reply takes its working row's place without leaving space", async ({
  page,
  app,
}) => {
  const { history, publish, rest } = await bottomReader(page, app, true);
  const steps = await trackDownwardSteps(history);
  await publish(9, "Here is the answer.");
  await expect(
    history.getByText("Here is the answer.", { exact: true }),
  ).toBeVisible();
  await expect(history.locator("[data-conversation-activity]")).toHaveCount(0);
  await settle(page, history);
  expect(await steps()).toBeLessThan(1);
  expect(await held(history)).toBe(0);
  expect(await tail(history)).toBe(rest);
});

test("the first reply in a thread takes a quiet agent's space", async ({
  page,
  app,
}) => {
  const key = await workingAgent(page, app);
  await open(page, app);
  const root = app.append("primary", "alpha", "Agent finish request");
  const history = await openThread(page, root.id);
  await settle(page, history);
  await page.clock.install();
  const now = () => page.evaluate(() => Math.floor(Date.now() / 1000));
  app.relay.publish(
    "primary",
    finalizeEvent(
      {
        kind: 20002,
        content: "",
        tags: [
          ["h", "alpha"],
          ["e", root.id, "", "root"],
          ["e", root.id, "", "reply"],
        ],
        created_at: await now(),
      },
      key,
    ),
  );
  await expect(history.locator("[data-conversation-activity]")).toHaveCount(1);
  await settle(page, history);
  await page.clock.fastForward(9000);
  await expect(history.locator("[data-conversation-activity]")).toHaveCount(0);
  await settle(page, history);
  const before = await held(history);
  expect(before).toBeGreaterThan(0);
  app.append(
    "primary",
    "alpha",
    "First reply",
    true,
    true,
    root.id,
    undefined,
    [],
    await now(),
  );
  await expect(history.getByText("First reply", { exact: true })).toBeVisible();
  await settle(page, history);
  const left = await held(history);
  expect(left).toBeLessThan(before);
});

test("rows stay put when an agent's progress reply is followed by a silent end", async ({
  page,
  app,
}) => {
  const { history, publish, work, expire } = await bottomReader(
    page,
    app,
    true,
  );
  await publish(9, "Looking into it.");
  await expect(
    history.getByText("Looking into it.", { exact: true }),
  ).toBeVisible();
  await expect(history.locator("[data-conversation-activity]")).toHaveCount(0);
  await page.clock.fastForward(2500);
  await work();
  const steps = await trackDownwardSteps(history);
  await expire();
  expect(await steps()).toBeLessThan(1);
});

test("leaving the bottom gives the space back out of view and coming back re-arms it", async ({
  page,
  app,
}) => {
  const { history, expire } = await bottomReader(page, app, true);
  const top = () => history.evaluate((el) => el.scrollTop);
  await history.hover();
  let before = await top();
  await page.mouse.wheel(0, -400);
  await expect.poll(top).toBeLessThan(before);
  await settle(page, history);
  expect(await top()).toBeCloseTo(before - 400, 0);
  await toBottom(page, history);
  const steps = await trackDownwardSteps(history);
  await expire();
  expect(await steps()).toBeLessThan(1);
  expect(await held(history)).toBeGreaterThan(0);

  before = await top();
  await page.mouse.wheel(0, -400);
  await expect.poll(() => held(history)).toBe(0);
  await settle(page, history);
  expect(Math.abs((await top()) - (before - 400))).toBeLessThan(1);
  expect(await distance(history)).toBeGreaterThanOrEqual(80);
});

test("hiding the app gives the space back", async ({ page, app }) => {
  const { history, expire } = await bottomReader(page, app, true);
  await expire();
  expect(await held(history)).toBeGreaterThan(0);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => held(history)).toBe(0);
});

test("a row that ends while the app is hidden leaves no space", async ({
  page,
  app,
}) => {
  const { history, expire, rest } = await bottomReader(page, app, true);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expire();
  expect(await held(history)).toBe(0);
  expect(await tail(history)).toBe(rest);
});

test("a reload starts without held space", async ({ page, app }) => {
  const { history, root, expire } = await bottomReader(page, app, true);
  await expire();
  expect(await held(history)).toBeGreaterThan(0);
  await page.reload();
  const reopened = page.getByRole("region", { name: "Thread messages" });
  const thread = (await reopened.count())
    ? reopened
    : await openThread(page, root.id);
  await expect(
    thread.getByText("Earlier reply 24", { exact: false }),
  ).toBeVisible();
  await expect(thread.locator("[data-activity-lane]")).toHaveCount(1);
  expect(await held(thread)).toBe(0);
});
