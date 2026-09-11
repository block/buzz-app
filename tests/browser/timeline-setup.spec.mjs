import { test, expect } from "./fixture.mjs";
import { open, upper, expectAnchor } from "./timeline.mjs";

// Reading setup must not accidentally exercise older-page loading.
test.use({ tallMessages: true });
const history = (page) =>
  page.getByRole("region", { name: "Channel message history" });

test("reading setup handles partial wheel progress without weakening the anchor", async ({
  page,
  app,
}) => {
  await open(page, app);
  const wheel = page.mouse.wheel.bind(page.mouse);
  let upwardGestures = 0;
  // Model partial input deterministically; every delivered gesture is still
  // real browser input through the production handlers, never a scrollTop write.
  page.mouse.wheel = (x, y) => {
    if (y < 0) upwardGestures++;
    return wheel(x, Math.max(-300, y));
  };
  try {
    const saved = await upper(page);
    expect(upwardGestures).toBeGreaterThan(1);
    expect(upwardGestures).toBeLessThanOrEqual(4);
    await expectAnchor(page, saved);
    expect(
      await history(page).evaluate(
        (el) => el.scrollTop - Math.max(3000, el.clientHeight * 4),
      ),
    ).toBeGreaterThan(0);
    expect(app.pending).toHaveLength(0);
  } finally {
    page.mouse.wheel = wheel;
  }
});

test("reading setup rejects an immobile timeline instead of accepting a bottom anchor", async ({
  page,
  app,
}) => {
  await open(page, app);
  await history(page).evaluate((element) => {
    element.addEventListener("wheel", (event) => event.preventDefault(), {
      passive: false,
    });
  });
  await expect(upper(page)).rejects.toThrow(
    "reading gesture moves away from bottom",
  );
});
