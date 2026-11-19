import { afterEach, assert, expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import { createMessages } from "./messages";
import { createOutbox } from "./outbox";
import { foldMessages } from "./fold";
import type { LiveCallbacks } from "./live";
import type { EventData } from "./events";
import {
  bounds,
  flush,
  keypair,
  message,
  roster,
  scriptedTransport,
  signed,
  summary,
} from "./testing";

const relay = keypair(),
  author = keypair(),
  other = keypair();
const channel = "forum";
const post = signed(author, {
  kind: 45001,
  content: "Forum **post**",
  created_at: 10,
  tags: [["h", channel]],
});
const comment = (content: string, created_at: number) =>
  signed(other, {
    kind: 45003,
    content,
    created_at,
    tags: [
      ["h", channel],
      ["e", post.id, "", "reply"],
    ],
  });
const owners: { dispose(): void }[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});
function setup() {
  const wire = scriptedTransport(author.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const owner = createRelaySession({
    ...wire.transport,
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  owners.push(owner);
  live.receive([roster(relay, channel, [author.pubkey])]);
  return { ...wire, ...owner, live };
}

it("loads forum history, retains live posts, and keeps replies out of the channel timeline", async () => {
  const h = setup();
  h.session.channels.ensure(channel);
  const page = h.next();
  expect(page.filters[0]?.kinds).toEqual(
    expect.arrayContaining([45001, 45003]),
  );
  const reply = comment("Mobile reply", 11);
  page.respond([
    post,
    summary(relay, channel, post.id, {
      descendant_count: 1,
      participants: [other.pubkey],
    }),
    bounds(relay, channel, "head", { has_more: false, next_cursor: null }),
  ]);
  await flush();
  expect(h.session.channels.window(channel).rows).toMatchObject([
    { id: post.id, content: post.content, replyCount: 1 },
  ]);
  const newer = signed(other, {
    kind: 45001,
    content: "Live post",
    created_at: 12,
    tags: [["h", channel]],
  });
  h.live.receive([reply, newer, newer]);
  expect(h.session.channels.window(channel).rows.map((row) => row.id)).toEqual([
    post.id,
    newer.id,
  ]);
  // A fresh session must load persisted events through history, independently of live delivery.
  const reloaded = setup();
  reloaded.session.channels.ensure(channel);
  reloaded
    .next()
    .respond([
      post,
      newer,
      bounds(relay, channel, "head", { has_more: false, next_cursor: null }),
    ]);
  await flush();
  expect(
    reloaded.session.channels.window(channel).rows.map((row) => row.id),
  ).toEqual([post.id, newer.id]);
});

it("opens forum roots and replies with legacy pagination and merges live comments once", async () => {
  const h = setup();
  h.live.receive([post]);
  const view = h.session.thread(channel, post.id);
  const first = comment("First", 11);
  const loading = view.refresh();
  const page = h.next();
  expect(page.filters[1]?.kinds).toContain(45003);
  page.respond([post, first]);
  await loading;
  expect(view.snapshot()).toMatchObject({
    status: "ready",
    root: { id: post.id },
    replies: [{ id: first.id }],
  });
  const live = comment("Live", 20);
  h.live.receive([live]);
  const more = view.loadMore();
  const next = h.next();
  expect(next.filters[1]).toMatchObject({
    thread_cursor: 11,
    thread_cursor_id: first.id,
  });
  next.respond([post, live]);
  await more;
  expect(view.snapshot().replies.map((row) => row.id)).toEqual([
    first.id,
    live.id,
  ]);
  const fresh = setup();
  const selected = fresh.session.thread(channel, first.id);
  const opening = selected.refresh();
  fresh.next().respond([first]);
  await flush();
  fresh.next().respond([post, first, live]);
  await opening;
  expect(selected.snapshot().root?.id).toBe(post.id);
  expect(selected.snapshot().replies.map((row) => row.id)).toEqual([
    first.id,
    live.id,
  ]);
});

it("resolves an exact forum reply link and repairs missed comments when its stream reconnects", async () => {
  const h = setup();
  const selected = comment("Selected reply", 11);
  const view = h.session.thread(channel, selected.id, { exact: true });
  const opening = view.refresh();
  h.next().respond([selected]);
  await flush();
  h.next().respond([]); // Exact selection's auxiliary closure.
  await flush();
  h.next().respond([post, selected]);
  await opening;
  expect(view.snapshot()).toMatchObject({
    status: "ready",
    root: { id: post.id },
    targetStatus: "ready",
    target: { id: selected.id },
  });
  const missed = comment("Missed while offline", 12);
  h.live.state({ status: "connected", routes: [] });
  h.live.state({ status: "retrying", routes: [] });
  h.live.state({ status: "connected", routes: [] });
  h.live.established(channel);
  h.next().respond([selected]);
  await flush();
  h.next().respond([]);
  await flush();
  h.next().respond([post, selected, missed]);
  await flush();
  expect(view.snapshot().replies.map((row) => row.id)).toEqual([
    selected.id,
    missed.id,
  ]);
});

it("renders mobile Markdown/media, applies author overlays, and rejects foreign edits and deletions", () => {
  const media = signed(author, {
    kind: 45001,
    content: "Read **this**",
    created_at: 10,
    tags: [
      ["h", channel],
      ["imeta", "url https://example.com/photo.png", "m image/png"],
    ],
  });
  const reply = comment("Reply", 11);
  const overlay = (kind: number, key = author) =>
    signed(key, {
      kind,
      content: kind === 40003 ? "Edited" : "",
      tags: [
        ["h", channel],
        ["e", media.id],
      ],
    });
  const rows = foldMessages(
    channel,
    relay.pubkey,
    [
      media,
      reply,
      message(other, channel, "Chat", 12),
      overlay(40003, other),
      overlay(5, other),
    ],
    { includeReplies: true },
  );
  expect(rows.map((row) => row.content)).toEqual([
    "Read **this**",
    "Reply",
    "Chat",
  ]);
  expect(rows[0]?.attachments).toMatchObject([
    { url: "https://example.com/photo.png", kind: "image" },
  ]);
  expect(rows.slice(0, 2).map((row) => row.forum)).toEqual([true, true]);
  expect(rows[2]?.forum).toBeUndefined();
  expect(
    foldMessages(channel, relay.pubkey, [media, overlay(40003)])[0]?.content,
  ).toBe("Edited");
  expect(foldMessages(channel, relay.pubkey, [media, overlay(5)])).toEqual([]);
  expect(foldMessages("other", relay.pubkey, [media, reply])).toEqual([]);
});

it.each([45001, 45003])(
  "keeps forum edits/reactions gated while allowing author deletion and reporting (kind %s)",
  async (kind) => {
    const own = signed(author, {
      kind,
      content: "Mine",
      tags: [["h", channel]],
    });
    const foreign = signed(other, {
      kind,
      content: "Theirs",
      tags: [["h", channel]],
    });
    const events: EventData[] = [own, foreign];
    const writer = {
      sign: vi.fn(async (template) => signed(author, template)),
      publish: vi.fn(async () => {}),
    };
    const owner = createOutbox(author.pubkey, writer, {
      load: () => [],
      save() {},
    });
    const { outbox } = owner;
    owners.push(owner);
    await outbox.ready();
    const report = vi.fn(async () => {});
    const messages = createMessages(
      outbox,
      author.pubkey,
      (id) => events.find((event) => event.id === id),
      () => [],
      () => {},
      () => true,
      undefined,
      report,
    );
    expect(() => messages.edit(foreign.id, "Forged", foreign.id)).toThrow(
      "Load the message before editing it",
    );
    expect(() => messages.remove([foreign.id])).toThrow("Only your own");
    expect(() => messages.edit(own.id, "Edited", own.id)).toThrow(
      "Load the message before editing it",
    );
    expect(() => messages.react(foreign.id, "👍")).toThrow(
      "Load the message before reacting to it",
    );
    expect(writer.sign).not.toHaveBeenCalled();
    expect(outbox.snapshot()).toEqual([]);
    messages.remove([own.id]);
    assert.exists(messages.report);
    await messages.report(foreign.id, "spam");
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 1984,
        tags: [
          ["p", other.pubkey],
          ["e", foreign.id, "spam"],
        ],
      }),
    );
    expect(
      outbox
        .snapshot()
        .map((item) => item.event.kind)
        .sort((a, b) => a - b),
    ).toEqual([5]);
  },
);

it.each([45001, 45003])(
  "applies an attributed forum author's deletion without trusting an arbitrary actor tag (kind %s)",
  (kind) => {
    const archived = signed(relay, {
      kind,
      content: "Migrated forum",
      tags: [
        ["h", channel],
        ["actor", author.pubkey],
      ],
    });
    const deletion = signed(author, {
      kind: 5,
      content: "",
      tags: [
        ["h", channel],
        ["e", archived.id],
        ["k", String(kind)],
      ],
    });
    expect(
      foldMessages(channel, relay.pubkey, [archived, deletion], {
        signingAuthority: relay.pubkey,
      }),
    ).toEqual([]);
    const forged = signed(other, { ...archived, tags: archived.tags });
    const forgedDeletion = signed(author, {
      ...deletion,
      tags: [
        ["h", channel],
        ["e", forged.id],
      ],
    });
    expect(
      foldMessages(channel, relay.pubkey, [forged, forgedDeletion], {
        signingAuthority: relay.pubkey,
      }),
    ).toMatchObject([{ id: forged.id, authorId: other.pubkey }]);
  },
);
