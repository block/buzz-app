import { test as base, expect } from "./playwright-test.mjs";
import { createServer } from "./vite-server.mjs";

const test = base.extend({
  soundUrl: [
    async ({ browserName }, use) => {
      if (!["chromium", "webkit"].includes(browserName))
        throw new Error("Unsupported engine");
      const server = await createServer({
        configFile: false,
        envDir: false,
        logLevel: "error",
        server: { host: "127.0.0.1", port: 0 },
        plugins: [
          {
            name: "notification-sound-fixture",
            configureServer(server) {
              server.middlewares.use("/sound-fixture", (_req, res) => {
                res.setHeader("Content-Type", "text/html");
                res.end(
                  "<!doctype html><title>Notification sound storage</title>",
                );
              });
            },
          },
        ],
      });
      await server.listen();
      try {
        await use(`${server.resolvedUrls.local[0]}sound-fixture`);
      } finally {
        await server.close();
      }
    },
    { scope: "worker" },
  ],
});
async function open(page, url) {
  await page.goto(url);
  await page.evaluate(async () => {
    const { createNotificationPreferences } = await import(
      "/src/features/notifications/preferences.ts"
    );
    window.soundPreferences = createNotificationPreferences();
    window.soundPreferences.selectViewer("a".repeat(64));
  });
}
const quietChats = (page) =>
  page.evaluate(() =>
    window.soundPreferences
      .snapshot()
      .preferences.quietConversations.map((e) => e.channelId)
      .sort(),
  );

// Actual localStorage storage-event delivery and persistence across separate
// renderer windows require browsers; the ordering matrix stays in Vitest.
test("independent chat sound choices propagate across windows and survive reopening", async ({
  page,
  context,
  soundUrl,
}) => {
  await open(page, soundUrl);
  const other = await context.newPage();
  await open(other, soundUrl);
  const silence = (page, channelId) =>
    page.evaluate(
      (channelId) =>
        window.soundPreferences.setConversationSound(
          { communityOrigin: "https://community.test", channelId },
          "silent",
        ),
      channelId,
    );
  await Promise.all([silence(page, "chat-a"), silence(other, "chat-b")]);
  await expect.poll(() => quietChats(page)).toEqual(["chat-a", "chat-b"]);
  await expect.poll(() => quietChats(other)).toEqual(["chat-a", "chat-b"]);
  await other.evaluate(() => window.soundPreferences.update({ sound: false }));
  await expect
    .poll(() =>
      page.evaluate(() => window.soundPreferences.snapshot().preferences.sound),
    )
    .toBe(false);
  await page.evaluate(() =>
    window.soundPreferences.setConversationSound(
      { communityOrigin: "https://community.test", channelId: "chat-a" },
      "default",
    ),
  );
  await expect.poll(() => quietChats(other)).toEqual(["chat-b"]);
  await open(other, soundUrl);
  expect(await quietChats(other)).toEqual(["chat-b"]);
});
