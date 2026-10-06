import { expect, it, vi } from "vitest";
import { createLocalSigningDelegate } from "./signing-delegate.mjs";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip44,
  verifyEvent,
} from "nostr-tools";
import {
  assertSidebarStarIntent,
  prepareSidebarStar,
  mutateSidebarStar,
} from "./sidebar-stars.mjs";
import {
  decodeSidebarPreferences,
  SIDEBAR_REQUEST_BYTES,
} from "./sidebar-preferences.mjs";

function harness() {
  const secret = generateSecretKey();
  const viewer = getPublicKey(secret);
  return {
    secret,
    signer: createLocalSigningDelegate(secret),
    viewer,
    encrypt(channels, overrides = {}) {
      const key = nip44.v2.utils.getConversationKey(secret, viewer);
      try {
        return finalizeEvent(
          {
            kind: 30078,
            created_at: 100,
            tags: [["d", "channel-stars"]],
            content: nip44.v2.encrypt(
              JSON.stringify({ version: 1, channels }),
              key,
            ),
            ...overrides,
          },
          secret,
        );
      } finally {
        key.fill(0);
      }
    },
  };
}
it("rejects invalid intent shapes before relay reads", async () => {
  const h = harness();
  for (const intent of [
    null,
    [],
    {},
    { channelId: "", starred: true },
    { channelId: "a" },
    { channelId: "a", starred: 1 },
    { channelId: "x".repeat(257), starred: true },
    { channelId: "a", starred: true, extra: 1 },
  ])
    expect(() => assertSidebarStarIntent(intent)).toThrow(
      "Invalid sidebar star intent",
    );
  const read = vi.fn();
  await expect(
    mutateSidebarStar({}, h.secret, h.signer, undefined, read, vi.fn()),
  ).rejects.toThrow("Invalid sidebar star intent");
  expect(read).not.toHaveBeenCalled();
});
it("encrypts explicit Star/Unstar with monotonic timestamps and preserves unrelated tombstones", async () => {
  const h = harness();
  const channels = {
    alpha: { starred: false, updatedAt: 60000 },
    beta: { starred: true, updatedAt: 2 },
    gone: { starred: false, updatedAt: 3 },
  };
  const added = await prepareSidebarStar(
    [h.encrypt(channels)],
    { channelId: "alpha", starred: true },
    h.secret,
    h.signer,
    undefined,
    50000,
  );
  expect(verifyEvent(added.event)).toBe(true);
  expect(added.event).toMatchObject({
    pubkey: h.viewer,
    kind: 30078,
    created_at: 101,
    tags: [
      ["d", "channel-stars"],
      ["t", "channel-stars"],
    ],
  });
  expect(added.event.content).not.toContain("alpha");
  expect(added.stars.channels).toEqual({
    ...channels,
    alpha: { starred: true, updatedAt: 60001 },
  });
  expect(decodeSidebarPreferences([added.event], h.secret).starred).toEqual([
    "alpha",
    "beta",
  ]);
  const removed = await prepareSidebarStar(
    [added.event],
    { channelId: "alpha", starred: false },
    h.secret,
    h.signer,
    undefined,
    50000,
  );
  expect(removed.stars.channels).toEqual({
    ...channels,
    alpha: { starred: false, updatedAt: 60002 },
  });
  expect(decodeSidebarPreferences([removed.event], h.secret).starred).toEqual([
    "beta",
  ]);
  expect(
    (
      await prepareSidebarStar(
        [removed.event],
        { channelId: "alpha", starred: false },
        h.secret,
        h.signer,
      )
    ).event,
  ).toBeUndefined();
  expect(
    (
      await prepareSidebarStar(
        [],
        { channelId: "new", starred: false },
        h.secret,
        h.signer,
        undefined,
        50000,
      )
    ).stars.channels,
  ).toEqual({});
});
it("refuses untrusted, ambiguous, malformed and over-budget heads rather than seeding", async () => {
  const h = harness(),
    other = harness();
  const intent = { channelId: "alpha", starred: true };
  const valid = h.encrypt({});
  for (const events of [
    null,
    [other.encrypt({})],
    [valid, valid],
    [{ ...JSON.parse(JSON.stringify(valid)), sig: "0".repeat(128) }],
    [h.encrypt({}, { tags: [["d", "channel-sections"]] })],
    [
      h.encrypt(
        {},
        {
          tags: [
            ["d", "channel-stars"],
            ["d", "channel-stars"],
          ],
        },
      ),
    ],
    [h.encrypt({ alpha: { starred: true, updatedAt: -1 } })],
    [h.encrypt({}, { content: "x".repeat(SIDEBAR_REQUEST_BYTES) })],
  ])
    await expect(
      prepareSidebarStar(events, intent, h.secret, h.signer),
    ).rejects.toThrow();
  const full = Object.fromEntries(
    Array.from({ length: 500 }, (_, i) => [
      `id-${i}`,
      { starred: false, updatedAt: 1 },
    ]),
  );
  await expect(
    prepareSidebarStar([h.encrypt(full)], intent, h.secret, h.signer),
  ).rejects.toThrow("budget exceeded");
});
it("confirms fresh retained state, including newer unrelated entries, and does not publish no-ops", async () => {
  const h = harness();
  let heads = [];
  const read = vi.fn(async () => heads);
  const publish = vi.fn(async () => {
    heads = [
      h.encrypt({
        alpha: { starred: true, updatedAt: 1 },
        beta: { starred: true, updatedAt: 2 },
      }),
    ];
  });
  const intent = { channelId: "alpha", starred: true };
  expect(
    (
      await mutateSidebarStar(
        intent,
        h.secret,
        h.signer,
        undefined,
        read,
        publish,
      )
    ).channels,
  ).toHaveProperty("beta");
  expect(read).toHaveBeenCalledTimes(2);
  expect(publish).toHaveBeenCalledOnce();
  await mutateSidebarStar(intent, h.secret, h.signer, undefined, read, publish);
  expect(publish).toHaveBeenCalledOnce();
});
it("does not report success on read/publish failures or conflicting confirmation", async () => {
  const h = harness(),
    intent = { channelId: "alpha", starred: true };
  const publish = vi.fn();
  await expect(
    mutateSidebarStar(
      intent,
      h.secret,
      h.signer,
      undefined,
      async () => {
        throw new Error("read failed");
      },
      publish,
    ),
  ).rejects.toThrow("read failed");
  expect(publish).not.toHaveBeenCalled();
  const read = vi.fn(async () => []);
  await expect(
    mutateSidebarStar(intent, h.secret, h.signer, undefined, read, async () => {
      throw new Error("publish failed");
    }),
  ).rejects.toThrow("publish failed");
  expect(read).toHaveBeenCalledOnce();
  await expect(
    mutateSidebarStar(intent, h.secret, h.signer, undefined, read, publish),
  ).rejects.toThrow("changed on another device");
});
