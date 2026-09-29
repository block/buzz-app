import { npubEncode } from "nostr-tools/nip19";
import { finalizeEvent, getPublicKey } from "nostr-tools";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({
  productionBroker: true,
  developmentReact: true,
  actionProfile: true,
  readState: true,
  pluginFixtures: true,
  threadUnread: true,
  historyCounts: { alpha: 2, beta: 1 }, // Existing thread fixture needs two root slots.
});

// Browser-only contract: three actual selections -> one signed request -> verified
// encrypted observer traffic -> real ThreadPanel/plugin rows and independent replies.
// Cardinalities, stale-clock permutations and latest-request limits live in Vitest.
test("three recipients work independently through coordination, replies and a no-reply failure", async ({
  page,
  app,
}, testInfo) => {
  const key = (seed) =>
    Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? seed : 0));
  const agents = [5, 6, 7].map((seed, index) => ({
    secret: key(seed),
    pubkey: getPublicKey(key(seed)),
    name: index < 2 ? "Honey" : "Scout",
  }));
  await page.route("**/api/relay/**/agent-library", (route) =>
    route.fulfill({
      json: {
        definitions: [],
        identities: agents.map(({ pubkey, name }) => ({ pubkey, name })),
      },
    }),
  );
  await page.route("**/api/relay/**/query", async (route) => {
    const response = await route.fetch();
    const events = await response.json();
    if (!Array.isArray(events)) return route.fulfill({ response });
    const filters = route.request().postDataJSON();
    const rows = events.map((event) =>
      event.kind === 39002 &&
      event.tags.some(([name, id]) => name === "d" && id === "alpha")
        ? finalizeEvent(
            {
              kind: 39002,
              created_at: event.created_at + 1,
              content: "",
              tags: [
                ...event.tags.filter(
                  ([name, value]) =>
                    name !== "p" ||
                    !agents.some((agent) => agent.pubkey === value),
                ),
                ...agents.map((agent) => ["p", agent.pubkey]),
              ],
            },
            key(1),
          )
        : event,
    );
    const candidates = agents.filter((agent) =>
      filters.some(
        (filter) =>
          filter.kinds?.includes(0) && filter.authors?.includes(agent.pubkey),
      ),
    );
    await route.fulfill({
      response,
      json: [
        ...rows.filter(
          (row) =>
            row.kind !== 0 ||
            !candidates.some((agent) => agent.pubkey === row.pubkey),
        ),
        ...candidates.map((agent) =>
          finalizeEvent(
            {
              kind: 0,
              created_at: 1700000001,
              tags: [],
              content: JSON.stringify({
                display_name: agent.name,
                is_agent: true,
              }),
            },
            agent.secret,
          ),
        ),
      ],
    });
  });
  await open(page, app);
  await expect.poll(() => app.relay.hasRoute("primary", "observer")).toBe(true);
  const form = page.getByRole("form", {
    name: "Send a message to Alpha",
    exact: true,
  });
  for (const agent of agents) {
    await form
      .getByRole("button", { name: "Mention a member", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "Mention a member or agent", exact: true })
      .getByRole("button", { name: new RegExp(`${agent.pubkey}$`) })
      .click();
  }
  const composer = form.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  await composer.press("End");
  await composer.pressSequentially("Please collaborate on this request.");
  let release, signalStarted;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    signalStarted = resolve;
  });
  await page.route("**/api/relay/**/sign", async (route) => {
    if (route.request().postDataJSON().kind !== 9) return route.continue();
    signalStarted();
    await gate;
    await route.continue();
  });
  const thread = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  const tail = thread.getByRole("region", {
    name: "Agent activity in this thread",
    exact: true,
  });
  try {
    await form
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await started;
    await expect(thread).toHaveCount(0);
    await page
      .getByRole("region", { name: "Channel message history", exact: true })
      .getByRole("button", {
        name: "View thread: 3 agents awaiting response",
        exact: true,
      })
      .click();
    await expect(tail).toBeVisible();
    await expect(tail.locator(".buzz-avatar")).toHaveCount(3);
    await expect(
      tail.getByRole("button", { name: "Sending request…", exact: true }),
    ).toHaveCount(3);
    expect(
      app.report.publications.filter(({ event }) => event.kind === 9),
    ).toHaveLength(0);
  } finally {
    release();
  }
  await expect
    .poll(
      () =>
        app.report.publications.filter(({ event }) => event.kind === 9).length,
    )
    .toBe(1);
  const request = app.report.publications.find(
    ({ event }) => event.kind === 9,
  ).event;
  expect(
    request.tags
      .filter(([name]) => name === "p")
      .map(([, key]) => key)
      .sort(),
  ).toEqual(agents.map((agent) => agent.pubkey).sort());
  await expect(
    tail.getByRole("button", { name: "Waiting for response…", exact: true }),
  ).toHaveCount(3);
  // Independently known fixture keys determine expected labels; never learn the
  // key-to-label mapping from whatever production happened to render.
  const byKey = new Map(
    agents.map((agent, index) => [
      agent.pubkey,
      index < 2 ? `Honey · ${npubEncode(agent.pubkey).slice(-4)}` : "Scout",
    ]),
  );
  expect(new Set(byKey.values()).size).toBe(3);
  await expect(tail.locator("p.text-label-sm")).toHaveText(
    [...agents]
      .sort((a, b) => a.pubkey.localeCompare(b.pubkey))
      .map((agent) => byKey.get(agent.pubkey)),
  );
  const entry = (agent) =>
    tail.locator('div[class*="body"]').filter({
      has: page.getByText(byKey.get(agent.pubkey), { exact: true }),
    });
  const counts = new Map();
  const emit = (agent, kind, payload = {}) => {
    const seq = (counts.get(agent.pubkey) ?? 0) + 1;
    counts.set(agent.pubkey, seq);
    app.observer(
      {
        kind,
        seq,
        channelId: "alpha",
        turnId: `turn-${agent.pubkey}`,
        sessionId: "S",
        timestamp: new Date().toISOString(),
        payload,
      },
      agent.secret,
    );
  };
  for (const agent of agents)
    emit(agent, "turn_started", { triggeringEventIds: [request.id] });
  await expect(
    tail.getByRole("button", { name: "Working…", exact: true }),
  ).toHaveCount(3);
  emit(agents[0], "acp_read", {
    method: "session/update",
    params: {
      sessionId: "S",
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Agent A checks facts." },
      },
    },
  });
  emit(agents[1], "acp_read", {
    method: "session/update",
    params: {
      sessionId: "S",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "read",
        title: "buzz-dev-mcp__read_file",
        status: "in_progress",
      },
    },
  });
  await expect(
    entry(agents[0]).getByRole("button", { name: "Thinking…", exact: true }),
  ).toBeVisible();
  await expect(
    entry(agents[1]).getByRole("button", {
      name: "Reading file…",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    entry(agents[2]).getByRole("button", { name: "Working…", exact: true }),
  ).toBeVisible();
  const reply = (agent, content, audience, offset) =>
    finalizeEvent(
      {
        kind: 9,
        created_at: request.created_at + offset,
        tags: [
          ["h", "alpha"],
          ["e", request.id, "", "reply"],
          ["audience", audience],
        ],
        content,
      },
      agent.secret,
    );
  const coordination = reply(
    agents[0],
    "@Honey please review my notes.",
    "agents",
    1,
  );
  app.relay.publish("primary", coordination);
  await expect(
    thread.locator(`[data-message-id="${coordination.id}"]`),
  ).toHaveCount(0);
  await expect(
    thread.getByRole("button", { name: /Coordination/ }),
  ).toHaveCount(0);
  await expect(tail.locator("p.text-label-sm")).toHaveCount(3);
  // A later turn can be triggered by hidden coordination, not the original human request.
  emit(agents[1], "turn_completed");
  await expect(
    entry(agents[1]).getByRole("button", {
      name: "View activity",
      exact: true,
    }),
  ).toBeVisible();
  app.observer(
    {
      kind: "turn_started",
      seq: 1,
      channelId: "alpha",
      turnId: "later-handoff",
      sessionId: "S",
      timestamp: new Date().toISOString(),
      payload: { triggeringEventIds: [coordination.id] },
    },
    agents[1].secret,
  );
  app.observer(
    {
      kind: "acp_read",
      seq: 2,
      channelId: "alpha",
      turnId: "later-handoff",
      sessionId: "S",
      timestamp: new Date().toISOString(),
      payload: {
        method: "session/update",
        params: {
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "handoff-read",
            title: "buzz-dev-mcp__read_file",
            status: "in_progress",
            rawInput: { path: "later-handoff.md" },
          },
        },
      },
    },
    agents[1].secret,
  );
  await expect(
    entry(agents[1]).getByRole("button", {
      name: "Reading later-handoff.md",
      exact: true,
    }),
  ).toBeVisible();
  const channelRequest = page
    .getByRole("region", { name: "Channel message history", exact: true })
    .locator(`[data-message-id="${request.id}"]`);
  await expect(
    channelRequest.getByRole("button", {
      name: /View thread: 3 agents working/,
    }),
  ).toBeVisible();
  await entry(agents[1])
    .getByRole("button", { name: "Reading later-handoff.md", exact: true })
    .click();
  const handoffPopup = page.getByRole("dialog", {
    name: byKey.get(agents[1].pubkey),
    exact: true,
  });
  await expect(
    handoffPopup.getByRole("button", { name: /Read file.*later-handoff.md/ }),
  ).toBeVisible();

  const secondReply = reply(
    agents[1],
    "Agent B: review complete.",
    "everyone",
    2,
  );
  app.relay.publish("primary", secondReply);
  await expect(
    thread.locator(`[data-message-id="${secondReply.id}"]`),
  ).toBeVisible();
  // A published answer is not terminal telemetry: live work remains until its turn ends.
  await expect(tail.locator("p.text-label-sm")).toHaveCount(3);
  app.observer(
    {
      kind: "turn_completed",
      seq: 3,
      channelId: "alpha",
      turnId: "later-handoff",
      sessionId: "S",
      timestamp: new Date().toISOString(),
      payload: {},
    },
    agents[1].secret,
  );
  await expect(handoffPopup).toBeVisible();
  await expect(
    handoffPopup.getByRole("button", { name: /Read file.*later-handoff.md/ }),
  ).toBeVisible();
  await handoffPopup
    .getByRole("button", { name: "Close activity", exact: true })
    .click();
  await expect(tail.locator("p.text-label-sm")).toHaveCount(3);
  await expect(
    entry(agents[1]).getByRole("button", {
      name: "View activity",
      exact: true,
    }),
  ).toBeVisible();
  emit(agents[2], "turn_error", {
    error: "Agent C could not finish; no reply was sent.",
  });
  const waiting = entry(agents[2]).getByRole("button", {
    name: "Observed activity ended · error reported",
    exact: true,
  });
  await expect(waiting).toBeVisible();
  await expect(
    entry(agents[0]).getByRole("button", { name: "Thinking…", exact: true }),
  ).toBeVisible();
  await waiting.click();
  const errorPopup = page.getByRole("dialog", { name: "Scout", exact: true });
  await errorPopup
    .getByRole("button", { name: /^Diagnostics.*Error reported/ })
    .click();
  await errorPopup.getByRole("button", { name: /Turn error/ }).click();
  await expect(
    errorPopup.getByText("Agent C could not finish; no reply was sent.", {
      exact: true,
    }),
  ).toBeVisible();
  await waiting.click();
  const firstReply = reply(agents[0], "Agent A: final answer.", "everyone", 3);
  app.relay.publish("primary", firstReply);
  await expect(
    thread.locator(`[data-message-id="${firstReply.id}"]`),
  ).toBeVisible();
  emit(agents[0], "turn_completed");
  await expect(tail.locator("p.text-label-sm")).toHaveCount(3);
  await expect(
    entry(agents[2]).getByRole("button", {
      name: "Observed activity ended · error reported",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    thread.getByText("2 replies · 1 pending", { exact: true }),
  ).toBeVisible();
  await expect(
    thread.locator(`[data-message-id="${coordination.id}"]`),
  ).toHaveCount(0);
  await expect(
    thread.locator(`[data-message-id="${firstReply.id}"]`),
  ).toBeVisible();
  await expect(
    thread.locator(`[data-message-id="${secondReply.id}"]`),
  ).toBeVisible();
  const extra = reply(
    agents[0],
    "Another retained agent message.",
    "everyone",
    4,
  );
  app.relay.publish("primary", extra);
  await expect(thread.locator(`[data-message-id="${extra.id}"]`)).toBeVisible();
  const replyComposer = thread.getByRole("textbox", {
    name: "Reply to thread",
    exact: true,
  });
  await expect(replyComposer).toBeEditable();
  // Establish canonical ordering explicitly; prior synthetic replies used +4s.
  await page.clock.setFixedTime(new Date((request.created_at + 10) * 1000));
  await replyComposer.fill(
    "Human follow-up stays visible while agents are pending.",
  );
  await thread
    .getByRole("button", { name: "Send message", exact: true })
    .click();
  await expect
    .poll(
      () =>
        app.report.publications.filter(({ event }) => event.kind === 9).length,
    )
    .toBe(2);
  const human = app.report.publications
    .filter(({ event }) => event.kind === 9)
    .at(-1).event;
  const humanRow = thread.locator(`[data-message-id="${human.id}"]`);
  await expect(humanRow).toBeVisible();
  await expect(
    humanRow.locator(
      'xpath=ancestor::*[@aria-label="Agent coordination and activity"]',
    ),
  ).toHaveCount(0);
  // No human mention was necessary; the unresolved request remains before it.
  await expect(
    tail.getByRole("button", {
      name: "Observed activity ended · error reported",
      exact: true,
    }),
  ).toBeVisible();
  const later = finalizeEvent(
    {
      kind: 9,
      created_at: human.created_at + 1,
      tags: [
        ["h", "alpha"],
        ["audience", "agents"],
        ["e", request.id, "", "reply"],
      ],
      content: "Later agent coordination after the human boundary.",
    },
    agents[2].secret,
  );
  app.relay.publish("primary", later);
  const final = finalizeEvent(
    {
      kind: 9,
      created_at: human.created_at + 2,
      tags: [
        ["h", "alpha"],
        ["e", request.id, "", "reply"],
        ["audience", "everyone"],
      ],
      content: "Final human-facing answer stays visible.",
    },
    agents[2].secret,
  );
  app.relay.publish("primary", final);
  await expect(thread.locator(`[data-message-id="${final.id}"]`)).toBeVisible();
  await expect(
    thread.getByRole("region", { name: "Agent coordination and activity" }),
  ).toHaveCount(0);
  await expect(thread.locator(`[data-message-id="${later.id}"]`)).toHaveCount(
    0,
  );
  // Control actual dwell time: hidden messages must not enter durable read state.
  await page.clock.install({ time: new Date((human.created_at + 2) * 1000) });
  const frontiers = () =>
    page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const request = indexedDB.open("buzz-read-state-v1", 1);
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const db = request.result;
            const transaction = db.transaction("partitions", "readonly");
            const read = transaction.objectStore("partitions").getAll();
            read.onsuccess = () =>
              resolve(read.result[0]?.state.frontiers ?? {});
            read.onerror = () => reject(read.error);
            transaction.oncomplete = () => db.close();
          };
        }),
    );
  await thread
    .getByRole("region", { name: "Thread messages", exact: true })
    .focus();
  await page.clock.runFor(800);
  expect((await frontiers())[`msg:${later.id}`]).toBeUndefined();
  await page.clock.resume();
  await expect(humanRow).toBeVisible();
  await expect(thread.locator(`[data-message-id="${final.id}"]`)).toBeVisible();
  for (const mode of ["light", "dark"]) {
    await page.evaluate((mode) => {
      document.documentElement.dataset.colorMode = mode;
    }, mode);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await replyComposer.scrollIntoViewIfNeeded();
      await expect(replyComposer).toBeInViewport();
      await expect(replyComposer).toBeEditable();
      await page.screenshot({
        path: testInfo.outputPath(`activity-only-${mode}-${width}.png`),
      });
    }
  }
  await page.setViewportSize({ width: 1440, height: 950 });
  // Store live-only synthetic publications in the modeled history too: exact
  // link resolution performs a finite read, not a lookup in the open view.
  app.histories
    .get("primary/alpha")
    .push(coordination, secondReply, firstReply, extra, later, final);
  // An exact coordination link cannot reintroduce hidden conversation content.
  await page.getByRole("button", { name: "Close thread", exact: true }).click();
  const linkMessage = app.append(
    "primary",
    "alpha",
    `<buzz://message?channel=alpha&id=${later.id}>`,
  );
  const linkRow = page.locator(
    `[data-channel-timeline] [data-message-id="${linkMessage.id}"]`,
  );
  await linkRow.getByRole("link", { name: "Alpha", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.fixtureNavigation.snapshot().status))
    .toBe("failed");
  await expect(page.locator(`[data-message-id="${later.id}"]`)).toHaveCount(0);
  // Failed exact navigation retires its destination. Back restores the channel before another click.
  await page.getByRole("button", { name: "Go back", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Channel message history", exact: true }),
  ).toBeVisible();
  const rootLink = app.append(
    "primary",
    "alpha",
    `<buzz://message?channel=alpha&id=${request.id}&thread=${request.id}>`,
  );
  await page
    .locator(`[data-channel-timeline] [data-message-id="${rootLink.id}"]`)
    .getByRole("link", { name: "Alpha", exact: true })
    .click();
  const nestedAnswer = finalizeEvent(
    {
      kind: 9,
      created_at: final.created_at + 1,
      tags: [
        ["h", "alpha"],
        ["e", request.id, "", "root"],
        ["e", later.id, "", "reply"],
        ["audience", "everyone"],
      ],
      content:
        "Nested human-facing answer is visible without expanding coordination.",
    },
    agents[2].secret,
  );
  app.histories.get("primary/alpha").push(nestedAnswer);
  app.relay.publish("primary", nestedAnswer);
  const nestedRow = thread.locator(`[data-message-id="${nestedAnswer.id}"]`);
  await expect(nestedRow).toBeVisible();
  await expect(thread.locator(`[data-message-id="${later.id}"]`)).toHaveCount(
    0,
  );
  await expect(
    nestedRow.locator(
      'xpath=ancestor::*[@aria-label="Agent coordination and activity"]',
    ),
  ).toHaveCount(0);
  await expect(nestedRow).toBeVisible();
  await nestedRow.hover();
  await nestedRow.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(
    thread.getByRole("button", { name: "Cancel reply target", exact: true }),
  ).toBeVisible();
  await expect(replyComposer).toBeEditable();
  await page.screenshot({
    path: testInfo.outputPath("three-agent-mixed-outcome.png"),
  });
});
