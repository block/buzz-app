import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import { keypair, message, metadata, roster, signed } from "./testing";
import type { RelayEvent, ReadFilter } from "./events";
import type { LiveCallbacks } from "./live";

const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});
function setup() {
  const viewer = keypair(),
    alice = keypair(),
    relay = keypair();
  let live!: LiveCallbacks;
  const original = message(viewer, "room", "Last week's message", 20);
  const reaction = signed(alice, {
    kind: 7,
    content: "✅",
    created_at: 30,
    tags: [
      ["h", "room"],
      ["e", original.id],
    ],
  });
  const query = vi.fn(
    async (filters: readonly ReadFilter[]): Promise<RelayEvent[]> => {
      const filter = filters[0];
      if (filter?.ids) return [original];
      if (filter?.kinds?.includes(7) && !filter.before_id) return [reaction];
      return [];
    },
  );
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: relay.pubkey,
    query,
    media: () => undefined,
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  owners.push(owner);
  const admit = (members: string[], at = 10) =>
    live.receive([
      roster(relay, "room", members, at),
      metadata(relay, "room", "Room", at),
    ]);
  admit([viewer.pubkey, alice.pubkey]);
  return { ...owner, original, reaction, viewer, alice, relay, query, admit };
}
it("discovers reactions to unloaded own messages through the real session access boundary", async () => {
  const h = setup();
  expect(
    await h.session.read([{ kinds: [7], "#h": ["room"], limit: 100 }]),
  ).toEqual([]);
  const page = await h.session.reactionHistory();
  expect(page.rows).toMatchObject([
    {
      id: h.reaction.id,
      messageId: h.original.id,
      preview: "Last week's message",
    },
  ]);
  expect(page.cursor).toEqual({ until: 30, before_id: h.reaction.id });
  expect((await h.session.reactionHistory(page.cursor)).rows).toEqual([]);
  expect(h.session.channels.window("room").rows).toEqual([]);
});
it("does not expose another author's original even with a claimed recipient", async () => {
  const h = setup();
  const other = message(h.alice, "room", "Other message", 21);
  const reaction = signed(h.alice, {
    kind: 7,
    content: "✅",
    created_at: 31,
    tags: [
      ["h", "room"],
      ["e", other.id],
      ["p", h.viewer.pubkey],
    ],
  });
  h.query.mockImplementation(async (filters) =>
    filters[0]?.ids
      ? [other]
      : filters[0]?.kinds?.includes(7)
        ? [reaction]
        : [],
  );
  expect((await h.session.reactionHistory()).rows).toEqual([]);
});
it("rejects a history page when membership is revoked during target hydration", async () => {
  const h = setup();
  let finish!: (events: RelayEvent[]) => void;
  h.query.mockImplementation(async (filters) =>
    filters[0]?.ids
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : filters[0]?.kinds?.includes(7)
        ? [h.reaction]
        : [],
  );
  const pending = h.session.reactionHistory();
  const assertion = expect(pending).rejects.toMatchObject({
    name: "AbortError",
  });
  await vi.waitFor(() => expect(finish).toBeDefined());
  h.admit([h.alice.pubkey], 40);
  finish([h.original]);
  await assertion;
});
it("purges a channel when an older-page read is explicitly denied", async () => {
  const h = setup();
  const page = await h.session.reactionHistory();
  expect(page.rows).toHaveLength(1);
  h.query.mockRejectedValue(new Error("Relay read failed (403)"));
  await expect(h.session.reactionHistory(page.cursor)).rejects.toThrow();
  expect(
    h.session.channels.list().channels.find((channel) => channel.id === "room"),
  ).toBeUndefined();
});
