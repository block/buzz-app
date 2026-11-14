// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cancelScheduledToDraft, scheduledDraftKey } from "./scheduled-draft";
import { readView, writeView } from "../../shared/view-state";
import { MEDIA_TARGET_TAG } from "../relay/contracts";
import type { RelaySession } from "../relay/session";

const channel = "11111111-1111-4111-8111-111111111111",
  root = "b".repeat(64),
  person = "c".repeat(64);
const scope = `https://example.org:${"a".repeat(64)}`;
function fixture(tags: string[][] = [], content = "**Finish** the message") {
  const item = {
    id: crypto.randomUUID(),
    revision: "1",
    content,
    sendAt: Date.now() + 60000,
    status: "scheduled" as const,
    destination: {
      channelId: channel,
      name: "General",
      ...(tags.some((t) => t[0] === "e") ? { threadRootId: root } : {}),
    },
  };
  const event = {
    id: "e".repeat(64),
    pubkey: "a".repeat(64),
    sig: "f".repeat(128),
    created_at: Math.floor(item.sendAt / 1000),
    kind: 9,
    content,
    tags: [["h", channel], ...tags],
  };
  const cancel = vi.fn(async () => {});
  const session = {
    scope,
    relayAuthor: "d".repeat(64),
    profiles: { snapshot: () => new Map([[person, { name: "Sam" }]]) },
    agentLibrary: { snapshot: () => ({ identities: [] }) },
    scheduledMessages: { event: () => event, cancel },
  } as unknown as RelaySession;
  return { item, event, session, cancel, key: scheduledDraftKey(item) };
}
afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});
it("saves formatting and mention bindings before cancelling a root-thread message", async () => {
  const h = fixture(
    [
      ["e", root, "", "reply"],
      ["p", person],
    ],
    "**Hello** @Sam",
  );
  h.cancel.mockImplementation(async () => {
    expect(readView(scope, h.key, null)).toMatchObject({
      text: "**Hello** @Sam",
      recipients: [{ pubkey: person, name: "Sam" }],
    });
  });
  expect(await cancelScheduledToDraft(h.session, h.item)).toBe(
    `draft:${channel}:thread:${root}`,
  );
  expect(h.cancel).toHaveBeenCalledWith(h.item.id, "1");
});
it("refuses to overwrite an existing draft", async () => {
  const h = fixture();
  writeView(scope, h.key, "Newer draft");
  await expect(cancelScheduledToDraft(h.session, h.item)).rejects.toThrow(
    "already a draft",
  );
  expect(h.cancel).not.toHaveBeenCalled();
  expect(readView(scope, h.key, "")).toBe("Newer draft");
});
it("keeps the saved draft when cancellation is uncertain", async () => {
  const h = fixture();
  h.cancel.mockRejectedValueOnce(new Error("Response lost"));
  await expect(cancelScheduledToDraft(h.session, h.item)).rejects.toThrow(
    "cancellation is not confirmed",
  );
  expect(readView(scope, h.key, null)).toMatchObject({ text: h.item.content });
});
it("leaves the message queued if local storage cannot save it", async () => {
  const h = fixture();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Full");
  });
  await expect(cancelScheduledToDraft(h.session, h.item)).rejects.toThrow(
    "could not be saved",
  );
  expect(h.cancel).not.toHaveBeenCalled();
});
it.each(
  [
    [["imeta", "url https://example.org/file.png"]],
    [["model", person, "some-model"]],
    [["effort", person, "high"]],
    [[MEDIA_TARGET_TAG, "https://example.org/file.png"]],
    [
      ["e", root, "", "root"],
      ["e", "f".repeat(64), "", "reply"],
    ],
  ].map((tags) => ({ tags })),
)(
  "leaves unsupported attachment or delivery bindings scheduled (%j)",
  async ({ tags }) => {
    const h = fixture(tags);
    await expect(cancelScheduledToDraft(h.session, h.item)).rejects.toThrow(
      "drafts cannot preserve",
    );
    expect(h.cancel).not.toHaveBeenCalled();
    expect(readView(scope, h.key, null)).toBeNull();
    expect(localStorage.length).toBe(0);
  },
);
it("cannot turn a scheduled literal into a destructive composer command", async () => {
  const h = fixture([], "/leave");
  await expect(cancelScheduledToDraft(h.session, h.item)).rejects.toThrow(
    "starts with a command",
  );
  expect(h.cancel).not.toHaveBeenCalled();
  expect(localStorage.length).toBe(0);
});
