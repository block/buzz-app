import { expect, it, vi } from "vitest";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip44,
} from "nostr-tools";
import { createSidebarPreferencesStore } from "../src/features/relay/sidebar-preferences-store.ts";
import {
  decodeSidebarPreferences,
  mutateSidebarAssignment,
} from "./sidebar-preferences.mjs";

async function setup({ cachedAssignment = true } = {}) {
  const secret = generateSecretKey();
  const key = nip44.v2.utils.getConversationKey(secret, getPublicKey(secret));
  const heads = new Map();
  for (const [coordinate, blob] of [
    [
      "channel-sections",
      {
        version: 1,
        sections: [{ id: "work", name: "Work", order: 0 }],
        assignments: { alpha: "work", beta: "work" },
      },
    ],
    // An earlier client's record; moves never write it.
    [
      "channel-stars",
      { version: 1, channels: { alpha: { starred: true, updatedAt: 1 } } },
    ],
  ])
    heads.set(
      coordinate,
      finalizeEvent(
        {
          kind: 30078,
          created_at: 1,
          tags: [["d", coordinate]],
          content: nip44.v2.encrypt(JSON.stringify(blob), key),
        },
        secret,
      ),
    );
  key.fill(0);
  const read = vi.fn(async () =>
    decodeSidebarPreferences([...heads.values()], secret),
  );
  if (!cachedAssignment)
    read.mockResolvedValueOnce({
      ...(await read()),
      assignments: { beta: "work" },
    });
  const publications = [];
  const publish = vi.fn(async (event) => {
    const coordinate = event.tags.find(([tag]) => tag === "d")[1];
    heads.set(coordinate, event);
    publications.push(coordinate);
  });
  const assignment = vi.fn((intent, signal) =>
    mutateSidebarAssignment(
      intent,
      secret,
      async () => {
        signal.throwIfAborted();
        return [heads.get("channel-sections")];
      },
      publish,
    ),
  );
  const owner = createSidebarPreferencesStore({
    read,
    available: true,
    write: assignment,
  });
  await owner.queries.ensure();
  return {
    owner,
    prefs: owner.queries,
    read,
    publish,
    publications,
    assignment,
  };
}

it.each([true, false])(
  "removal clears the durable previous group even when cached assignment is %s",
  async (cachedAssignment) => {
    const h = await setup({ cachedAssignment });
    try {
      await h.prefs.assign("alpha");
      expect(h.publications).toEqual(["channel-sections"]);
      const restored = await h.read();
      expect(restored.assignments).toEqual({ beta: "work" });
      expect(h.prefs.snapshot().data).toEqual(restored);
    } finally {
      h.owner.dispose();
    }
  },
);

it("does not change placement when assignment publication fails", async () => {
  const h = await setup();
  try {
    const before = h.prefs.snapshot();
    h.publish.mockRejectedValueOnce(new Error("assignment rejected"));
    await expect(h.prefs.assign("alpha")).rejects.toThrow(
      "assignment rejected",
    );
    expect(h.prefs.snapshot().data).toEqual(before.data);
    expect(h.prefs.snapshot().moves).toEqual([
      expect.objectContaining({ pending: false, error: expect.any(String) }),
    ]);
    expect((await h.read()).assignments).toEqual({
      alpha: "work",
      beta: "work",
    });
    await h.prefs.assign("alpha");
    expect((await h.read()).assignments).toEqual({ beta: "work" });
  } finally {
    h.owner.dispose();
  }
});

it("failed move plus an older refresh cannot strand the preference status at loading", async () => {
  const h = await setup();
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let started;
  const entered = new Promise((resolve) => {
    started = resolve;
  });
  try {
    const before = h.prefs.snapshot().data;
    h.read.mockImplementationOnce(async () => {
      started();
      return held;
    });
    const refresh = h.prefs.refresh();
    await entered;
    h.assignment.mockRejectedValueOnce(new Error("assignment failed"));
    await expect(h.prefs.assign("alpha")).rejects.toThrow("assignment failed");
    release(before);
    await refresh;
    expect(h.prefs.snapshot()).toEqual({
      status: "ready",
      moves: [
        expect.objectContaining({ pending: false, error: "assignment failed" }),
      ],
      data: before,
    });
    await h.prefs.refresh();
    expect(h.prefs.snapshot().status).toBe("ready");
  } finally {
    release(h.prefs.snapshot().data);
    h.owner.dispose();
  }
});
