import { test, expect, ids } from "./fixture.mjs";
import { open } from "./timeline.mjs";
import { openPage } from "./navigation.mjs";

// Browser-only: Virtua hides a row at its new index until it is measured, and
// only native focus fixup can show whether focus inside that row survives.
test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  threadUnreadMentions: true,
  inboxDm: true,
  historyCounts: { alpha: 2, beta: 1 },
});

const videoUrl = "https://primary.example/media/inbox-row-focus.mp4";
const twoFrames = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );

// The first DM history page inserts rows on both sides of the selected live
// message. Hold it until the exact reveal has focused that message.
async function openHeldDm(page, app, { addressed = false } = {}) {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, app);
  // Inbox withholds only addressed (#p viewer) targets; a plain DM never is.
  app.append(
    "primary",
    ids["dm-peer"],
    "Live Inbox DM",
    true,
    false,
    undefined,
    undefined,
    addressed ? [["p", app.viewer]] : [],
  );
  await openPage(page, "Inbox");
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  await expect(inbox.getByText("Checking recent activity…")).toHaveCount(0);
  await page.route("**/api/relay/primary/media?**", (route) =>
    route.fulfill({
      path: "tests/fixtures/message-gallery/assets/sample.mp4",
      contentType: "video/mp4",
    }),
  );
  app.append(
    "primary",
    ids["dm-peer"],
    "Inbox video",
    false,
    true,
    undefined,
    undefined,
    [["imeta", `url ${videoUrl}`, "m video/mp4"]],
  );
  await inbox.getByRole("combobox", { name: "Activity type" }).click();
  await page.getByRole("option", { name: "DMs", exact: true }).click();
  await inbox.getByRole("checkbox", { name: "Unread only" }).check();
  const list = inbox.getByRole("list", { name: "Inbox conversations" });
  await expect(list.getByRole("listitem")).toHaveCount(1);

  const history = Promise.withResolvers();
  const gates = { historyRequested: false, closure: undefined };
  await page.route("**/api/relay/**/query", async (route) => {
    const filters = route.request().postDataJSON();
    if (
      filters.some(
        (filter) => filter.top_level && filter["#h"]?.includes(ids["dm-peer"]),
      )
    ) {
      gates.historyRequested = true;
      await history.promise;
      return route.fallback();
    }
    const closure = gates.closure;
    if (
      closure &&
      filters.some(
        (filter) =>
          filter["#e"] &&
          filter.kinds?.includes(40003) &&
          !filter.kinds.includes(39005),
      )
    ) {
      closure.started = true;
      await closure.promise;
    }
    return route.fallback();
  });

  await list
    .getByRole("listitem")
    .first()
    .getByRole("button", { name: /^Open / })
    .click();
  const detail = inbox.getByRole("region", { name: "Inbox detail" });
  const target = detail
    .locator("[data-message-id]")
    .filter({ hasText: "Live Inbox DM" });
  await expect(target).toBeInViewport();
  await expect(target).toBeFocused();
  await expect.poll(() => gates.historyRequested).toBe(true);
  await twoFrames(page);
  const loaded = async () => {
    await expect(
      detail.getByText("Inbox DM fixture reply", { exact: true }),
    ).toBeVisible();
    await expect(
      detail
        .locator("[data-message-id]")
        .filter({ hasText: "Inbox video" })
        .locator("[data-video-preview]"),
    ).toBeVisible();
    await twoFrames(page);
  };
  return { inbox, list, detail, target, history, gates, loaded };
}

// Read-only evidence that the shape under test happened: the Virtua item that
// owns `control` became visibility:hidden while `control` still had focus. It
// reads inline style only (no layout). With `destination`, focus moves there in
// the same microtask, i.e. while the row is still hidden.
async function watchRowHidden(control, destination) {
  const handle = await control.elementHandle();
  const to = destination ? await destination.elementHandle() : null;
  await handle.evaluate((element, moveTo) => {
    const item = element.closest("[data-message-id]")?.parentElement;
    if (!item) throw new Error("Focused control is outside a timeline row");
    const evidence = { seen: false, focusedWhenHidden: false, moved: false };
    window.__inboxRowHidden = evidence;
    const observer = new MutationObserver(() => {
      if (evidence.seen || item.style.visibility !== "hidden") return;
      evidence.seen = true;
      evidence.focusedWhenHidden = document.activeElement === element;
      observer.disconnect();
      if (moveTo) {
        moveTo.focus();
        evidence.moved = document.activeElement === moveTo;
      }
    });
    observer.observe(item, { attributes: true, attributeFilter: ["style"] });
  }, to);
  return () => handle.evaluate(() => window.__inboxRowHidden);
}

test.describe("Inbox timeline row focus across an insert above it", () => {
  for (const control of [
    {
      name: "the target row's message actions trigger",
      row: "Live Inbox DM",
      // The bar renders an empty placeholder group until the row is hovered.
      locate: async (row) => {
        await row.hover();
        return row.getByRole("button", { name: "More message actions" });
      },
    },
    {
      name: "a later row's media opener",
      // Setup's "Inbox video" is undelivered, so it only arrives with the held
      // history. This one is delivered live below the open target instead,
      // then a newer undelivered tail keeps the release changing BOTH ends
      // (ChannelTimeline's prepend test needs last unchanged; this must not be).
      row: "Inbox live video",
      before: (app) => {
        app.append(
          "primary",
          ids["dm-peer"],
          "Inbox live video",
          true,
          true,
          undefined,
          undefined,
          [["imeta", `url ${videoUrl}`, "m video/mp4"]],
        );
        app.append("primary", ids["dm-peer"], "Inbox held tail", false, true);
      },
      locate: (row) =>
        row.getByRole("button", { name: "Open video fullscreen" }),
    },
  ])
    test(`keeps focus on ${control.name}`, async ({ page, app }) => {
      const { detail, history, loaded } = await openHeldDm(page, app);
      try {
        control.before?.(app);
        const row = detail
          .locator("[data-message-id]")
          .filter({ hasText: control.row });
        const focused = await control.locate(row);
        await expect(focused).toHaveCount(1);
        await focused.focus();
        await expect(focused).toBeFocused();
        const evidence = await watchRowHidden(focused);
        history.resolve();
        await loaded();
        expect(await evidence()).toEqual({
          seen: true,
          focusedWhenHidden: true,
          moved: false,
        });
        await expect(focused).toBeFocused();
        await expect(row).toBeVisible();
      } finally {
        history.resolve();
      }
    });

  test("keeps focus a person moves elsewhere while the row is hidden", async ({
    page,
    app,
  }) => {
    const { detail, target, history, loaded } = await openHeldDm(page, app);
    try {
      const editor = detail.getByRole("form").getByRole("textbox");
      await expect(editor).toHaveCount(1);
      const evidence = await watchRowHidden(target, editor);
      history.resolve();
      await loaded();
      expect(await evidence()).toEqual({
        seen: true,
        focusedWhenHidden: true,
        moved: true,
      });
      // No recovery owner: the measured row must not take focus back.
      await expect(editor).toBeFocused();
      await expect(target).not.toBeFocused();
      await expect(target).toBeVisible();
    } finally {
      history.resolve();
    }
  });
});

test.describe("Inbox dismissal and withholding still take focus from a row", () => {
  test("Escape from a row focused across the insert closes the detail", async ({
    page,
    app,
  }) => {
    const { inbox, list, detail, target, history, loaded } = await openHeldDm(
      page,
      app,
    );
    try {
      history.resolve();
      await loaded();
      await expect(target).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(detail).toHaveCount(0);
      await expect(list).toBeVisible();
      await expect(
        inbox.getByRole("combobox", { name: "Activity type", exact: true }),
      ).toBeFocused();
    } finally {
      history.resolve();
    }
  });

  test("withholding hands a focused row to Close, and Escape still dismisses", async ({
    page,
    app,
  }) => {
    const { inbox, list, detail, target, history, gates, loaded } =
      await openHeldDm(page, app, { addressed: true });
    const closure = () => ({ ...Promise.withResolvers(), started: false });
    const dismissed = closure();
    // Interrupt sockets, not read-state durability (see inbox-revalidation).
    let publicationGate;
    const publishing = new Set();
    await page.route(
      "**/api/relay/primary/read-state-publish",
      async (route) => {
        if (publicationGate) await publicationGate.promise;
        const done = Promise.withResolvers();
        publishing.add(done.promise);
        try {
          await route.fulfill({ response: await route.fetch() });
        } finally {
          publishing.delete(done.promise);
          done.resolve();
        }
      },
    );
    const reconnect = async (held) => {
      gates.closure = held;
      publicationGate = Promise.withResolvers();
      await Promise.all([...publishing]);
      app.relay.disconnect("primary");
      await expect.poll(() => held.started).toBe(true);
      const pending = publicationGate;
      publicationGate = undefined;
      pending.resolve();
    };
    const closeDetail = detail.getByRole("button", { name: "Close detail" });
    try {
      history.resolve();
      await loaded();
      await expect(target).toBeFocused();

      // Hand-back to the row on recovery is out of scope: it fails the same
      // way on main (row node replaced; tracked separately).
      await reconnect(dismissed);
      await expect(detail.getByText("Preview updating…")).toBeVisible();
      await expect(closeDetail).toBeFocused();
      await expect(target).not.toBeVisible();
      await page.keyboard.press("Escape");
      await expect(detail).toHaveCount(0);
      const activity = inbox.getByRole("combobox", {
        name: "Activity type",
        exact: true,
      });
      await expect(activity).toBeFocused();
      dismissed.resolve();
      await expect(inbox.getByText("Preview updating…")).toHaveCount(0);
      await twoFrames(page);
      await expect(detail).toHaveCount(0);
      await expect(list).toBeVisible();
      await expect(activity).toBeFocused();
    } finally {
      publicationGate?.resolve();
      gates.closure = undefined;
      history.resolve();
      dismissed.resolve();
    }
  });
});
