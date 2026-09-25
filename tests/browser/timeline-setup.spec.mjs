import { test, expect } from "./fixture.mjs";
import {
  open,
  upper,
  anchor,
  expectAnchor,
  settle,
  wheelToCompletion,
} from "./timeline.mjs";

// Reading setup must not accidentally exercise older-page loading.
test.use({
  tallMessages: true,
  historyCounts: { alpha: 640, beta: 1 },
});
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

test("reading anchor handles clipped paragraphs and still detects displacement", async ({
  page,
}) => {
  // Deterministic geometry from the CI failure: both visible paragraphs are
  // clipped, with no whole paragraph to select. This is a helper control, not
  // a replacement for the production resize journeys.
  await page.setContent(`
    <section role="region" aria-label="Channel message history"
      style="position:fixed;top:100px;height:200px;width:400px;overflow:hidden">
      <div data-message-id="above" style="position:absolute;top:-100px">
        <p style="margin:0;height:50px">Offscreen</p>
      </div>
      <div data-message-id="clipped" style="position:absolute;top:-30px">
        <p style="margin:0;height:150px">Clipped at top</p>
      </div>
      <div data-message-id="next" style="position:absolute;top:130px">
        <p style="margin:0;height:150px">Clipped at bottom</p>
      </div>
    </section>
  `);
  const saved = await anchor(page);
  expect(saved).toEqual({ id: "clipped", y: -30 });
  await expectAnchor(page, saved);
  await page.locator('[data-message-id="clipped"]').evaluate((row) => {
    row.style.top = "-10px";
  });
  expect(await anchor(page)).toEqual({ id: saved.id, y: saved.y + 20 });
  // The unchanged oracle must reject a real jump, not merely find the same ID.
  await expect(expectAnchor(page, saved)).rejects.toThrow(
    "same visible message clipped at same viewport Y",
  );
  await page.locator('[data-message-id="next"] p').evaluate((p) => {
    p.style.height = "40px";
  });
  expect(await anchor(page)).toEqual({ id: "next", y: 130 });
  await history(page)
    .locator("[data-message-id]")
    .evaluateAll((rows) => {
      for (const row of rows) row.style.top = "300px";
    });
  await expect(anchor(page)).rejects.toThrow("No visible message anchor");
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

test("reading setup drains a timed-out DOM read before returning its rejection", async ({
  page,
  app,
}) => {
  await open(page, app);
  await history(page).evaluate((element) => {
    element.addEventListener("wheel", (event) => event.preventDefault(), {
      passive: false,
    });
  });
  const wheel = page.mouse.wheel.bind(page.mouse);
  const getByRole = page.getByRole.bind(page);
  const poll = expect.poll;
  const readStarted = Promise.withResolvers();
  const releaseRead = Promise.withResolvers();
  const pollEnded = Promise.withResolvers();
  let holdNextRead = false;
  let readFinished = false;
  let returned = false;
  page.mouse.wheel = async (x, y) => {
    await wheel(x, y);
    if (y < 0) holdNextRead = true;
  };
  page.getByRole = (...args) => {
    const locator = getByRole(...args);
    if (args[0] === "region" && args[1]?.name === "Channel message history") {
      const evaluate = locator.evaluate.bind(locator);
      locator.evaluate = async (...evaluateArgs) => {
        if (holdNextRead) {
          holdNextRead = false;
          readStarted.resolve();
          await releaseRead.promise;
        }
        const result = await evaluate(...evaluateArgs);
        readFinished = true;
        return result;
      };
    }
    return locator;
  };
  expect.poll = (callback, options) => {
    if (options?.message !== "reading gesture moves away from bottom") {
      return poll(callback, options);
    }
    const matcher = poll(callback, { ...options, timeout: 100 });
    return {
      toBeGreaterThan: async (before) => {
        try {
          return await matcher.toBeGreaterThan(before);
        } finally {
          pollEnded.resolve();
        }
      },
    };
  };
  const outcome = upper(page).then(
    () => {
      returned = true;
      return undefined;
    },
    (error) => {
      returned = true;
      return error;
    },
  );
  try {
    await readStarted.promise;
    readFinished = false;
    await pollEnded.promise;
    // Let rejection continuations run, with the DOM operation still held.
    await new Promise((resolve) => setImmediate(resolve));
    expect(
      returned,
      "helper must not return while its DOM read is pending",
    ).toBe(false);
    releaseRead.resolve();
    const result = await outcome;
    expect(readFinished).toBe(true);
    expect(result?.message).toContain("reading gesture moves away from bottom");
  } finally {
    releaseRead.resolve();
    await outcome;
    expect.poll = poll;
    page.getByRole = getByRole;
    page.mouse.wheel = wheel;
  }
});

test("wheel completion waits through stable geometry and a held input tail", async ({
  page,
}) => {
  // Real browser scrolling, without an app build. Hold completion delivery so
  // stable geometry cannot accidentally stand in for the wheel lifecycle.
  await page.setContent(`
    <section role="region" aria-label="Channel message history"
      style="height:200px;width:400px;overflow:auto">
      <div data-message-id="reading"><p style="margin:0;height:1600px">Reading</p></div>
    </section>
  `);
  await expect(wheelToCompletion(page, -17)).rejects.toThrow(
    "wheel completion requires room to scroll",
  );
  await history(page).evaluate((element) => {
    window.heldScrollEnds = 0;
    element.addEventListener(
      "scrollend",
      (event) => {
        if (event.isTrusted) {
          event.stopImmediatePropagation();
          window.heldScrollEnds++;
        }
      },
      { capture: true },
    );
  });
  let finished = false;
  const outcome = wheelToCompletion(page, 633).then(
    () => {
      finished = true;
    },
    (error) => {
      finished = true;
      return error;
    },
  );
  try {
    await page.waitForFunction(() => window.heldScrollEnds === 1);
    await settle(page);
    const paused = await anchor(page);
    expect(finished, "stable geometry is not wheel completion").toBe(false);
    // Deliver the remaining movement only after the old geometry poll passed.
    await page.mouse.wheel(0, 17);
    await page.waitForFunction(() => window.heldScrollEnds === 2);
    await settle(page);
    expect(finished, "the completion event is still held").toBe(false);
    await history(page).dispatchEvent("scrollend");
    expect(await outcome).toBeUndefined();
    const completed = await anchor(page);
    expect(completed.id).toBe(paused.id);
    expect(paused.y - completed.y).toBeGreaterThan(4);
    await expectAnchor(page, completed);
  } finally {
    await history(page).dispatchEvent("scrollend");
    await outcome;
  }
});
