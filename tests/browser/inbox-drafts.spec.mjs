import { test, expect } from "./fixture.mjs";
import { open, settle } from "./timeline.mjs";
import { openPage } from "./navigation.mjs";

test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  threadUnreadMentions: true,
  inboxDm: true,
  historyCounts: { alpha: 2, beta: 1 },
});

// Browser-only: real shared frames, native rich editing, visible history,
// scroll ownership and responsive geometry; lifecycle matrices stay in RTL.
test("Draft and conversation previews share their frame and show real selected context", async ({
  page,
  app,
}, testInfo) => {
  // A bounded, scrollable DM tail exercises bottom positioning. These rows are
  // signed upstream fixture data, not a client cache or live-account mutation.
  for (let index = 0; index < 16; index++)
    app.append("primary", "dm-peer", `Context line ${index}`, false, false);
  const root = app.histories.get("primary/alpha")[0].id;
  const scope = `https://primary.example:${app.viewer}`;
  const canonicalPosition = {
    offset: 0,
    bottom: false,
    anchor: { id: app.histories.get("primary/dm-peer")[0].id, y: 0 },
  };
  await page.addInitScript(
    ({ scope, root, canonicalPosition }) => {
      const save = (key, value) =>
        localStorage.setItem(
          `buzz-view.v1:${JSON.stringify([scope, key])}`,
          JSON.stringify(value),
        );
      save("draft:dm-peer", { text: "  hello\nBlossom  ", recipients: [] });
      save(`draft:alpha:thread:${root}`, {
        text: "Thread notes",
        recipients: [],
      });
      save("draft:beta", { text: "Channel notes", recipients: [] });
      save("scroll:dm-peer", canonicalPosition);
    },
    { scope, root, canonicalPosition },
  );
  await open(page, app);
  await page.getByRole("button", { name: "Inbox", exact: true }).click();
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  await expect(inbox.getByText("Checking recent activity…")).toHaveCount(0);
  const chooseActivity = async (label) => {
    await inbox.getByRole("combobox", { name: "Activity type" }).click();
    await page.getByRole("option", { name: label, exact: true }).click();
  };
  await chooseActivity("Mentions");
  await inbox
    .getByRole("list", { name: "Inbox conversations" })
    .getByRole("listitem")
    .filter({ hasText: "Unread reply 1" })
    .getByRole("button", { name: /^Open / })
    .click();
  const styleOf = (frame) =>
    frame.evaluate((element) => {
      const style = getComputedStyle(element),
        header = element.querySelector("header");
      return {
        border: style.borderTopWidth,
        color: style.borderTopColor,
        radius: style.borderTopLeftRadius,
        fill: style.backgroundColor,
        headerMinHeight: getComputedStyle(header).minHeight,
      };
    });
  const reference = inbox.getByRole("complementary", { name: "Thread" });
  await expect(
    reference.getByText("Thread root 1", { exact: true }),
  ).toBeVisible();
  const mode = testInfo.project.name === "webkit" ? "dark" : "light";
  await page.evaluate((mode) => {
    document.documentElement.dataset.colorMode = mode;
  }, mode);
  const expectedStyle = await styleOf(reference);
  await reference.getByRole("button", { name: "Close thread" }).click();
  await inbox.getByRole("button", { name: "Drafts", exact: true }).click();
  const draftList = inbox.getByRole("list", { name: "Drafts" });
  await expect(draftList.getByRole("listitem")).toHaveCount(3);
  await expect(inbox.getByRole("button", { name: "Refresh" })).toHaveCount(0);
  await expect(
    inbox.getByRole("button", { name: "Back to drafts" }),
  ).toHaveCount(0);
  const detail = inbox.getByRole("region", { name: "Draft detail" });
  const readDraft = (key) =>
    page.evaluate(
      ({ scope, key }) =>
        JSON.parse(
          localStorage.getItem(`buzz-view.v1:${JSON.stringify([scope, key])}`),
        ),
      { scope, key },
    );
  const geometry = async (frame, history) => {
    await expect(frame.getByRole("form")).toHaveCount(1);
    await expect(frame.getByRole("textbox")).toBeVisible();
    const h = await history.boundingBox(),
      c = await frame.getByRole("form").boundingBox();
    expect(h.height).toBeGreaterThan(100);
    expect(c.y).toBeGreaterThanOrEqual(h.y + h.height);
    expect(c.x).toBeGreaterThanOrEqual(h.x);
    expect(c.x + c.width).toBeLessThanOrEqual(h.x + h.width + 1);
    expect(await inbox.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
      true,
    );
  };
  for (const width of [1280, 760, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await draftList
      .getByRole("button", {
        name: "Open draft for Alice Fixture",
        exact: true,
      })
      .click();
    const dm = detail.getByRole("region", { name: "Conversation preview" });
    const history = dm.getByRole("region", { name: "Channel message history" });
    await detail.scrollIntoViewIfNeeded();
    await expect(
      detail.getByRole("heading", { name: "Draft · DM to Alice Fixture" }),
    ).toBeVisible();
    await expect(
      history.getByText("Context line 15", { exact: true }),
    ).toBeInViewport();
    await settle(page, history);
    expect(await styleOf(dm)).toEqual(expectedStyle);
    await geometry(dm, history);
    await expect
      .poll(() =>
        history.evaluate((el) =>
          Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop),
        ),
      )
      .toBeLessThan(2);
    const input = dm.getByRole("textbox", {
      name: "Message DM with Alice Fixture",
    });
    await expect(input).toContainText("Blossom");
    if (width === 1280) {
      await input.click();
      await input.press("ControlOrMeta+End");
      await input.pressSequentially("!");
      await expect
        .poll(async () => (await readDraft("draft:dm-peer")).text)
        .toBe("  hello\nBlossom  !");
    }
    await page.screenshot({
      path: testInfo.outputPath(`dm-draft-${width}.png`),
    });
    await draftList
      .getByRole("button", { name: "Open draft for #Beta", exact: true })
      .click();
    const channel = detail.getByRole("region", {
      name: "Conversation preview",
    });
    const channelHistory = channel.getByRole("region", {
      name: "Channel message history",
    });
    await detail.scrollIntoViewIfNeeded();
    await expect(
      channelHistory.getByText(/primary beta message 0/),
    ).toBeInViewport();
    await geometry(channel, channelHistory);
    expect(await styleOf(channel)).toEqual(expectedStyle);
    await expect(
      channel.getByRole("textbox", { name: "Message #Beta" }),
    ).toContainText("Channel notes");
    await draftList
      .getByRole("button", { name: "Open draft for #Alpha", exact: true })
      .click();
    const thread = detail.getByRole("complementary", { name: "Thread" });
    const replies = thread.getByRole("region", { name: "Thread messages" });
    await detail.scrollIntoViewIfNeeded();
    await expect(
      replies.getByText("Unread reply 0", { exact: true }),
    ).toBeInViewport();
    // At narrow widths context can exceed the viewport. Bottom opens on the
    // latest returned reply; the root remains reachable in the same scroller.
    await replies
      .getByText("Thread root 0", { exact: true })
      .scrollIntoViewIfNeeded();
    await expect(
      replies.getByText("Thread root 0", { exact: true }),
    ).toBeInViewport();
    await replies
      .getByText("Unread reply 0", { exact: true })
      .scrollIntoViewIfNeeded();
    await expect(
      replies.getByText("Unread reply 0", { exact: true }),
    ).toBeInViewport();
    await expect(
      thread.getByRole("textbox", { name: "Reply to thread" }),
    ).toContainText("Thread notes");
    await geometry(thread, replies);
    expect(await styleOf(thread)).toEqual(expectedStyle);
    await expect(
      detail.getByRole("button", { name: "Delete draft…" }),
    ).toHaveAttribute("data-size", "sm");
    await page.screenshot({
      path: testInfo.outputPath(`thread-draft-${width}.png`),
    });
  }
  expect(await readDraft("scroll:dm-peer")).toEqual(canonicalPosition);
  // Synthetic fixture publication exercises the real thread composer/outbox path.
  await detail.getByRole("button", { name: "Send message" }).click();
  await expect
    .poll(() => app.report.publications.filter(({ event }) => event.kind === 9))
    .toHaveLength(1);
  const sent = app.report.publications.find(
    ({ event }) => event.kind === 9,
  ).event;
  expect(sent.content).toBe("Thread notes");
  expect(sent.tags).toContainEqual(["h", "alpha"]);
  expect(sent.tags).toContainEqual(["e", root, "", "reply"]);
  expect((await readDraft("draft:dm-peer")).text).toBe("  hello\nBlossom  !");
});

// Saved-root drafts share the strict window reader, but open its newest context,
// not the Inbox's older unread anchor or another root's composer.
test.describe("saved strict-window draft", () => {
  const channel = "00000000-0000-0000-0000-000000000123";
  test.use({
    threadUnread: false,
    threadUnreadMentions: false,
    inboxDm: false,
    inboxThreadWindow: true,
    channelIds: ["alpha", channel],
    channelNames: { [channel]: "Window room" },
    historyCounts: { alpha: 1, [channel]: 0 },
  });
  test("opens the exact saved root with newest reply context and one composer", async ({
    page,
    app,
  }) => {
    const { root, replies } = app.inboxWindow;
    const newest = replies.at(-1);
    await page.addInitScript(
      ({ viewer, rootId, channelId }) => {
        localStorage.setItem(
          `buzz-view.v1:${JSON.stringify([`https://primary.example:${viewer}`, `draft:${channelId}:thread:${rootId}`])}`,
          JSON.stringify({ text: "Strict window draft", recipients: [] }),
        );
      },
      { viewer: app.viewer, rootId: root.id, channelId: channel },
    );
    await page.goto(app.origin);
    await openPage(page, "Inbox");
    const inbox = page.getByRole("region", { name: "Inbox", exact: true });
    await expect(inbox.getByText("Checking recent activity…")).toHaveCount(0);
    await inbox.getByRole("button", { name: "Drafts", exact: true }).click();
    await inbox
      .getByRole("list", { name: "Drafts" })
      .getByRole("button", { name: "Open draft for #Window room" })
      .click();
    const draft = inbox.getByRole("region", { name: "Draft detail" });
    await expect(
      draft.getByRole("textbox", { name: "Reply to thread" }),
    ).toContainText("Strict window draft");
    await expect(
      draft.getByText(newest.content, { exact: true }),
    ).toBeInViewport();
    await expect(draft.getByRole("form")).toHaveCount(1);
    await draft.getByRole("button", { name: "Close thread" }).click();
    await inbox.getByRole("button", { name: "Back to Inbox" }).click();
    await expect(
      inbox.getByRole("combobox", { name: "Activity type" }),
    ).toBeVisible();
  });
});

// Browser-only: native storage-event delivery between two same-origin pages,
// with real editors. Conflict permutations and write failures stay in RTL.
test("two pages coordinate a selected draft through actual storage events", async ({
  page,
  context,
  app,
}) => {
  const scope = `https://primary.example:${app.viewer}`;
  const key = `buzz-view.v1:${JSON.stringify([scope, "draft:beta"])}`;
  await open(page, app);
  await page.evaluate(
    (key) => localStorage.setItem(key, JSON.stringify("Original shared draft")),
    key,
  );
  const selectDraft = async (target) => {
    await openPage(target, "Inbox");
    const inbox = target.getByRole("region", { name: "Inbox", exact: true });
    await expect(inbox.getByText("Checking recent activity…")).toHaveCount(0);
    await inbox.getByRole("button", { name: "Drafts", exact: true }).click();
    await inbox
      .getByRole("button", { name: "Open draft for #Beta", exact: true })
      .click();
    return inbox.getByRole("textbox", { name: "Message #Beta" });
  };
  const first = await selectDraft(page);
  const other = await context.newPage();
  try {
    await other.goto(app.origin);
    const second = await selectDraft(other);
    await expect(second).toContainText("Original shared draft");
    // Register before the write; never dispatch a synthetic StorageEvent.
    await page.evaluate((key) => {
      window.__draftStorageEvents = [];
      window.addEventListener("storage", (event) => {
        if (event.key === key && event.storageArea === localStorage)
          window.__draftStorageEvents.push({
            trusted: event.isTrusted,
            value: event.newValue,
          });
      });
    }, key);
    await second.fill("Revision from the second page");
    await expect(first).toContainText("Revision from the second page");
    await expect
      .poll(() => page.evaluate(() => window.__draftStorageEvents.length))
      .toBeGreaterThan(0);
    expect(
      await page.evaluate(() =>
        window.__draftStorageEvents.every((event) => event.trusted),
      ),
    ).toBe(true);
    await first.fill("First page local edits");
    await expect(other.getByRole("alert")).toContainText("changed elsewhere");
    await other.getByRole("button", { name: "Keep my draft" }).click();
    await expect(page.getByRole("alert")).toContainText("changed elsewhere");
    await expect(first).toContainText("First page local edits");
    await expect(page.getByRole("list", { name: "Drafts" })).toContainText(
      "Revision from the second page",
    );
    await page
      .getByRole("button", { name: "Open draft for #Beta", exact: true })
      .click();
    await expect(first).toContainText("First page local edits");
    await expect(
      page.getByRole("button", { name: "Send message" }),
    ).toBeDisabled();
    await page.getByRole("button", { name: "Load saved draft" }).click();
    await expect(first).toContainText("Revision from the second page");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect
      .poll(() =>
        app.report.publications.filter(({ event }) => event.kind === 9),
      )
      .toHaveLength(1);
    expect(
      app.report.publications.find(({ event }) => event.kind === 9).event
        .content,
    ).toBe("Revision from the second page");
    await expect(
      page.getByRole("region", { name: "Draft detail" }),
    ).toHaveCount(0);
    // The still-dirty peer retains its own document and is blocked until it
    // acknowledges the actual storage-event cleanup, rather than resending it.
    await expect(other.getByRole("alert")).toContainText("changed elsewhere");
    await expect(
      other.getByRole("button", { name: "Send message" }),
    ).toBeDisabled();
    await other.getByRole("button", { name: "Load saved draft" }).click();
    await expect(second).toHaveText("");
  } finally {
    await other.close();
  }
});

// Browser-only: native keyboard activation and post-unmount focus handoff in
// the responsive real workspace. Failure/race permutations stay in mounted RTL.
test("keyboard draft retirement returns to its row, a remaining row, then Back to Inbox", async ({
  page,
  app,
}) => {
  const root = app.histories.get("primary/alpha")[0].id;
  const scope = `https://primary.example:${app.viewer}`;
  await page.addInitScript(
    ({ scope, root }) => {
      for (const [key, text] of [
        ["draft:beta", "Channel draft"],
        [`draft:alpha:thread:${root}`, "Thread draft"],
      ])
        localStorage.setItem(
          `buzz-view.v1:${JSON.stringify([scope, key])}`,
          JSON.stringify(text),
        );
    },
    { scope, root },
  );
  await open(page, app);
  await openPage(page, "Inbox");
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  await expect(inbox.getByText("Checking recent activity…")).toHaveCount(0);
  const activate = async (control) => {
    // focus() does not wait for enabled state while the draft root loads.
    await expect(control).toBeEnabled();
    await control.focus();
    await expect(control).toBeFocused();
    await page.keyboard.press("Enter");
  };
  await activate(inbox.getByRole("button", { name: "Drafts", exact: true }));
  const beta = inbox.getByRole("button", {
    name: "Open draft for #Beta",
    exact: true,
  });
  const alpha = inbox.getByRole("button", {
    name: "Open draft for #Alpha",
    exact: true,
  });
  const detail = inbox.getByRole("region", { name: "Draft detail" });
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [row, close] of [
      [beta, "Close detail"],
      [alpha, "Close thread"],
    ]) {
      await activate(row);
      await expect(detail.getByRole("textbox")).toBeVisible();
      await activate(detail.getByRole("button", { name: close }));
      await expect(detail).toHaveCount(0);
      await expect(row).toBeFocused();
      await expect(row).toBeInViewport();
    }
  }
  await activate(beta);
  await activate(detail.getByRole("button", { name: "Delete draft…" }));
  await expect(
    detail.getByRole("button", { name: "Delete draft", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(detail).toHaveCount(0);
  await expect(beta).toHaveCount(0);
  await expect(alpha).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(detail.getByRole("textbox")).toContainText("Thread draft");
  await activate(detail.getByRole("button", { name: "Send message" }));
  await expect
    .poll(() => app.report.publications.filter(({ event }) => event.kind === 9))
    .toHaveLength(1);
  await expect(detail).toHaveCount(0);
  const back = inbox.getByRole("button", { name: "Back to Inbox" });
  await expect(back).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    inbox.getByRole("combobox", { name: "Activity type" }),
  ).toBeVisible();
});
