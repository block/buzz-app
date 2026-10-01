import { test, expect, chromium } from "@playwright/test";
import { createServer } from "./vite-server.mjs";
import { fileURLToPath } from "node:url";

let server, origin;
test.beforeAll(async () => {
  server = await createServer({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
});
test.afterAll(async () => {
  await server?.close();
});

test("connected Huddles keep compact controls beside the default window", async ({
  page,
}) => {
  await page.goto(`${origin}/tests/fixtures/huddles.html?deferConnection`);
  const header = page.getByRole("region", {
    name: "Conversation",
    exact: true,
  });
  await header.getByRole("button", { name: "Start or join a huddle" }).click();
  await expect
    .poll(() => page.evaluate(() => window.huddleFixture.stats.opens))
    .toBe(1);
  await expect(
    page.getByRole("group", { name: "Active Huddle", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("complementary", { name: "Huddle window preview" }),
  ).toHaveCount(0);
  await expect(page.getByText(/Connecting…|Opening Huddle…/)).toHaveCount(0);
  await page.evaluate(() => window.huddleFixture.connect());
  const companion = page.getByRole("complementary", {
    name: "Huddle window preview",
  });
  await expect(
    companion.getByRole("img", { name: "Alex", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("group", { name: "Active Huddle", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close Huddle window" }).click();
  const capsule = page.getByRole("group", {
    name: "Active Huddle",
    exact: true,
  });
  await expect(capsule).toBeVisible();
  const launcher = header.getByRole("button", {
    name: "Leave huddle",
    exact: true,
  });
  await expect(launcher).toHaveAttribute("data-icon-variant", "ghost");
  await expect(launcher).not.toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("region", { name: "Huddles", exact: true }),
  ).toHaveCount(0);
  const capsuleHeight = await capsule.evaluate(
    (el) => el.getBoundingClientRect().height,
  );
  const searchHeight = await page
    .getByRole("button", { name: "Search Buzz" })
    .evaluate((el) => el.getBoundingClientRect().height);
  expect(capsuleHeight).toBe(searchHeight);
  expect(capsuleHeight).toBe(28);
  const material = (el) => {
    const style = getComputedStyle(el);
    return [style.backgroundColor, style.backdropFilter, style.boxShadow];
  };
  // The container reuses the shell material.
  await page.mouse.move(0, 0);
  expect(await capsule.evaluate(material)).toEqual(
    await page.getByRole("button", { name: "Search Buzz" }).evaluate(material),
  );
  for (const name of ["Search Buzz", "Mute"]) {
    expect(
      await (name === "Search Buzz" ? page : capsule)
        .getByRole("button", { name, exact: true })
        .locator("svg")
        .evaluate((el) => {
          const box = el.getBoundingClientRect();
          return [box.width, box.height];
        }),
    ).toEqual([16, 16]);
  }

  for (const name of ["Go back", "Go forward", "Your profile"]) {
    expect(
      await page
        .getByRole("button", { name, exact: true })
        .evaluate((el) => el.getBoundingClientRect().height),
    ).toBe(capsuleHeight);
  }
  for (const control of await capsule.getByRole("button").all()) {
    expect(
      await control.evaluate((el) => el.getBoundingClientRect().height),
    ).toBe(28);
  }
  const geometry = await capsule.evaluate((el) => {
    const first = el.querySelector("button");
    const last = el.querySelector("button:last-child");
    const box = el.getBoundingClientRect();
    const padding = getComputedStyle(first);
    return {
      left: first.getBoundingClientRect().left - box.left,
      right: box.right - last.getBoundingClientRect().right,
      gaps: [...el.children]
        .slice(1)
        .map(
          (button) =>
            button.getBoundingClientRect().left -
            button.previousElementSibling.getBoundingClientRect().right,
        ),
      inset: [
        padding.paddingTop,
        padding.paddingRight,
        padding.paddingBottom,
        padding.paddingLeft,
      ],
    };
  });
  expect(geometry).toEqual({
    left: 0,
    right: 0,
    inset: ["4px", "4px", "4px", "8px"],
    gaps: [4, 4, 4],
  });
  const leaveButton = capsule.getByRole("button", {
    name: "Leave huddle",
    exact: true,
  });
  await expect(leaveButton.locator("svg")).toHaveCount(0);
  await expect(leaveButton).toHaveAttribute("data-variant", "destructive");
  await capsule.getByRole("button", { name: "Mute", exact: true }).click();
  await expect(
    capsule.getByRole("button", { name: "Unmute", exact: true }),
  ).toHaveAttribute("data-icon-variant", "ghost");
  await expect(capsule.getByRole("button")).toHaveCount(3);
  await expect(
    capsule.getByRole("button", { name: "Microphone options" }),
  ).toHaveCount(0);
  await expect(
    capsule.getByRole("button", { name: "Leave huddle", exact: true }),
  ).toHaveText("Leave");
  await capsule.getByRole("button", { name: "Unmute", exact: true }).click();
  await expect(
    capsule.getByRole("button", { name: "Mute", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "Switch conversation" }).click();
  await expect(capsule).toBeVisible();
  expect(await page.evaluate(() => window.huddleFixture.stats.closes)).toBe(0);
  await header.getByRole("button", { name: "Show active Huddle" }).click();
  await expect(capsule).toBeFocused();
  await capsule
    .getByRole("button", { name: "Leave huddle", exact: true })
    .click();
  await expect(capsule).toHaveCount(0);
  expect(
    await page.evaluate(() => window.huddleFixture.stats.audioClosed),
  ).toBe(1);
  await header.getByRole("button", { name: "Start or join a huddle" }).click();
  await page.evaluate(() => window.huddleFixture.disconnect());
  await expect(page.getByRole("alert")).toContainText("Huddle disconnected");
  await header.getByRole("button", { name: "Start or join a huddle" }).click();
  await expect
    .poll(() => page.evaluate(() => window.huddleFixture.stats.opens))
    .toBe(3);
  await page.evaluate(() =>
    window.huddleFixture.disconnect(
      "huddle audio unavailable in this deployment",
    ),
  );
  await expect(page.getByRole("alert")).toContainText(
    "A relay administrator needs to check its configuration.",
  );
  await expect(page.getByRole("alert")).not.toContainText(
    "Try the headphone button again",
  );
  await expect(
    page.getByRole("group", { name: "Huddle error", exact: true }),
  ).toContainText("Huddle audio unavailable");
});

test("real capture emits 20ms frames and stops on mute and plugin disposal", async ({
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "Chromium supplies a deterministic synthetic microphone",
  );
  const browser = await chromium.launch({
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  });
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      const capture = navigator.mediaDevices.getUserMedia.bind(
        navigator.mediaDevices,
      );
      navigator.mediaDevices.getUserMedia = async (...args) => {
        const stream = await capture(...args);
        window.captureTracks = stream.getAudioTracks();
        return stream;
      };
    });
    await page.goto(`${origin}/tests/fixtures/huddles.html?audio`);
    await page
      .getByRole("button", { name: "Start or join a huddle", exact: true })
      .click();
    await expect
      .poll(() => page.evaluate(() => window.huddleFixture.stats.frames))
      .toBeGreaterThan(5);
    expect(
      await page.evaluate(() => window.huddleFixture.stats.lastFrameLength),
    ).toBe(960);
    const controls = page.getByRole("group", {
      name: "Active Huddle",
      exact: true,
    });
    await controls.getByRole("button", { name: "Mute", exact: true }).click();
    const before = await page.evaluate(() => window.huddleFixture.stats.frames);
    expect(
      await page.evaluate(() =>
        window.captureTracks.every((track) => !track.enabled),
      ),
    ).toBe(true);
    expect(await page.evaluate(() => window.huddleFixture.stats.frames)).toBe(
      before,
    );
    await controls.getByRole("button", { name: "Unmute", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => window.huddleFixture.stats.frames))
      .toBeGreaterThan(before);
    await page.evaluate(() => window.huddleFixture.dispose());
    const stopped = await page.evaluate(
      () => window.huddleFixture.stats.frames,
    );
    expect(
      await page.evaluate(() =>
        window.captureTracks.every((track) => track.readyState === "ended"),
      ),
    ).toBe(true);
    expect(await page.evaluate(() => window.huddleFixture.stats.frames)).toBe(
      stopped,
    );
    expect(
      await page.evaluate(() => window.huddleFixture.stats.audioClosed),
    ).toBe(1);
  } finally {
    await browser.close();
  }
});

// Browser-only geometry and shared controls; native window IPC is covered separately.
test("capsule and companion presentation share mute and leave", async ({
  page,
}) => {
  await page.goto(`${origin}/tests/fixtures/huddles.html?chrome`);
  const panel = page.getByRole("region", { name: "Conversation", exact: true });
  await panel
    .getByRole("button", { name: "Start or join a huddle", exact: true })
    .click();
  const capsule = page.getByRole("group", {
    name: "Active Huddle",
    exact: true,
  });
  await expect(capsule).toBeVisible();
  const companion = page.getByRole("complementary", {
    name: "Huddle window preview",
  });
  await expect(companion.getByText("Huddle", { exact: true })).toBeVisible();
  // Avatar positioning, entry motion, and containment require a rendering engine.
  const roster = companion.getByRole("region", { name: "Huddle participants" });
  const expectNamesClear = async () => {
    await expect
      .poll(() =>
        roster.evaluate((el) => {
          const boxes = [
            ...el.querySelectorAll("[data-self], [data-participant]"),
          ].map((person) => ({
            avatar: person.getBoundingClientRect(),
            name: person.querySelector("[data-name]").getBoundingClientRect(),
            shown: person.dataset.nameActive === "true",
          }));
          const overlaps = (a, b) =>
            a.left < b.right &&
            a.right > b.left &&
            a.top < b.bottom &&
            a.bottom > b.top;
          const touchesAvatar = (name, avatar) => {
            const x = avatar.left + avatar.width / 2;
            const y = avatar.top + avatar.height / 2;
            const dx = x - Math.max(name.left, Math.min(name.right, x));
            const dy = y - Math.max(name.top, Math.min(name.bottom, y));
            return Math.hypot(dx, dy) < avatar.width / 2;
          };
          return boxes
            .flatMap((a, i) =>
              boxes.flatMap((b, j) =>
                i === j || !a.shown
                  ? []
                  : [
                      touchesAvatar(a.name, b.avatar),
                      b.shown && overlaps(a.name, b.name),
                    ],
              ),
            )
            .filter(Boolean).length;
        }),
      )
      .toBe(0);
  };

  const keys = ["ab", "cd", "de", "ef", "fa", "bc"].map((key) =>
    key.repeat(32),
  );
  for (const count of [1, 2, 6]) {
    await page.evaluate(
      (keys) => window.huddleFixture.participants(keys),
      keys.slice(0, count),
    );
    await expect(roster.locator("[data-participant]")).toHaveCount(count - 1);
    await roster.evaluate(async (el) => {
      await Promise.all(
        el
          .getAnimations({ subtree: true })
          .map((animation) => animation.finished),
      );
    });
    const geometry = await roster.evaluate((el) => {
      const area = el.getBoundingClientRect();
      const bounds = (node) => {
        const rect = node.getBoundingClientRect();
        return {
          left: rect.left - area.left,
          top: rect.top - area.top,
          right: rect.right - area.left,
          bottom: rect.bottom - area.top,
          center: rect.left + rect.width / 2 - area.left,
        };
      };
      return {
        width: area.width,
        height: area.height,
        self: bounds(el.querySelector("[data-self]")),
        portraitGaps: [
          ...el.querySelectorAll("[data-self], [data-participant]"),
        ].map((person) =>
          Math.abs(
            person.getBoundingClientRect().height -
              person.querySelector("[role=img]").getBoundingClientRect().height,
          ),
        ),
        peers: [...el.querySelectorAll("[data-participant]")].map(bounds),
      };
    });
    expect(geometry.self.center).toBeCloseTo(
      geometry.width * (count === 1 ? 0.5 : 0.17),
      0,
    );
    expect(geometry.portraitGaps.every((gap) => gap < 0.1)).toBe(true);
    await expectNamesClear();
    for (const bubble of [geometry.self, ...geometry.peers]) {
      expect(bubble.left).toBeGreaterThanOrEqual(0);
      expect(bubble.top).toBeGreaterThanOrEqual(0);
      expect(bubble.right).toBeLessThanOrEqual(geometry.width);
      expect(bubble.bottom).toBeLessThanOrEqual(geometry.height);
    }
  }
  await expect(
    roster.getByRole("img", { name: "Alex", exact: true }).locator("img"),
  ).toHaveAttribute("data-loaded", "true");
  await expect(roster.locator('[data-name-active="true"]')).toHaveCount(0);
  const alex = roster.locator(`[data-participant="${keys[1]}"]`);
  const jo = roster.locator(`[data-participant="${keys[3]}"]`);
  const original = await alex.boundingBox();
  const neighbor = await jo.boundingBox();
  await alex.hover();
  await expect(alex.locator("[data-name]")).toHaveCSS("opacity", "1");
  await expect(roster.locator('[data-name-active="true"]')).toHaveCount(1);
  await expectNamesClear();
  await expect
    .poll(async () => (await jo.boundingBox()).y)
    .toBeGreaterThan(neighbor.y);
  expect((await alex.boundingBox()).y).toBeCloseTo(original.y, 0);
  await page.mouse.move(0, 0);
  await expect(alex.locator("[data-name]")).toHaveCSS("opacity", "0");
  await jo.focus();
  await expect(jo.locator("[data-name]")).toHaveCSS("opacity", "1");
  await expectNamesClear();
  await page.keyboard.press("Escape");
  await expect(jo.locator("[data-name]")).toHaveCSS("opacity", "0");

  await roster.evaluate((el) => {
    el.addEventListener("transitionrun", (event) => {
      if (event.propertyName === "opacity")
        el.setAttribute("data-arrival-motion", "true");
    });
  });
  const largeRoster = [
    ...keys,
    ...["01", "02", "03", "04", "05", "06"].map((key) => key.repeat(32)),
  ];
  await page.evaluate(
    (keys) => window.huddleFixture.participants(keys),
    largeRoster,
  );
  await expect(roster.locator("[data-participant]")).toHaveCount(10);
  await expect(
    roster.getByRole("img", { name: /^1 more participants:/ }),
  ).toBeVisible();
  await page.evaluate(() => window.huddleFixture.speak("cd".repeat(32)));
  const speaker = roster.locator(`[data-participant="${"cd".repeat(32)}"]`);
  const speakerHalo = roster.locator(`[data-speaker="${"cd".repeat(32)}"]`);
  await expect(speakerHalo).toHaveAttribute("data-speaking", "true");
  await expect(roster.locator('[data-speaking="true"]')).toHaveCount(1);
  await expect(
    speaker.getByRole("img", { name: "Alex, speaking", exact: true }),
  ).toBeVisible();
  await expect(speakerHalo).toHaveAttribute("data-speaking", "false");
  await expect(roster).toHaveAttribute("data-arrival-motion", "true");
  await expectNamesClear();
  await companion.evaluate((el) => {
    el.style.width = "360px";
    el.style.height = "400px";
  });
  await expectNamesClear();
  for (const person of await roster.locator("[data-participant]").all()) {
    await person.hover();
    await expect(person.locator("[data-name]")).toHaveCSS("opacity", "1");
    await expectNamesClear();
    await page.mouse.move(0, 0);
  }

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(() => window.huddleFixture.speak("cd".repeat(32)));
  await expect(speakerHalo).toHaveCSS(
    "transform",
    "matrix(1.15, 0, 0, 1.15, 0, 0)",
  );
  await page.evaluate(
    (keys) => window.huddleFixture.participants(keys),
    keys.slice(0, 1),
  );
  await expect(roster.locator("[data-participant]")).toHaveCount(0);
  await page.evaluate((keys) => window.huddleFixture.participants(keys), keys);
  await expect(roster.locator("[data-participant]")).toHaveCount(5);
  expect(
    await roster.evaluate((el) => el.getAnimations({ subtree: true }).length),
  ).toBe(0);
  await companion.getByRole("button", { name: "Mute", exact: true }).click();
  await expect(
    capsule.getByRole("button", { name: "Unmute", exact: true }),
  ).toBeVisible();
  await companion
    .getByRole("button", { name: "Minimize Huddle to compact controls" })
    .click();
  await expect(companion).toHaveCount(0);
  expect(
    await page.evaluate(() => window.huddleFixture.stats.audioClosed),
  ).toBe(0);
  await capsule
    .getByRole("button", { name: "Open Huddle window for Design" })
    .click();
  await expect(capsule).toBeVisible();
  await expect(
    companion.getByRole("button", { name: "Unmute", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close Huddle window" }).click();
  await expect(
    capsule.getByRole("button", { name: "Unmute", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Switch conversation" }).click();
  await expect(capsule).toBeVisible();
  await page.setViewportSize({ width: 480, height: 800 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await capsule
    .getByRole("button", { name: "Leave huddle", exact: true })
    .click();
  await expect(capsule).toHaveCount(0);
  await expect(companion).toHaveCount(0);
  expect(
    await page.evaluate(() => window.huddleFixture.stats.audioClosed),
  ).toBe(1);
});

// Real CSS transitions, overlap, and shell geometry need a rendering engine.
test("live participant avatars enter on top and reflow without growing the shell", async ({
  page,
}) => {
  await page.goto(`${origin}/tests/fixtures/huddles.html?chrome`);
  await page.getByRole("button", { name: "Start or join a huddle" }).click();
  await page.getByRole("button", { name: "Close Huddle window" }).click();
  const capsule = page.getByRole("group", {
    name: "Active Huddle",
    exact: true,
  });
  const stack = capsule.getByRole("img", {
    name: "In this Huddle: Kenneth, Alex",
  });
  await expect(stack).toBeVisible();
  expect(
    await stack.evaluate(
      (el) =>
        el.getBoundingClientRect().left -
        el.previousElementSibling.getBoundingClientRect().right,
    ),
  ).toBe(8);
  await expect(capsule.getByText("Design", { exact: true })).toHaveCount(0);
  await expect(stack.locator("img")).toHaveAttribute("data-loaded", "true");
  await stack.evaluate((el) => {
    el.addEventListener("transitionrun", (event) => {
      if (event.propertyName === "transform")
        el.setAttribute("data-arrival-motion", "true");
    });
  });
  await page.getByRole("button", { name: "Simulate someone joining" }).click();
  const updated = capsule.getByRole("img", {
    name: "In this Huddle: Kenneth, Alex, Sam",
  });
  await expect(updated).toHaveAttribute("data-arrival-motion", "true");
  const avatars = updated.locator("[data-participant]");
  await expect(avatars).toHaveCount(3);
  // Wait for the actual transition lifecycle, not an arbitrary sleep.
  await updated.evaluate((el) =>
    Promise.all(
      el
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished),
    ),
  );
  const positions = await avatars.evaluateAll((elements) =>
    elements.map((el) => ({
      left: el.getBoundingClientRect().left,
      right: el.getBoundingClientRect().right,
      z: Number(getComputedStyle(el).zIndex),
      opacity: getComputedStyle(el).opacity,
    })),
  );
  expect(positions[2].left).toBeLessThan(positions[1].right);
  expect(positions[2].z).toBeGreaterThan(positions[1].z);
  expect(positions[2].opacity).toBe("1");
  for (let i = 0; i < 3; i++)
    await page
      .getByRole("button", { name: "Simulate someone joining" })
      .click();
  const overflow = capsule.locator("[data-avatar-overflow]");
  await expect(overflow).toHaveText("+2");
  await expect(overflow).toBeVisible();
  expect(
    await overflow.evaluate((el) => {
      const avatar = el.previousElementSibling;
      return {
        rightmost:
          el.getBoundingClientRect().right ===
          el.parentElement.getBoundingClientRect().right,
        inFront:
          Number(getComputedStyle(el).zIndex) >
          Number(getComputedStyle(avatar).zIndex),
      };
    }),
  ).toEqual({ rightmost: true, inFront: true });
  const avatarStyle = (el) => {
    const style = getComputedStyle(el.querySelector(".buzz-avatar"));
    return [style.backgroundColor, style.color, style.borderRadius];
  };
  expect(await overflow.evaluate(avatarStyle)).toEqual(
    await capsule.locator("[data-participant]").last().evaluate(avatarStyle),
  );
  await expect(capsule.locator("[data-participant]")).toHaveCount(4);
  expect(
    await capsule.evaluate((el) => el.getBoundingClientRect().height),
  ).toBe(28);
  await page.getByRole("button", { name: "Simulate someone leaving" }).click();
  await expect(capsule.getByText("+1", { exact: true })).toBeVisible();
  await expect(
    capsule.locator(`[data-participant="${"bc".repeat(32)}"]`),
  ).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Simulate someone joining" }).click();
  const newest = capsule.locator(`[data-participant="${"bc".repeat(32)}"]`);
  await expect(newest).toBeVisible();
  expect(
    await newest.evaluate((el) => getComputedStyle(el).transitionDuration),
  ).toBe("0s");
  await page.setViewportSize({ width: 480, height: 800 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

// Covers portal focus, split-control hit targets and channel-scoped presentation.
test("active chat has a split Huddle menu for members and a join-path link", async ({
  page,
}) => {
  await page.goto(`${origin}/tests/fixtures/huddles.html?chrome`);
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text) => {
          document.documentElement.dataset.copiedLink = text;
        },
      },
    });
  });
  await page.getByRole("button", { name: "Start or join a huddle" }).click();
  await page.getByRole("button", { name: "Close Huddle window" }).click();
  const active = page.getByRole("group", {
    name: "Active Huddle in this chat",
    exact: true,
  });
  await expect(active).toBeVisible();
  await active.getByRole("button", { name: "Huddle options" }).click();
  await page.getByRole("menuitem", { name: "Copy link", exact: true }).click();
  await expect(
    page.getByRole("menuitem", { name: "Link copied" }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.dataset.copiedLink),
  ).toBe("buzz://channel/00000000-0000-4000-8000-000000000001");
  await page.getByRole("menuitem", { name: "Add someone" }).click();
  await expect(
    page.getByRole("dialog", { name: "Channel members" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close channel members" }).click();
  await page.getByRole("button", { name: "Switch conversation" }).click();
  await expect(
    page.getByRole("heading", { name: "Alex", exact: true }),
  ).toBeVisible();
  await expect(active).toHaveCount(0);
  await expect(
    page.getByRole("group", { name: "Active Huddle", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Switch conversation" }).click();
  await active.getByRole("button", { name: "Huddle options" }).click();
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error("denied");
        },
      },
    }),
  );
  await page.getByRole("menuitem", { name: "Copy link", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Couldn’t copy");
  await page.keyboard.press("Escape");
  await expect(
    active.getByRole("button", { name: "Huddle options" }),
  ).toBeFocused();
  const leave = active.getByRole("button", {
    name: "Leave huddle",
    exact: true,
  });
  await page.mouse.move(0, 0);
  await expect(leave.locator("svg").first()).toHaveCSS("opacity", "1");
  await expect(leave.locator("svg").last()).toHaveCSS("opacity", "0");
  await leave.hover();
  await expect(leave.locator("svg").first()).toHaveCSS("opacity", "0");
  await expect(leave.locator("svg").last()).toHaveCSS("opacity", "1");
  await page.mouse.move(0, 0);
  await leave.focus();
  await expect(leave.locator("svg").last()).toHaveCSS("opacity", "1");
  await page.keyboard.press("Enter");
  await expect(active).toHaveCount(0);
  await expect(
    page.getByRole("group", { name: "Active Huddle", exact: true }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() => window.huddleFixture.stats.audioClosed),
  ).toBe(1);
  // A DM call receives the same control, while the shared picker preserves DM policy.
  await page.getByRole("button", { name: "Switch conversation" }).click();
  await page.getByRole("button", { name: "Start or join a huddle" }).click();
  await page.getByRole("button", { name: "Close Huddle window" }).click();
  await active.getByRole("button", { name: "Huddle options" }).click();
  await page.getByRole("menuitem", { name: "Add someone" }).click();
  await expect(
    page.getByText("DM membership cannot be changed here."),
  ).toBeVisible();
});

// Browser boundary: the separate presentation expands without crowding the call,
// retains its draft across tab switching, and shares the room with the saved panel.
test("Huddle chat expands beside the call and stays separate from Live transcript", async ({
  page,
}) => {
  await page.goto(`${origin}/tests/fixtures/huddles.html?chrome`);
  await page.getByRole("button", { name: "Join", exact: true }).click();
  const companion = page.getByRole("complementary", {
    name: "Huddle window preview",
    exact: true,
  });
  await companion
    .getByRole("button", { name: "Huddle chat", exact: true })
    .click();
  const panel = companion.getByRole("complementary", {
    name: "Huddle chat panel",
    exact: true,
  });
  await expect(
    panel.getByText("Let’s keep our notes here while we talk."),
  ).toBeVisible();
  const portrait = await panel.locator("img").boundingBox();
  expect(portrait.width).toBeLessThanOrEqual(32);
  const composer = panel.getByRole("textbox", { name: "Message this Huddle" });
  await composer.fill("Follow up after this call");
  await panel
    .getByRole("tab", { name: "Live transcript", exact: true })
    .click();
  await expect(
    panel.getByText(
      "Speech transcription isn’t connected in this version yet.",
    ),
  ).toBeVisible();
  await expect(composer).toHaveCount(0);
  await panel.getByRole("tab", { name: "Thread", exact: true }).click();
  await expect(composer).toHaveValue("Follow up after this call");
  await composer.press("Enter");
  await expect(
    panel.getByText("Follow up after this call", { exact: true }),
  ).toBeVisible();
  await expect(composer).toHaveValue("");
  const callBounds = await companion.getByRole("main").boundingBox();
  const panelBounds = await panel.boundingBox();
  expect(panelBounds.x).toBeGreaterThanOrEqual(
    callBounds.x + callBounds.width - 1,
  );
  const inputBounds = await composer.boundingBox();
  expect(inputBounds.y + inputBounds.height).toBeLessThanOrEqual(
    panelBounds.y + panelBounds.height,
  );
  await panel.getByRole("button", { name: "Close Huddle chat" }).click();
  await expect(panel).toHaveCount(0);
  await expect(companion).toBeVisible();
  await companion
    .getByRole("button", { name: "Leave huddle", exact: true })
    .click();
  await expect(companion).toHaveCount(0);
  await expect(page.getByText("Huddle ended", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "View", exact: true }).click();
  const saved = page.getByRole("complementary", {
    name: "Saved Huddle conversation",
  });
  await expect(
    saved.getByText("Follow up after this call", { exact: true }),
  ).toBeVisible();
  await expect(
    saved.getByText("This Huddle conversation is read-only."),
  ).toBeVisible();
});
