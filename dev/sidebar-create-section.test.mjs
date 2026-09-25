import { expect, it } from "vitest";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip44,
} from "nostr-tools";
import {
  assertSidebarAssignmentIntent,
  prepareSidebarAssignment,
  mutateSidebarAssignment,
} from "./sidebar-preferences.mjs";

const secret = generateSecretKey();
const id = "12345678-1234-1234-1234-123456789abc";
const intent = { channelId: "alpha", createSection: { id, name: " Launch " } };
function event(blob) {
  const key = nip44.v2.utils.getConversationKey(secret, getPublicKey(secret));
  try {
    return finalizeEvent(
      {
        kind: 30078,
        created_at: 5,
        tags: [["d", "channel-sections"]],
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
it("creates and assigns together, preserving raw unrelated fields and an idempotent retry", () => {
  const blob = {
    version: 1,
    future: { enabled: true },
    sections: [{ id: "work", name: "Work", order: 3, future: "keep" }],
    assignments: { beta: "work", hidden: "missing" },
  };
  const created = prepareSidebarAssignment([event(blob)], intent, secret);
  expect(decode(created.event)).toEqual({
    ...blob,
    sections: [...blob.sections, { id, name: "Launch", order: 4 }],
    assignments: { ...blob.assignments, alpha: id },
  });
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
