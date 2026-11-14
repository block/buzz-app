import { readFile } from "node:fs/promises";
import { test, expect } from "./source-fixture.mjs";

const picture = readFile(
  new URL("../../public/shell-gradient.png", import.meta.url),
);

// Holds the fixture photo's requests until the test answers them with a 404 or
// the picture, and counts every request the page makes for it.
async function photoRequests(page) {
  const pending = [];
  let outcome;
  const respond = async (route, answer) =>
    answer === "load"
      ? route.fulfill({ contentType: "image/png", body: await picture })
      : route.fulfill({ status: 404 });
  const requests = {
    count: 0,
    pending: () => pending.length,
    hold() {
      outcome = undefined;
    },
    answer(answer) {
      outcome = answer;
      for (const route of pending.splice(0)) void respond(route, answer);
    },
  };
  await page.route(
    (url) =>
      url.pathname === "/shell-gradient.png" && url.search === "?image-failure",
    (route) => {
      requests.count++;
      if (outcome) return respond(route, outcome);
      pending.push(route);
    },
  );
  return requests;
}

async function box(locator) {
  await expect(locator).toBeVisible();
  const bounds = await locator.boundingBox();
  if (!bounds?.width || !bounds.height)
    throw new Error("Expected a nonzero layout box");
  return bounds;
}

test("Retry that succeeds shows the same image, returns focus to it and requests it once", async ({
  page,
}) => {
  const requests = await photoRequests(page);
  try {
    await page.goto("/tests/fixtures/media-review.html?image-failure");
    const link = page.getByRole("link", { name: "Open image attachment" });
    await expect.poll(requests.pending).toBe(1);
    // A focused image that fails hands focus to its Retry.
    await link.focus();
    requests.answer("fail");
    const frame = page.locator("[data-image-failed]");
    const retry = frame.getByRole("button", { name: "Retry image" });
    await expect(frame.getByRole("status")).toHaveText("Couldn't load image");
    await expect(retry).toBeFocused();
    await frame
      .locator("img")
      .evaluate((image) => Object.assign(window, { failedImage: image }));

    requests.hold();
    await page.keyboard.press("Enter");
    await expect.poll(requests.pending).toBe(1);
    await expect(retry).toHaveAttribute("aria-busy", "true");
    await expect(retry).toBeFocused();
    await expect(frame.getByRole("status")).toHaveText("Loading image…");

    requests.answer("load");
    await expect(link).toHaveAttribute("data-image-ready");
    await expect(link).toBeFocused();
    await expect(link.locator("img")).toBeVisible();
    expect(
      await link
        .locator("img")
        .evaluate((image) => image === window.failedImage),
    ).toBe(true);
    await expect(page.getByRole("status")).toHaveCount(0);
    expect(requests.count).toBe(2);
  } finally {
    requests.answer("fail");
  }
});

test("a viewer Retry keeps focus and its place above the toolbar, and closing returns to the row's Retry", async ({
  page,
}) => {
  const requests = await photoRequests(page);
  try {
    await page.goto("/tests/fixtures/media-review.html?image-failure");
    await expect.poll(requests.pending).toBe(1);
    await page.getByRole("link", { name: "Open image attachment" }).focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Image viewer" });
    const stage = dialog.locator("[data-review-stage]");
    await expect(stage).toBeVisible();
    requests.answer("fail");
    await expect(stage.getByRole("status")).toHaveText("Couldn't load image");
    // The row behind the modal keeps its error to itself, so a Retry in the
    // viewer is announced once.
    const statuses = page
      .getByRole("status")
      .filter({ hasText: /Couldn't load image|Loading image…/ });
    await expect(statuses).toHaveCount(1);

    const retry = stage.getByRole("button", { name: "Retry image" });
    requests.hold();
    const attempts = requests.count;
    await retry.focus();
    await page.keyboard.press("Enter");
    // The hidden row loads with the viewer, so only the viewer's count is known.
    await expect.poll(() => requests.count).toBeGreaterThan(attempts);
    await expect(statuses).toHaveText("Loading image…");
    await expect(retry).toHaveAttribute("aria-busy", "true");
    await expect(retry).toBeFocused();
    const bounds = await box(stage);
    const button = await box(retry);
    const toolbar = await box(stage.locator("[data-image-controls]"));
    expect(button.y).toBeGreaterThanOrEqual(bounds.y);
    expect(button.x).toBeGreaterThanOrEqual(bounds.x);
    expect(button.x + button.width).toBeLessThanOrEqual(
      bounds.x + bounds.width,
    );
    expect(button.y + button.height).toBeLessThanOrEqual(toolbar.y);

    requests.answer("fail");
    await expect(stage.getByRole("status")).toHaveText("Couldn't load image");
    await expect(retry).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(
      page
        .locator("[data-image-failed]")
        .getByRole("button", { name: "Retry image" }),
    ).toBeFocused();
  } finally {
    requests.answer("fail");
  }
});

// jsdom and getByRole derive roles from ARIA in HTML, but Chromium also exposes
// an anchor with a click listener as a link without href.
test("a failed frame is no link around its Retry in Chromium's accessibility tree", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "Reads Chromium's tree over CDP.");
  const requests = await photoRequests(page);
  try {
    await page.goto("/tests/fixtures/media-review.html?image-failure");
    await expect.poll(requests.pending).toBe(1);
    const client = await page.context().newCDPSession(page);
    // The exposed roles above a node, or null until it is exposed. A link
    // takes its name from its content, so it can share its button's name.
    const ancestors = async (role, name) => {
      const { nodes } = await client.send("Accessibility.getFullAXTree");
      const byId = new Map(nodes.map((node) => [node.nodeId, node]));
      const node = nodes.find(
        (candidate) =>
          !candidate.ignored &&
          candidate.role?.value === role &&
          candidate.name?.value === name,
      );
      if (!node) return null;
      const roles = [];
      for (
        let parent = byId.get(node.parentId);
        parent;
        parent = byId.get(parent.parentId)
      )
        if (!parent.ignored) roles.push(parent.role?.value);
      return roles;
    };
    await expect
      .poll(() => ancestors("link", "Open image attachment"))
      .not.toBeNull();

    requests.answer("fail");
    await expect
      .poll(async () =>
        (await ancestors("button", "Retry image"))?.includes("link"),
      )
      .toBe(false);
    expect(await ancestors("link", "Retry image")).toBeNull();

    requests.hold();
    await page.getByRole("button", { name: "Retry image" }).focus();
    await page.keyboard.press("Enter");
    await expect.poll(requests.pending).toBe(1);
    requests.answer("load");
    await expect(
      page.getByRole("link", { name: "Open image attachment" }),
    ).toHaveAttribute("data-image-ready");
    await expect
      .poll(() => ancestors("link", "Open image attachment"))
      .not.toBeNull();
  } finally {
    requests.answer("fail");
  }
});
