import { expect, it } from "vitest";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip44,
} from "nostr-tools";
import {
  decodeSidebarPreferences,
  assertSidebarAssignmentIntent,
  prepareSidebarAssignment,
  mutateSidebarAssignment,
} from "./sidebar-preferences.mjs";

const secret = generateSecretKey();
const id = "12345678-1234-1234-1234-123456789abc";
const intent = { channelId: "alpha", createSection: { id, name: " Launch " } };
function event(blob, coordinate = "channel-sections") {
  const key = nip44.v2.utils.getConversationKey(secret, getPublicKey(secret));
  try {
    return finalizeEvent(
      {
        kind: 30078,
        created_at: 5,
        tags: [["d", coordinate]],
        content: nip44.v2.encrypt(JSON.stringify(blob), key),
      },
      secret,
    );
  } finally {
    key.fill(0);
  }
}
function decode(record) {
  const key = nip44.v2.utils.getConversationKey(secret, getPublicKey(secret));
  try {
    return JSON.parse(nip44.v2.decrypt(record.content, key));
  } finally {
    key.fill(0);
  }
}
it("creates and assigns together, imports legacy fields into registers and keeps retry idempotent", () => {
  const blob = {
    version: 1,
    future: { enabled: true },
    sections: [{ id: "work", name: "Work", order: 3, future: "keep" }],
    assignments: { beta: "work", hidden: "missing" },
  };
  const created = prepareSidebarAssignment([event(blob)], intent, secret);
  const { meta, ...projection } = decode(created.event);
  expect(projection).toEqual({
    ...blob,
    sections: [
      { id: "work", name: "Work", order: 0 },
      { id, name: "Launch", order: 1 },
    ],
    assignments: { beta: "work", alpha: id },
  });
  expect(meta.s.work.order).toEqual([5000, "0000000000000000", 3]);
  expect(meta.s[id].order[2]).toBe(4);
  expect(meta.a.alpha[2]).toBe(id);
  expect(
    prepareSidebarAssignment([created.event], intent, secret).event,
  ).toBeUndefined();
  expect(() =>
    prepareSidebarAssignment(
      [created.event],
      { ...intent, createSection: { id, name: "Different" } },
      secret,
    ),
  ).toThrow("changed");
});
it.each([
  { ...intent, sectionId: "work" },
  { ...intent, createSection: { id, name: " " } },
  { ...intent, createSection: { id, name: "a".repeat(257) } },
  { ...intent, createSection: { id: "__proto__", name: "Launch" } },
  { ...intent, createSection: { id, name: "Launch", icon: "unexpected" } },
  { ...intent, createSection: [] },
  { ...intent, createSection: null },
])("rejects malformed create intent before writing: %j", (value) => {
  expect(() => assertSidebarAssignmentIntent(value)).toThrow("Invalid");
});
it("enforces section limits and refuses an invalid or unreadable current head", () => {
  const full = {
    version: 1,
    sections: Array.from({ length: 100 }, (_, i) => ({
      id: String(i),
      name: String(i),
      order: i,
    })),
    assignments: {},
  };
  expect(() => prepareSidebarAssignment([event(full)], intent, secret)).toThrow(
    "Unsupported",
  );
  expect(() =>
    prepareSidebarAssignment([event({ ...full, version: 2 })], intent, secret),
  ).toThrow("Unsupported");
  const unreadable = event({ version: 1, sections: [], assignments: {} });
  expect(() =>
    prepareSidebarAssignment(
      [{ ...JSON.parse(JSON.stringify(unreadable)), content: "broken" }],
      intent,
      secret,
    ),
  ).toThrow("Invalid");
});
it("failed confirmation may follow publication; retry confirms the same section without another write", async () => {
  let head;
  let reads = 0;
  let publications = 0;
  const read = async () => {
    if (++reads === 2) throw new Error("confirmation offline");
    return head ? [head] : [];
  };
  const publish = async (value) => {
    publications++;
    head = value;
  };
  await expect(
    mutateSidebarAssignment(intent, secret, read, publish),
  ).rejects.toThrow("confirmation offline");
  const groups = await mutateSidebarAssignment(intent, secret, read, publish);
  expect(groups.sections).toEqual([{ id, name: "Launch", order: 0 }]);
  expect(groups.assignments).toEqual({ alpha: id });
  expect(publications).toBe(1);
});
it("a failed initial read never seeds or publishes", async () => {
  let publications = 0;
  await expect(
    mutateSidebarAssignment(
      intent,
      secret,
      async () => {
        throw new Error("offline");
      },
      async () => {
        publications++;
      },
    ),
  ).rejects.toThrow("offline");
  expect(publications).toBe(0);
});

it("decodes all encrypted preferences despite oversized deleted text without rewriting it", () => {
  const reg = (value) => [100, "1111111111111111", value];
  const blob = {
    version: 1,
    sections: [{ id: "stale", name: "Stale", order: 0 }],
    assignments: {},
    meta: {
      v: 1,
      s: {
        work: { name: reg("Work"), order: reg(0), live: reg(true) },
        dead: {
          name: reg("x".repeat(257)),
          icon: reg("i".repeat(129)),
          live: reg(false),
        },
      },
      a: { alpha: reg("work"), beta: reg("dead") },
    },
  };
  const head = event(blob);
  expect(
    decodeSidebarPreferences(
      [
        head,
        event(
          { version: 1, channels: { alpha: { starred: true, updatedAt: 1 } } },
          "channel-stars",
        ),
        event(
          { version: 1, channels: { beta: { muted: true, updatedAt: 1 } } },
          "channel-mutes",
        ),
        event({ version: 1, groups: { channels: "recent" } }, "channel-sort"),
      ],
      secret,
    ),
  ).toEqual({
    sections: [{ id: "work", name: "Work", order: 0 }],
    assignments: { alpha: "work" },
    starred: ["alpha"],
    muted: ["beta"],
    sort: { channels: "recent" },
  });
  expect(() => prepareSidebarAssignment([head], intent, secret)).toThrow(
    "Invalid sidebar register",
  );
  expect(decode(head)).toEqual(blob);
});

it("appends after the rounded order imported from a fractional legacy head", () => {
  const created = prepareSidebarAssignment(
    [
      event({
        version: 1,
        sections: [{ id: "work", name: "Work", order: 0.5 }],
        assignments: {},
      }),
    ],
    intent,
    secret,
  );
  const saved = decode(created.event);
  expect(saved.sections).toEqual([
    { id: "work", name: "Work", order: 0 },
    { id, name: "Launch", order: 1 },
  ]);
  expect(saved.meta.s.work.order[2]).toBe(1);
  expect(saved.meta.s[id].order[2]).toBe(2);
});
