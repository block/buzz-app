import { finalizeEvent, getPublicKey } from "nostr-tools";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";
test.use({
  productionBroker: true,
  developmentReact: true,
  actionProfile: true,
  readState: true,
  threadUnread: true,
  historyCounts: { alpha: 2, beta: 1 },
});
// Browser-only: exact signed request -> scoped encrypted telemetry -> one shared
// header before authored replies, hover/focus/panel transfer and hidden read dwell.
// Ambiguous lineage, clocks, retention and malformed records are covered in Vitest.
test("one request work header spans agents and replies without absorbing a follow-up", async ({
  page,
  app,
}, testInfo) => {
  const key = (n) =>
    Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? n : 0));
  const agents = [5, 6, 7].map((n, i) => ({
    key: key(n),
    pubkey: getPublicKey(key(n)),
    name: ["Blossom", "Bubbles", "Buttercup"][i],
  }));
  await page.route("**/api/relay/**/agent-library", (r) =>
    r.fulfill({
      json: {
        definitions: [],
        identities: agents.map((a) => ({ pubkey: a.pubkey, name: a.name })),
      },
    }),
  );
  await page.route("**/api/relay/**/query", async (route) => {
    const response = await route.fetch(),
      events = await response.json();
    if (!Array.isArray(events)) return route.fulfill({ response });
    const filters = route.request().postDataJSON();
    const profiles = agents.filter((a) =>
      filters.some(
        (f) => f.kinds?.includes(0) && f.authors?.includes(a.pubkey),
      ),
    );
    const rows = events
      .filter(
        (e) => e.kind !== 0 || !profiles.some((a) => a.pubkey === e.pubkey),
      )
      .map((e) =>
        e.kind === 39002 && e.tags.some(([n, v]) => n === "d" && v === "alpha")
          ? finalizeEvent(
              {
                kind: e.kind,
                created_at: e.created_at + 1,
                content: e.content,
                tags: [
                  ...e.tags.filter(
                    ([n, v]) =>
                      n !== "p" || !agents.some((a) => a.pubkey === v),
                  ),
                  ...agents.map((a) => ["p", a.pubkey]),
                ],
              },
              key(1),
            )
          : e,
      );
    await route.fulfill({
      response,
      json: [
        ...rows,
        ...profiles.map((a) =>
          finalizeEvent(
            {
              kind: 0,
              created_at: 1700000001,
              tags: [],
              content: JSON.stringify({ name: a.name, is_agent: true }),
            },
            a.key,
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
      .getByRole("dialog", { name: "Mention a member or agent" })
      .getByRole("button", { name: new RegExp(`${agent.pubkey}$`) })
      .click();
  }
  await form.getByRole("textbox").press("End");
  await form
    .getByRole("textbox")
    .pressSequentially("Please compare three lunch options.");
  await form.getByRole("button", { name: "Send message", exact: true }).click();
  await expect
    .poll(
      () => app.report.publications.filter((x) => x.event.kind === 9).length,
    )
    .toBe(1);
  const request = app.report.publications.find((x) => x.event.kind === 9).event;
  const thread = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  await expect(thread).toHaveCount(0);
  await page
    .getByRole("region", { name: "Channel message history", exact: true })
    .locator(`[data-message-id="${request.id}"]`)
    .getByRole("button", { name: /^View thread/ })
    .click();
  const header = thread.getByRole("region", {
    name: "Work linked to this request",
    exact: true,
  });
  await expect(header).toHaveCount(1);
  await expect(
    header.getByRole("button", { name: /awaiting activity/ }),
  ).toBeVisible();
  await expect(header.locator(".buzz-avatar")).toHaveCount(3);
  let time = Date.now();
  await page.clock.setFixedTime(new Date(time));
  const seq = new Map();
  function emit(i, turn, kind, payload = {}) {
    const n = (seq.get(`${i}:${turn}`) ?? 0) + 1;
    seq.set(`${i}:${turn}`, n);
    app.observer(
      {
        kind,
        seq: n,
        channelId: "alpha",
        turnId: turn,
        sessionId: "S",
        timestamp: new Date(time).toISOString(),
        payload,
      },
      agents[i].key,
    );
  }
  const tool = (i, turn, id, command) =>
    emit(i, turn, "acp_read", {
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call",
          toolCallId: id,
          title: "buzz-dev-mcp__shell",
          status: "in_progress",
          rawInput: { command },
        },
      },
    });
  const finish = (i, turn, id, message) =>
    emit(i, turn, "acp_read", {
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: id,
          status: "completed",
          rawOutput: { isError: false },
          content: [
            {
              type: "content",
              content: {
                type: "text",
                text: JSON.stringify({
                  exit_code: 0,
                  timed_out: false,
                  stdout_truncated: false,
                  stdout: JSON.stringify({
                    accepted: true,
                    event_id: message.id,
                    message: "",
                    mention_pubkeys: [],
                    audience:
                      message.tags.find((t) => t[0] === "audience")?.[1] ??
                      "everyone",
                  }),
                }),
              },
            },
          ],
        },
      },
    });
  const reply = (i, body, audience = "everyone") =>
    finalizeEvent(
      {
        kind: 9,
        created_at: Math.floor(time / 1000),
        tags: [
          ["h", "alpha"],
          ["e", request.id, "", "reply"],
          ["audience", audience],
        ],
        content: body,
      },
      agents[i].key,
    );
  emit(0, "first", "turn_started", { triggeringEventIds: [request.id] });
  tool(
    0,
    "first",
    "handoff",
    "python3 compare.py; buzz messages send --audience agents",
  );
  await expect(
    header.getByRole("button", { name: "Blossom is working…", exact: true }),
  ).toBeVisible();
  const coordination = reply(0, "Synthetic hidden handoff", "agents");
  finish(0, "first", "handoff", coordination);
  app.relay.publish("primary", coordination);
  emit(0, "first", "turn_completed");
  time += 60000;
  await page.clock.setFixedTime(new Date(time));
  emit(1, "second", "turn_started", { triggeringEventIds: [coordination.id] });
  tool(1, "second", "verify", "python3 verify.py");
  emit(2, "third", "turn_started", { triggeringEventIds: [request.id] });
  tool(2, "third", "check", "python3 portions.py");
  await expect(
    header.getByRole("button", {
      name: /(?=.*Bubbles)(?=.*Buttercup).*working/,
    }),
  ).toBeVisible();
  const draft = thread.getByRole("textbox", {
    name: "Reply to thread",
    exact: true,
  });
  await draft.fill("Keep this draft");
  await draft.focus();
  const trigger = header.getByRole("button");
  await trigger.hover();
  const popup = page.getByRole("dialog", {
    name: "Request activity",
    exact: true,
  });
  await expect(popup).toBeVisible();
  await expect(draft).toBeFocused();
  const choose = async (name) => {
    await popup.getByRole("combobox", { name: "Agent", exact: true }).click();
    await page.getByRole("option", { name, exact: true }).click();
  };
  await choose("Bubbles");
  await expect(
    popup.getByRole("button", { name: /Run command.*python3 verify.py/ }),
  ).toBeVisible();
  const bubbleAnswer = reply(1, "Portions checked.");
  finish(1, "second", "verify", bubbleAnswer);
  app.relay.publish("primary", bubbleAnswer);
  time += 60000;
  await page.clock.setFixedTime(new Date(time));
  emit(1, "second", "turn_completed");
  const finalAnswer = reply(2, "Order C fits the budget.");
  finish(2, "third", "check", finalAnswer);
  app.relay.publish("primary", finalAnswer);
  emit(2, "third", "turn_completed");
  await expect(popup).toBeVisible();
  await popup
    .getByRole("button", { name: "Close activity", exact: true })
    .click();
  await expect(
    header.getByRole("button", {
      name: /(?=.*Blossom)(?=.*Bubbles)(?=.*Buttercup).*worked for 2 minutes/,
    }),
  ).toBeVisible();
  const firstAnswer = thread.locator(`[data-message-id="${bubbleAnswer.id}"]`),
    lastAnswer = thread.locator(`[data-message-id="${finalAnswer.id}"]`);
  await expect(firstAnswer).toBeVisible();
  await expect(lastAnswer).toBeVisible();
  await expect(
    thread.getByRole("button", { name: "View activity", exact: true }),
  ).toHaveCount(0);
  await expect(
    thread.locator(`[data-message-id="${coordination.id}"]`),
  ).toHaveCount(0);
  expect((await header.boundingBox()).y).toBeLessThan(
    (await firstAnswer.boundingBox()).y,
  );
  await expect(draft).toHaveText("Keep this draft");
  // A second request gets a separate anchored header; the first keeps its old records.
  await draft.fill("Follow up on portion sizes.");
  await thread
    .getByRole("button", { name: "Send message", exact: true })
    .click();
  await expect
    .poll(
      () => app.report.publications.filter((x) => x.event.kind === 9).length,
    )
    .toBe(2);
  const second = app.report.publications
    .filter((x) => x.event.kind === 9)
    .at(-1).event;
  emit(1, "followup", "turn_started", { triggeringEventIds: [second.id] });
  tool(1, "followup", "new", "python3 followup.py");
  const headers = thread.getByRole("region", {
    name: "Work linked to this request",
    exact: true,
  });
  await expect(headers).toHaveCount(2);
  await headers.first().getByRole("button").click();
  await choose("Bubbles");
  await expect(popup.getByRole("button", { name: /verify.py/ })).toBeVisible();
  await expect(popup.getByRole("button", { name: /followup.py/ })).toHaveCount(
    0,
  );
  await popup
    .getByRole("button", { name: "Open activity in panel", exact: true })
    .click();
  const panel = page.getByRole("region", {
    name: "Agent activity",
    exact: true,
  });
  await expect(panel).toBeVisible();
  await expect(thread).toBeVisible();
  await expect(
    panel.getByRole("combobox", { name: "Agent", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Close channel panel", exact: true })
    .click();
  // Hidden coordination never mounts and cannot earn read dwell while visible replies do.
  await page.clock.install({ time: new Date(time) });
  await thread
    .getByRole("region", { name: "Thread messages", exact: true })
    .focus();
  await page.clock.runFor(800);
  const hiddenRead = await page.evaluate(
    (id) =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open("buzz-read-state-v1", 1);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result,
            tx = db.transaction("partitions", "readonly"),
            read = tx.objectStore("partitions").getAll();
          read.onsuccess = () =>
            resolve(
              read.result.some((part) =>
                Object.hasOwn(part.state.frontiers, `msg:${id}`),
              ),
            );
          read.onerror = () => reject(read.error);
          tx.oncomplete = () => db.close();
        };
      }),
    coordination.id,
  );
  expect(hiddenRead).toBe(false);
  await page.clock.resume();
  for (const mode of ["light", "dark"]) {
    await page.evaluate(
      (m) => (document.documentElement.dataset.colorMode = m),
      mode,
    );
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await headers.last().scrollIntoViewIfNeeded();
      await expect(headers.last()).toBeInViewport();
      await expect(draft).toBeEditable();
      await page.screenshot({
        path: testInfo.outputPath(`shared-work-${mode}-${width}.png`),
      });
    }
  }
});
