import { describe, expect, it, vi } from "vitest";
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
  assertSidebarMuteIntent,
  prepareSidebarMute,
  mutateSidebarMute,
} from "./sidebar-toggle.mjs";
import {
  decodeSidebarPreferences,
  SIDEBAR_REQUEST_BYTES,
} from "./sidebar-preferences.mjs";

describe.each([
  [
    "star",
    "starred",
    assertSidebarStarIntent,
    prepareSidebarStar,
    mutateSidebarStar,
  ],
  [
    "mute",
    "muted",
    assertSidebarMuteIntent,
    prepareSidebarMute,
    mutateSidebarMute,
  ],
])("sidebar %s", (name, field, assertIntent, prepare, mutate) => {
  const resultKey = `${name}s`;
  const coordinate = `channel-${resultKey}`;
  function harness() {
    const secret = generateSecretKey();
    const viewer = getPublicKey(secret);
    return {
      secret,
      viewer,
      encrypt(channels, overrides = {}) {
        const key = nip44.v2.utils.getConversationKey(secret, viewer);
        try {
          return finalizeEvent(
            {
              kind: 30078,
              created_at: 100,
              tags: [["d", coordinate]],
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
      { channelId: "", [field]: true },
      { channelId: "a" },
      { channelId: "a", [field]: 1 },
      { channelId: "a", [field === "starred" ? "muted" : "starred"]: true },
      { channelId: "x".repeat(257), [field]: true },
      { channelId: "a", [field]: true, extra: 1 },
    ])
      expect(() => assertIntent(intent)).toThrow(
        `Invalid sidebar ${name} intent`,
      );
    const read = vi.fn();
    await expect(mutate({}, h.secret, read, vi.fn())).rejects.toThrow(
      `Invalid sidebar ${name} intent`,
    );
    expect(read).not.toHaveBeenCalled();
  });
  it("encrypts explicit enable/disable with monotonic timestamps and preserves unrelated tombstones", () => {
    const h = harness();
    const channels = {
      alpha: { [field]: false, updatedAt: 60000 },
      beta: { [field]: true, updatedAt: 2 },
      gone: { [field]: false, updatedAt: 3 },
    };
    const added = prepare(
      [h.encrypt(channels)],
      { channelId: "alpha", [field]: true },
      h.secret,
      50000,
    );
    expect(verifyEvent(added.event)).toBe(true);
    expect(added.event).toMatchObject({
      pubkey: h.viewer,
      kind: 30078,
      created_at: 101,
      tags: [
        ["d", coordinate],
        ["t", coordinate],
      ],
    });
    expect(added.event.content).not.toContain("alpha");
    expect(added[resultKey].channels).toEqual({
      ...channels,
      alpha: { [field]: true, updatedAt: 60001 },
    });
    expect(decodeSidebarPreferences([added.event], h.secret)[field]).toEqual([
      "alpha",
      "beta",
    ]);
    const removed = prepare(
      [added.event],
      { channelId: "alpha", [field]: false },
      h.secret,
      50000,
    );
    expect(removed[resultKey].channels).toEqual({
      ...channels,
      alpha: { [field]: false, updatedAt: 60002 },
    });
    expect(decodeSidebarPreferences([removed.event], h.secret)[field]).toEqual([
      "beta",
    ]);
    expect(
      prepare([removed.event], { channelId: "alpha", [field]: false }, h.secret)
        .event,
    ).toBeUndefined();
    expect(
      prepare([], { channelId: "new", [field]: false }, h.secret, 50000)[
        resultKey
      ].channels,
    ).toEqual(
      field === "starred" ? {} : { new: { muted: false, updatedAt: 50000 } },
    );
  });
  it("refuses untrusted, ambiguous, malformed and over-budget heads rather than seeding", () => {
    const h = harness(),
      other = harness();
    const intent = { channelId: "alpha", [field]: true };
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
              ["d", field === "starred" ? "channel-mutes" : "channel-stars"],
            ],
          },
        ),
      ],
      [
        h.encrypt(
          {},
          {
            tags: [
              ["d", coordinate],
              ["d", coordinate],
            ],
          },
        ),
      ],
      [h.encrypt({ alpha: { [field]: true, updatedAt: -1 } })],
      [h.encrypt({}, { content: "x".repeat(SIDEBAR_REQUEST_BYTES) })],
    ])
      expect(() => prepare(events, intent, h.secret)).toThrow();
    const full = Object.fromEntries(
      Array.from({ length: 500 }, (_, i) => [
        `id-${i}`,
        { [field]: false, updatedAt: 1 },
      ]),
    );
    expect(() => prepare([h.encrypt(full)], intent, h.secret)).toThrow(
      "budget exceeded",
    );
  });
  it("confirms fresh retained state, including newer unrelated entries, and does not publish no-ops", async () => {
    const h = harness();
    let heads = [];
    const read = vi.fn(async () => heads);
    const publish = vi.fn(async () => {
      heads = [
        h.encrypt({
          alpha: { [field]: true, updatedAt: 1 },
          beta: { [field]: true, updatedAt: 2 },
        }),
      ];
    });
    const intent = { channelId: "alpha", [field]: true };
    expect(
      (await mutate(intent, h.secret, read, publish)).channels,
    ).toHaveProperty("beta");
    expect(read).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledOnce();
    await mutate(intent, h.secret, read, publish);
    expect(publish).toHaveBeenCalledOnce();
  });
});
