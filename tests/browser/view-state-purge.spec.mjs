import { fileURLToPath } from "node:url";
import { test as base, expect } from "./playwright-test.mjs";
import { createServer } from "./vite-server.mjs";

const test = base.extend({
  purgeUrl: [
    async ({ browserName }, use) => {
      if (!["chromium", "webkit"].includes(browserName))
        throw new Error("Unsupported purge test engine");
      const server = await createServer({
        root: fileURLToPath(new URL("../../", import.meta.url)),
        configFile: false,
        envDir: false,
        logLevel: "error",
        server: { host: "127.0.0.1", port: 0 },
      });
      await server.listen();
      try {
        await use(
          `${server.resolvedUrls.local[0]}tests/fixtures/view-state-purge.html`,
        );
      } finally {
        await server.close();
      }
    },
    { scope: "worker" },
  ],
});

async function open(page, url) {
  await page.goto(url);
  await page.waitForFunction(() => !!window.purgeTest);
}

const draft = {
  expected: null,
  question: "Keep this edit",
  nextActor: "Morgan",
  decision: "",
  stage: "decision",
};

// Browser-only boundary: real BroadcastChannel delivery between two windows
// while device storage rejects writes.
test("explicit scope purge clears memory drafts across windows and in the same window", async ({
  page,
  context,
  purgeUrl,
}) => {
  const scope = "https://one.test:viewer";
  const otherScope = "https://two.test:viewer";
  const key = JSON.stringify([scope, "capture", "room", "a".repeat(64)]);
  const otherKey = JSON.stringify([
    otherScope,
    "capture",
    "room",
    "b".repeat(64),
  ]);
  await open(page, purgeUrl);
  const peer = await context.newPage();
  try {
    await open(peer, purgeUrl);
    expect(await page.evaluate(() => !!window.BroadcastChannel)).toBe(true);
    const kept = await page.evaluate(
      ({ scope, key, otherScope, otherKey, draft }) => {
        Storage.prototype.setItem = () => {
          throw new Error("device storage rejected the write");
        };
        return [
          window.purgeTest.keepDraft(scope, key, draft),
          window.purgeTest.keepDraft(otherScope, otherKey, draft),
        ];
      },
      { scope, key, otherScope, otherKey, draft },
    );
    expect(kept).toEqual([true, true]);
    await peer.evaluate((scope) => {
      window.purgeTest.writeView(scope, "unrelated-view", true);
    }, scope);
    expect(
      await page.evaluate((key) => !!window.purgeTest.draftFor(key), key),
    ).toBe(true);

    await peer.evaluate(
      (scope) => window.purgeTest.clearViewScope(scope),
      scope,
    );
    await expect
      .poll(() => page.evaluate((key) => !!window.purgeTest.draftFor(key), key))
      .toBe(false);
    expect(
      await page.evaluate((key) => !!window.purgeTest.draftFor(key), otherKey),
    ).toBe(true);

    await peer.evaluate(() => {
      Storage.prototype.setItem = () => {
        throw new Error("device storage rejected the marker");
      };
    });
    await page.evaluate(
      ({ scope, key, draft }) => {
        window.purgeTest.keepDraft(scope, key, draft);
      },
      { scope, key, draft },
    );
    await expect(
      peer.evaluate((scope) => window.purgeTest.clearViewScope(scope), scope),
    ).rejects.toThrow("device storage rejected the marker");
    await expect
      .poll(() => page.evaluate((key) => !!window.purgeTest.draftFor(key), key))
      .toBe(false);

    await page.evaluate(
      ({ scope, key, draft }) => {
        window.purgeTest.keepDraft(scope, key, draft);
      },
      { scope, key, draft },
    );
    await expect(
      page.evaluate((scope) => window.purgeTest.clearViewScope(scope), scope),
    ).rejects.toThrow("device storage rejected the write");
    expect(
      await page.evaluate((key) => !!window.purgeTest.draftFor(key), key),
    ).toBe(false);
  } finally {
    await peer.close();
  }
});
