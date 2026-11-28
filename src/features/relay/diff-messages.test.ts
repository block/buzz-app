import { expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import { bounds, keypair, roster, signed, threadWindowBounds } from "./testing";
import type { LiveCallbacks } from "./live";
import type { ReadFilter } from "./events";

it("reads diff history, live roots/replies and exact targets through the real session", async () => {
  const viewer = keypair(),
    relay = keypair(),
    author = keypair();
  const origin = "https://relay.test";
  const diff = (time: number, tags: string[][] = []) =>
    signed(author, {
      kind: 40008,
      created_at: time,
      content: `patch ${time}`,
      tags: [["h", "a"], ["file", "a.ts"], ...tags],
    });
  const root = diff(1),
    reply = diff(2, [["e", root.id, "", "reply"]]);
  const events = [root, reply];
  const reads: ReadFilter[] = [];
  let live!: LiveCallbacks;
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: relay.pubkey,
    scope: origin,
    media: () => undefined,
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
    async query(filters) {
      reads.push(...filters);
      return (
        await Promise.all(
          filters.map(async (f) => {
            const matched = events.filter(
              (event) =>
                (!f.kinds || f.kinds.includes(event.kind)) &&
                (!f.ids || f.ids.includes(event.id)) &&
                (!f.top_level || !event.tags.some(([key]) => key === "e")) &&
                (!f["#h"] ||
                  event.tags.some(
                    ([key, value]) =>
                      key === "h" &&
                      value !== undefined &&
                      f["#h"]?.includes(value),
                  )) &&
                (!f["#e"] ||
                  event.tags.some(
                    ([key, value]) =>
                      key === "e" &&
                      value !== undefined &&
                      f["#e"]?.includes(value),
                  )),
            );
            if (f.thread_window)
              return [
                ...matched,
                await threadWindowBounds(relay, origin, viewer.pubkey, f),
              ];
            return f.top_level && f["#h"]
              ? [
                  ...matched,
                  bounds(relay, "a", "head", {
                    has_more: false,
                    next_cursor: null,
                  }),
                ]
              : matched;
          }),
        )
      ).flat();
    },
  });
  try {
    live.receive([roster(relay, "a", [viewer.pubkey, author.pubkey])]);
    owner.session.channels.ensure("a");
    await vi.waitFor(() =>
      expect(owner.session.channels.window("a").status).toBe("ready"),
    );
    expect(
      owner.session.channels.window("a").rows.map((row) => row.id),
    ).toEqual([root.id]);
    expect(owner.session.channels.window("a").rows[0]?.diff?.filePath).toBe(
      "a.ts",
    );
    const thread = owner.session.thread("a", root.id);
    await thread.refresh();
    expect(thread.snapshot().root?.id).toBe(root.id);
    expect(thread.snapshot().root?.diff?.filePath).toBe("a.ts");
    // The relay's thread_window row allowlist excludes legacy diffs (kind 40008).
    expect(
      reads.some(
        (f) =>
          f.thread_window &&
          f["#e"]?.includes(root.id) &&
          !f.kinds?.includes(40008),
      ),
    ).toBe(true);
    const liveRoot = diff(3),
      liveReply = diff(4, [["e", root.id, "", "reply"]]);
    events.push(liveRoot, liveReply);
    live.receive([liveRoot, liveReply]);
    expect(
      owner.session.channels.window("a").rows.map((row) => row.id),
    ).toEqual([root.id, liveRoot.id]);
    expect(thread.snapshot().replies.map((row) => row.id)).toEqual([
      liveReply.id,
    ]);
    const exact = owner.session.thread("a", reply.id, { exact: true });
    await exact.refresh();
    expect(exact.snapshot()).toMatchObject({
      targetStatus: "ready",
      target: { id: reply.id, diff: { filePath: "a.ts" } },
      root: { id: root.id },
    });
    exact.dispose();
    thread.dispose();
  } finally {
    owner.dispose();
  }
});
