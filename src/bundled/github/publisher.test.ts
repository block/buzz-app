import { afterEach, expect, it, vi } from "vitest";
import type { EventData, ReadFilter } from "../../features/relay/events";
import { PublishRejected } from "../../features/relay/outbox";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { GitHubError, type GitHubCli } from "./gh";
import type { Hook } from "./hooks";
import {
  ABANDONED_CLAIM_S,
  ANNOUNCE_GRACE_S,
  START_SPREAD_MS,
  MAX_CHANNELS,
  POLL_MS,
  ROOT_ATTEMPTS,
  announcement,
  cardTags,
  changes,
  checksState,
  createCards,
  createPublisherStatus,
  isFresh,
  isStale,
  numbersQuery,
  pullId,
  readPull,
  readPulls,
  serialize,
  startPublisher,
  type Deps,
  type Pull,
  type Read,
  type Target,
} from "./publisher";

const url = "https://github.com/block/buzz-app/pull/7";
const channel = "11111111-1111-4111-8111-111111111111";

const node = (extra: Record<string, unknown> = {}) => ({
  url,
  number: 7,
  title: "Add the card",
  isDraft: false,
  state: "OPEN",
  updatedAt: "2026-11-05T10:00:00Z",
  author: { login: "joah" },
  mergedBy: null,
  baseRefName: "main",
  headRefName: "joah/card",
  headRefOid: "c0ffee",
  additions: 10,
  deletions: 2,
  changedFiles: 3,
  reviewRequests: {
    nodes: [
      { requestedReviewer: { __typename: "Team", slug: "core" } },
      { requestedReviewer: { __typename: "User", login: "cy" } },
    ],
  },
  latestOpinionatedReviews: {
    nodes: [{ state: "APPROVED", author: { login: "ana" } }],
  },
  latestReviews: {
    nodes: [
      { state: "COMMENTED", author: { login: "ana" } },
      { state: "COMMENTED", author: { login: "bo" } },
      { state: "PENDING", author: { login: "di" } },
    ],
  },
  timelineItems: { nodes: [] },
  commits: {
    nodes: [
      {
        commit: {
          statusCheckRollup: {
            contexts: {
              nodes: [
                {
                  __typename: "CheckRun",
                  name: "build",
                  status: "COMPLETED",
                  conclusion: "SUCCESS",
                },
                { __typename: "CheckRun", name: "e2e", status: "IN_PROGRESS" },
                {
                  __typename: "StatusContext",
                  context: "ci/legacy",
                  state: "EXPECTED",
                },
              ],
            },
          },
        },
      },
    ],
  },
  ...extra,
});

const read = (extra: Record<string, unknown> = {}) => {
  const found = readPull(node(extra), "block/buzz-app");
  if (!found) throw new Error("unread");
  return found;
};

it("reads a pull request as a card's content, field for field", () => {
  const { pull, actors } = read();
  expect(Object.keys(pull)).toEqual([
    "version",
    "url",
    "repo",
    "number",
    "title",
    "author",
    "state",
    "base",
    "head",
    "head_sha",
    "updated_at",
    "additions",
    "deletions",
    "changed_files",
    "checks",
    "reviews",
    "requested_reviewers",
  ]);
  expect(pull).toMatchObject({
    version: 1,
    url,
    repo: "block/buzz-app",
    state: "open",
    head_sha: "c0ffee",
    checks: {
      state: "pending",
      runs: { build: "success", "ci/legacy": "pending", e2e: "pending" },
    },
    reviews: { ana: "approved", bo: "commented" },
    requested_reviewers: ["cy", "team:core"],
  });
  expect(actors).toEqual({ merged: undefined });
  expect(read({ isDraft: true }).pull.state).toBe("draft");
  expect(read({ state: "CLOSED", isDraft: true }).pull.state).toBe("closed");
  const merged = read({ state: "MERGED", mergedBy: { login: "dan" } });
  expect(merged.pull.state).toBe("merged");
  expect(merged.actors.merged).toBe("dan");
  expect(
    read({
      state: "CLOSED",
      timelineItems: {
        nodes: [{ __typename: "ClosedEvent", actor: { login: "eve" } }],
      },
    }).actors.closed,
  ).toBe("eve");
  expect(readPull({ number: 7 }, "block/buzz-app")).toBeUndefined();
});

it("reads each pull request in an answer once, open and recently done alike", () => {
  const data = {
    repository: {
      open: { nodes: [node()] },
      done: {
        nodes: [node(), node({ url: `${url.slice(0, -1)}8`, number: 8 })],
      },
    },
  };
  expect(readPulls(data, "block/buzz-app").map((r) => r.pull.number)).toEqual([
    7, 8,
  ]);
  expect(readPulls({ repository: null }, "block/buzz-app")).toEqual([]);
});

it("settles checks it read when GitHub gives no state for them all", () => {
  expect(checksState({})).toBe("none");
  expect(checksState({ a: "success", b: "skipped" })).toBe("success");
  expect(checksState({ a: "success", b: "pending" })).toBe("pending");
  expect(checksState({ a: "pending", b: "timed_out" })).toBe("failure");
});

const with_ = (base: Read, pull: Partial<Pull>, actors = base.actors) => ({
  pull: { ...base.pull, ...pull },
  actors,
});
const hookMadeAt = Date.parse("2026-11-05T09:00:00Z") / 1000;

it("starts a card only for an open pull request changed since the hook was made", () => {
  const { pull } = read();
  expect(isFresh(pull, hookMadeAt)).toBe(true);
  expect(isFresh(pull, hookMadeAt + 7200)).toBe(false);
  expect(isFresh({ ...pull, state: "merged" }, hookMadeAt)).toBe(false);
});

it("replies in a card's thread as the relay does, from the card it last wrote", () => {
  const before = read();
  expect(changes(before.pull, before)).toEqual({ changed: false, replies: [] });
  expect(
    changes(before.pull, with_(before, { state: "merged" }, { merged: "dan" })),
  ).toEqual({ changed: true, replies: ["Merged by dan"] });
  expect(
    changes(
      before.pull,
      with_(before, {
        reviews: { ana: "approved", bo: "changes_requested", "@x": "approved" },
      }),
    ).replies,
  ).toEqual(["bo requested changes", "@⁠x approved"]);
  expect(
    changes(
      { ...before.pull, state: "draft" },
      with_(before, { state: "open" }),
    ).replies,
  ).toEqual(["Ready for review"]);
  expect(
    changes(before.pull, with_(before, { state: "closed" }, {})).replies,
  ).toEqual(["Closed"]);
  expect(changes(undefined, before)).toEqual({ changed: true, replies: [] });
});

it("names each card for its hook, channel and pull request, as a UUIDv8", async () => {
  const d = await pullId("hook-d", channel, url);
  expect(d).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  expect(await pullId("hook-d", channel, url)).toBe(d);
  expect(await pullId("other", channel, url)).not.toBe(d);
  expect(await pullId("hook-d", `${channel.slice(0, -1)}2`, url)).not.toBe(d);
  expect(await pullId("hook-d", channel, `${url}0`)).not.toBe(d);
});

it("tags and announces a card", () => {
  const { pull } = read({ title: "Fix @here" });
  expect(
    cardTags("d1", channel, "hook-d", pull, "update", "p", "r", 1234),
  ).toEqual([
    ["ar", "1"],
    ["d", "d1"],
    ["h", channel],
    ["type", "github.pull"],
    ["title", "#7 · Fix @here"],
    ["op", "update"],
    ["r", url],
    ["repo", "block/buzz-app"],
    ["hook", "hook-d"],
    ["sha", "c0ffee"],
    ["state", "open"],
    ["source", "github"],
    ["status", "open"],
    ["read_at", "1234"],
    ["root", "r"],
    ["prev", "p"],
  ]);
  const long = cardTags(
    "d1",
    channel,
    "h",
    { ...pull, title: "é".repeat(400) },
    "create",
    undefined,
    undefined,
    1,
  );
  const title = long.find((entry) => entry[0] === "title")?.[1] ?? "";
  expect(new TextEncoder().encode(title).length).toBeLessThanOrEqual(512);
  expect(long.some((entry) => entry[0] === "prev" || entry[0] === "root")).toBe(
    false,
  );
  expect(announcement(pull)).toBe(`#7 · Fix @⁠here\n${url}`);
  expect(JSON.parse(serialize(pull))).toEqual(pull);
});

it("marks a claimed announcement on the card", () => {
  const { pull } = read();
  const tags = cardTags(
    "d1",
    channel,
    "h",
    pull,
    "create",
    undefined,
    undefined,
    1,
    "me",
  );
  expect(tags).toContainEqual(["announcing", "me"]);
});

const mike = "c".repeat(64);
const mallory = "e".repeat(64);
const tagOf = (event: EventData | undefined, name: string) =>
  event?.tags.find((entry) => entry[0] === name)?.[1];

/** A relay holding artifacts the way NIP-AR does: any channel writer may
 * write any revision whose `prev` is the head, a deletion takes only a
 * `restore` in its channel, and a `root` must name a message the relay
 * holds. Channels in `hidden` are ones the reader can't read. */
function fakeRelay() {
  const revisions = new Map<string, EventData[]>();
  const messages = new Set<string>();
  /** The messages the relay holds, as a read by author returns them. */
  const posts = new Map<string, EventData>();
  const hidden = new Set<string>();
  const filters: Record<string, unknown>[] = [];
  let refuse: string | undefined;
  let ids = 0;
  const headOf = (d: string) => revisions.get(d)?.at(-1);
  const sign = (
    pubkey: string,
    template: Omit<EventData, "id" | "pubkey" | "sig">,
  ) =>
    ({
      ...template,
      id: (++ids).toString(16).padStart(64, "0"),
      pubkey,
      sig: "",
    }) as EventData;
  const accept = (event: EventData) => {
    const d = tagOf(event, "d") ?? "";
    const head = headOf(d);
    const op = tagOf(event, "op");
    if (op === "create" ? !!head : tagOf(event, "prev") !== head?.id)
      throw new PublishRejected("conflict", "conflict: not the head");
    const deleted = tagOf(head, "op") === "delete";
    const moved = !!head && tagOf(head, "h") !== tagOf(event, "h");
    if (head && (deleted !== (op === "restore") || moved !== (op === "move")))
      throw new PublishRejected("invalid", `invalid: ${op} after this head`);
    if (refuse && (op === "restore" || op === "move"))
      throw new PublishRejected(refuse, refuse);
    const root = tagOf(event, "root");
    if (root && !messages.has(root))
      throw new PublishRejected("invalid", "invalid: root is not a message");
    revisions.set(d, [...(revisions.get(d) ?? []), event]);
  };
  const read = async (requested: readonly ReadFilter[]) => {
    await Promise.resolve();
    const filter = requested[0] as Record<string, unknown>;
    filters.push(filter);
    const ds = filter["#d"] as string[];
    const [h] = (filter["#h"] as string[] | undefined) ?? [];
    const authors = filter.authors as string[] | undefined;
    if ((filter.kinds as number[]).includes(9))
      return [...posts.values()].filter(
        (event) =>
          messages.has(event.id) &&
          tagOf(event, "h") === h &&
          (!authors || authors.includes(event.pubkey)) &&
          event.created_at >= ((filter.since as number) ?? 0),
      );
    if (filter.artifact !== undefined) {
      const unsupported = Object.keys(filter).find(
        (key) =>
          !key.startsWith("#") &&
          !["artifact", "kinds", "limit", "offset"].includes(key),
      );
      if (unsupported)
        throw new Error(`unsupported artifact predicate: ${unsupported}`);
    }
    if (filter.artifact === "current") {
      const offset = (filter.offset as number) ?? 0;
      const tagged = Object.entries(filter).filter(([key]) =>
        key.startsWith("#"),
      ) as [string, string[]][];
      return [...revisions.values()]
        .flatMap((events) => events.slice(-1))
        .filter(
          (head) =>
            tagOf(head, "op") !== "delete" &&
            tagged.every(([key, values]) =>
              values.includes(tagOf(head, key.slice(1)) ?? ""),
            ),
        )
        .slice(offset, offset + (filter.limit as number));
    }
    if (filter.artifact === "history") {
      const offset = (filter.offset as number) ?? 0;
      return (revisions.get(ds[0] ?? "") ?? [])
        .filter((event) => tagOf(event, "h") === h)
        .reverse()
        .slice(offset, offset + (filter.limit as number));
    }
    expect(filter.artifact).toBe("head");
    return ds.flatMap((d) => {
      const head = headOf(d);
      return head && !hidden.has(tagOf(head, "h") ?? "") ? [head] : [];
    });
  };
  return {
    revisions,
    messages,
    posts,
    hidden,
    filters,
    headOf,
    read,
    refuse(reason: string | undefined) {
      refuse = reason;
    },
    /** Another member's write on top of the head. */
    forge(
      d: string,
      change: (tags: string[][]) => string[][],
      content?: string,
      options: { op?: string; createdAt?: number } = {},
    ) {
      const head = headOf(d);
      if (!head) throw new Error("no head");
      const tags = change(
        head.tags
          .filter(([name]) => name !== "prev")
          .map((entry) => [...entry]),
      ).map((entry) =>
        entry[0] === "op" ? ["op", options.op ?? "update"] : entry,
      );
      accept(
        sign(mallory, {
          kind: 45010,
          created_at: options.createdAt ?? head.created_at,
          content: content ?? head.content,
          tags: [...tags, ["prev", head.id]],
        }),
      );
      return headOf(d) as EventData;
    },
    /** Another member's deletion of the card. */
    remove(d: string) {
      return this.forge(
        d,
        (tags) =>
          tags.filter(([name]) =>
            ["ar", "d", "h", "type", "op", "root"].includes(name ?? ""),
          ),
        "",
        { op: "delete" },
      );
    },
    /** Another member's move of the card to `channel`. */
    move(d: string, to: string) {
      return this.forge(
        d,
        (tags) =>
          tags
            .filter(([name]) => name !== "root")
            .map((entry) => (entry[0] === "h" ? ["h", to] : entry)),
        undefined,
        { op: "move" },
      );
    },
    writer(pubkey: string, before?: (event: EventData) => void) {
      return {
        sign: async (template: Omit<EventData, "id" | "pubkey" | "sig">) =>
          sign(pubkey, template),
        publish: async (event: EventData) => {
          await Promise.resolve();
          before?.(event);
          accept(event);
        },
      };
    },
  };
}

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
}

const hook: Hook = {
  d: "hook-d",
  repo: "block/buzz-app",
  head: "1".repeat(64),
  author: mike,
  createdAt: hookMadeAt,
  publisher: mike,
};
const target: Target = { channel, hook };

function device(
  relay: ReturnType<typeof fakeRelay>,
  options: {
    storage?: ReturnType<typeof memoryStorage>;
    land?: boolean;
    before?: (event: EventData) => void;
  } = {},
) {
  const storage = options.storage ?? memoryStorage();
  const sent: string[] = [];
  const replies: [string, string][] = [];
  let ids = 0;
  const messages = {
    send: vi.fn((_channel: string, content: string) => {
      const id =
        `${(++ids).toString(16)}${"m".repeat(63)}`.slice(0, 64) +
        String(Math.random());
      sent.push(content);
      relay.posts.set(id, {
        id,
        pubkey: mike,
        created_at: Math.floor(Date.now() / 1000),
        kind: 9,
        content,
        tags: [["h", _channel]],
      });
      if (options.land !== false) relay.messages.add(id);
      return id;
    }),
    reply: vi.fn((_channel: string, root: string, content: string) => {
      replies.push([root, content]);
      return "n".repeat(64);
    }),
  };
  const deps: Deps = {
    viewer: mike,
    scope: "community:mike",
    writer: relay.writer(mike, options.before) as unknown as Deps["writer"],
    read: relay.read as unknown as Deps["read"],
    messages: messages as unknown as Deps["messages"],
    storage,
  };
  return { cards: createCards(deps), sent, replies, messages, storage };
}

const live = () => new AbortController().signal;

async function cardD(pull = read().pull) {
  return pullId("hook-d", channel, pull.url);
}

/** A round's reads, read from GitHub at `readAt`. */
const at = (reads: Read[], readAt = Date.now()) => ({ reads, readAt });

it("starts a card, announces it once and roots the card on it", async () => {
  const relay = fakeRelay();
  const me = device(relay);
  const now = read();
  expect(await me.cards.round(target, at([now]), live())).toMatchObject({
    again: false,
    problems: [],
  });
  const d = await cardD();
  const head = relay.headOf(d);
  expect(me.sent).toEqual([announcement(now.pull)]);
  expect(head?.pubkey).toBe(mike);
  expect(tagOf(head, "root")).toBe(me.messages.send.mock.results[0]?.value);
  expect(tagOf(head, "announcing")).toBeUndefined();
  expect(relay.revisions.get(d)?.map((event) => tagOf(event, "op"))).toEqual([
    "create",
    "update",
  ]);
  expect(tagOf(relay.revisions.get(d)?.[0], "announcing")).toBeTruthy();
  await me.cards.round(target, at([now]), live());
  expect(relay.revisions.get(d)).toHaveLength(2);
});

it("puts its own root back when someone strips it, and never announces again", async () => {
  const relay = fakeRelay();
  const me = device(relay);
  const now = read();
  await me.cards.round(target, at([now]), live());
  const d = await cardD();
  const root = tagOf(relay.headOf(d), "root");
  for (let minute = 0; minute < 3; minute++) {
    relay.forge(d, (tags) => tags.filter(([name]) => name !== "root"));
    await me.cards.round(target, at([now]), live());
    expect(relay.headOf(d)?.pubkey).toBe(mike);
    expect(tagOf(relay.headOf(d), "root")).toBe(root);
  }
  expect(me.sent).toHaveLength(1);
});

it("keeps replies and the card on its own announcement when someone points the root elsewhere", async () => {
  const relay = fakeRelay();
  const me = device(relay);
  const now = read();
  await me.cards.round(target, at([now]), live());
  const d = await cardD();
  const root = tagOf(relay.headOf(d), "root");
  relay.messages.add("x".repeat(64));
  relay.forge(
    d,
    (tags) =>
      tags.map((entry) =>
        entry[0] === "root" ? ["root", "x".repeat(64)] : entry,
      ),
    serialize({ ...now.pull, state: "closed" }),
  );
  const merged = with_(now, { state: "merged" }, { merged: "dan" });
  await me.cards.round(target, at([merged]), live());
  expect(me.replies).toEqual([[root, "Merged by dan"]]);
  expect(tagOf(relay.headOf(d), "root")).toBe(root);
  expect(relay.headOf(d)?.pubkey).toBe(mike);
  expect(me.sent).toHaveLength(1);
});

it("never announces for a card someone else holds, and says so", async () => {
  const relay = fakeRelay();
  const d = await cardD();
  await relay.writer(mallory).publish(
    await relay.writer(mallory).sign({
      kind: 45010,
      created_at: 1,
      content: "{}",
      tags: [
        ["d", d],
        ["h", channel],
        ["op", "create"],
      ],
    }),
  );
  const me = device(relay);
  const outcome = await me.cards.round(target, at([read()]), live());
  expect(outcome.problems).toEqual([
    "#7's card is in use by someone else, so it is not kept.",
  ]);
  expect(me.sent).toEqual([]);
});

it("restores its card when someone deletes it, on its own root, as the relay does", async () => {
  const relay = fakeRelay();
  const me = device(relay);
  const now = read();
  await me.cards.round(target, at([now]), live());
  const d = await cardD();
  const root = tagOf(relay.headOf(d), "root");
  const deletion = relay.remove(d);
  const merged = with_(now, { state: "merged" }, { merged: "dan" });
  expect(await me.cards.round(target, at([merged]), live())).toMatchObject({
    again: false,
    problems: [],
  });
  const head = relay.headOf(d);
  expect(head?.pubkey).toBe(mike);
  expect(tagOf(head, "op")).toBe("restore");
  expect(tagOf(head, "prev")).toBe(deletion.id);
  expect(tagOf(head, "root")).toBe(root);
  expect(tagOf(head, "h")).toBe(channel);
  expect(JSON.parse(head?.content ?? "{}").state).toBe("merged");
  expect(me.replies).toEqual([[root, "Merged by dan"]]);
  expect(me.sent).toHaveLength(1);
});

it("moves its card back when someone moves it to another channel", async () => {
  const relay = fakeRelay();
  const me = device(relay);
  const now = read();
  await me.cards.round(target, at([now]), live());
  const d = await cardD();
  const root = tagOf(relay.headOf(d), "root");
  const moved = relay.move(d, "elsewhere");
  await me.cards.round(target, at([now]), live());
  const head = relay.headOf(d);
  expect(head?.pubkey).toBe(mike);
  expect(tagOf(head, "op")).toBe("move");
  expect(tagOf(head, "prev")).toBe(moved.id);
  expect(tagOf(head, "h")).toBe(channel);
  expect(tagOf(head, "root")).toBe(root);
  expect(me.sent).toHaveLength(1);
});

it("retires a card only when the relay won't put it back or it is out of reach", async () => {
  const relay = fakeRelay();
  const me = device(relay);
  const now = read();
  await me.cards.round(target, at([now]), live());
  const d = await cardD();
  relay.remove(d);
  relay.refuse("blocked: the revision was redacted");
  const refused = await me.cards.round(target, at([now]), live());
  expect(refused.problems).toEqual([
    "#7's card was deleted or moved, and the relay won't put it back (blocked: the revision was redacted), so it is no longer kept.",
  ]);
  expect(tagOf(relay.headOf(d), "op")).toBe("delete");
  relay.refuse(undefined);
  expect((await me.cards.round(target, at([now]), live())).problems).toEqual(
    refused.problems,
  );
  expect(tagOf(relay.headOf(d), "op")).toBe("delete");

  const other = fakeRelay();
  const you = device(other);
  await you.cards.round(target, at([now]), live());
  other.move(d, "private");
  other.hidden.add("private");
  expect((await you.cards.round(target, at([now]), live())).problems).toEqual([
    "#7's card is gone from this channel, so it is no longer kept.",
  ]);
  expect(you.sent).toHaveLength(1);
});

it("repairs another writer's revision however far back it dates itself", async () => {
  const relay = fakeRelay();
  const me = device(relay);
  const now = read();
  await me.cards.round(target, at([now]), live());
  const d = await cardD();
  const mine = relay.headOf(d) as EventData;
  relay.forge(
    d,
    (tags) => tags.filter(([name]) => name !== "root"),
    serialize({ ...now.pull, title: "Forged" }),
    { createdAt: mine.created_at - 1 },
  );
  await me.cards.round(target, at([now]), live());
  expect(relay.headOf(d)?.pubkey).toBe(mike);
  expect(tagOf(relay.headOf(d), "root")).toBe(tagOf(mine, "root"));
  expect(JSON.parse(relay.headOf(d)?.content ?? "{}").title).toBe(
    "Add the card",
  );
});

it("keeps its card from the revision it stored when others bury it deep in history", async () => {
  const relay = fakeRelay();
  const storage = memoryStorage();
  const me = device(relay, { storage });
  const now = read();
  await me.cards.round(target, at([now]), live());
  const d = await cardD();
  const root = tagOf(relay.headOf(d), "root");
  for (let count = 0; count < 501; count++)
    relay.forge(d, (tags) => tags, serialize({ ...now.pull, title: "Spam" }));
  const restarted = device(relay, { storage });
  expect(await restarted.cards.round(target, at([now]), live())).toMatchObject({
    again: false,
    problems: [],
  });
  expect(relay.headOf(d)?.pubkey).toBe(mike);
  expect(tagOf(relay.headOf(d), "root")).toBe(root);
  expect(restarted.sent).toEqual([]);

  const forgetful = device(relay);
  for (let count = 0; count < 501; count++)
    relay.forge(d, (tags) => tags, serialize({ ...now.pull, title: "Spam" }));
  expect(
    (await forgetful.cards.round(target, at([now]), live())).problems,
  ).toEqual(["#7's card is in use by someone else, so it is not kept."]);
});

it("reads only the heads of the cards a round names, however many artifacts the channel holds", async () => {
  const relay = fakeRelay();
  const me = device(relay);
  const eight = read({ url: `${url.slice(0, -1)}8`, number: 8 });
  await me.cards.round(target, at([read(), eight]), live());
  const heads = relay.filters.filter((filter) => filter.artifact === "head");
  expect(heads[0]).toEqual({
    kinds: [45010],
    "#d": [await cardD(), await cardD(eight.pull)],
    artifact: "head",
    limit: 2,
  });
});

it("keeps rooting the one announcement it posted until the relay holds it, across restarts", async () => {
  const relay = fakeRelay();
  const storage = memoryStorage();
  const first = device(relay, { storage, land: false });
  const now = read();
  for (let attempt = 1; attempt < ROOT_ATTEMPTS; attempt++)
    expect((await first.cards.round(target, at([now]), live())).again).toBe(
      true,
    );
  const late = await first.cards.round(target, at([now]), live());
  expect(late).toMatchObject({
    again: false,
    problems: ["#7's announcement hasn't reached the channel yet."],
  });
  await first.cards.round(target, at([now]), live());
  expect(first.sent).toHaveLength(1);
  const id = first.messages.send.mock.results[0]?.value as string;

  const restarted = device(relay, { storage });
  relay.messages.add(id);
  expect(await restarted.cards.round(target, at([now]), live())).toMatchObject({
    again: false,
    problems: [],
  });
  expect(restarted.sent).toEqual([]);
  expect(tagOf(relay.headOf(await cardD()), "root")).toBe(id);
});

it("announces once when two devices or two polls race for a new pull request", async () => {
  const relay = fakeRelay();
  const laptop = device(relay);
  const desktop = device(relay);
  const now = read();
  await Promise.all([
    laptop.cards.round(target, at([now]), live()),
    desktop.cards.round(target, at([now]), live()),
    laptop.cards.round(target, at([now]), live()),
  ]);
  expect(laptop.sent.length + desktop.sent.length).toBe(1);
  await laptop.cards.round(target, at([now]), live());
  await desktop.cards.round(target, at([now]), live());
  expect(laptop.sent.length + desktop.sent.length).toBe(1);
  expect(tagOf(relay.headOf(await cardD()), "root")).toBeTruthy();
});

it("drops what it wrote after a conflict and reads the head again", async () => {
  const relay = fakeRelay();
  let race = false;
  const me = device(relay, {
    before: (event) => {
      if (!race) return;
      race = false;
      relay.forge(
        tagOf(event, "d") ?? "",
        (tags) => tags,
        serialize({ ...now.pull, title: "Forged" }),
      );
    },
  });
  const now = read();
  await me.cards.round(target, at([now]), live());
  const d = await cardD();
  race = true;
  const changed = with_(now, { title: "Renamed" });
  await me.cards.round(target, at([changed]), live());
  expect(race).toBe(false);
  expect(relay.headOf(d)?.pubkey).toBe(mike);
  expect(JSON.parse(relay.headOf(d)?.content ?? "{}").title).toBe("Renamed");
  expect(relay.revisions.get(d)?.at(-2)?.pubkey).toBe(mallory);
});

it("posts nothing once its poll stops", async () => {
  const relay = fakeRelay();
  const stop = new AbortController();
  const me = device(relay, { before: () => stop.abort() });
  await expect(
    me.cards.round(target, at([read()]), stop.signal),
  ).rejects.toThrow();
  expect(me.sent).toEqual([]);

  const again = fakeRelay();
  const you = device(again);
  const now = read();
  await you.cards.round(target, at([now]), live());
  const halt = new AbortController();
  const late = device(again, {
    storage: you.storage,
    before: () => halt.abort(),
  });
  await expect(
    late.cards.round(
      target,
      at([with_(now, { state: "merged" }, { merged: "dan" })]),
      halt.signal,
    ),
  ).rejects.toThrow();
  expect(late.replies).toEqual([]);
});

it("keeps every other pull request when one fails", async () => {
  const relay = fakeRelay();
  const eight = read({ url: `${url.slice(0, -1)}8`, number: 8 });
  const failing = await cardD();
  const me = device(relay, {
    before: (event) => {
      if (tagOf(event, "d") === failing) throw new Error("socket closed");
    },
  });
  const outcome = await me.cards.round(target, at([read(), eight]), live());
  expect(outcome.problems).toEqual(["#7: socket closed"]);
  expect(relay.headOf(await cardD(eight.pull))?.pubkey).toBe(mike);
  expect(me.sent).toEqual([announcement(eight.pull)]);
});

afterEach(() => {
  vi.useRealTimers();
});

function fakeView(events: EventData[] = []) {
  const listeners = new Set<() => void>();
  const view = {
    state: { status: "live", events } as {
      status: string;
      events: EventData[];
      error?: string;
    },
    snapshot: () => view.state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose: vi.fn(),
    set(
      state: Partial<{ status: string; events: EventData[]; error: string }>,
    ) {
      view.state = { ...view.state, ...state };
      for (const listener of [...listeners]) listener();
    },
  };
  return view;
}

function runner(
  channels = [channel],
  relay = fakeRelay(),
  before?: (event: EventData) => void,
  storage = memoryStorage(),
  random = () => 0,
) {
  const hookEvent: EventData = {
    id: "1".repeat(64),
    pubkey: mike,
    created_at: hookMadeAt,
    kind: 45010,
    content: JSON.stringify({ version: 1, repo: "block/buzz-app" }),
    tags: [
      ["d", "hook-d"],
      ["h", channel],
      ["type", "github.hook"],
      ["repo", "block/buzz-app"],
      ["publisher", mike],
    ],
  };
  const hooks = fakeView([hookEvent]);
  const filters: Record<string, unknown>[] = [];
  const sent: string[] = [];
  const replies: string[] = [];
  const session = {
    viewer: mike,
    configArtifactWriter: relay.writer(mike, before),
    snapshotRead: relay.read,
    messages: {
      send: (_channel: string, content: string) => {
        sent.push(content);
        const id = "m".repeat(64);
        relay.messages.add(id);
        return id;
      },
      reply: (_channel: string, _root: string, content: string) => {
        replies.push(content);
        return "n".repeat(64);
      },
    },
    channels: {
      list: () => ({
        channels: channels.map((id) => ({
          id,
          channelType: "stream",
          members: [mike],
        })),
      }),
      subscribeList: () => () => {},
    },
    artifacts: {
      sync(filter: Record<string, unknown>) {
        filters.push(filter);
        return hooks;
      },
    },
  } as unknown as RelaySession;
  const relayData = {
    snapshot: () => ({
      status: "ready",
      session,
      origin: "https://buzz.example",
      scope: "https://buzz.example:mike",
    }),
    subscribe: () => () => {},
  } as unknown as RelayData;
  let answer: ReturnType<typeof node>[] = [node()];
  /** What GitHub answers for a pull request read by number. */
  let numbered = new Map<number, ReturnType<typeof node> | null>();
  const signals: AbortSignal[] = [];
  const gh = vi.fn(
    async (query: string, _vars: unknown, signal: AbortSignal) => {
      signals.push(signal);
      if (query.includes("pullRequest(number:")) {
        const repository = Object.fromEntries(
          [...query.matchAll(/p(\d+): pullRequest/g)].map(([, n]) => [
            `p${n}`,
            numbered.get(Number(n)) ?? null,
          ]),
        );
        if (Object.values(repository).includes(null))
          throw new GitHubError(
            "Could not resolve to a PullRequest.",
            "NOT_FOUND",
            { repository },
          );
        return { repository };
      }
      return { repository: { open: { nodes: answer }, done: { nodes: [] } } };
    },
  ) as unknown as GitHubCli;
  const status = createPublisherStatus();
  const stop = startPublisher(relayData, gh, status, storage, random);
  return {
    relay,
    hooks,
    hookEvent,
    filters,
    sent,
    replies,
    gh: gh as unknown as ReturnType<typeof vi.fn>,
    signals,
    status,
    stop,
    answer: (...next: ReturnType<typeof node>[]) => {
      answer = next;
    },
    numbered: (next: Map<number, ReturnType<typeof node> | null>) => {
      numbered = next;
    },
  };
}

it("keeps a hook's cards from this device: card, announcement, root, then replies", async () => {
  vi.useFakeTimers();
  const run = runner();
  expect(run.filters).toEqual([
    {
      artifact: "current",
      kinds: [45010],
      "#h": [channel],
      "#type": ["github.hook"],
    },
  ]);
  await vi.waitFor(() => expect(run.sent).toHaveLength(1));
  const d = await cardD();
  await vi.waitFor(() =>
    expect(tagOf(run.relay.headOf(d), "root")).toBe("m".repeat(64)),
  );
  expect(run.gh).toHaveBeenCalledWith(
    expect.stringContaining("pullRequests"),
    { owner: "block", name: "buzz-app" },
    expect.anything(),
  );
  run.answer(node({ state: "MERGED", mergedBy: { login: "dan" } }));
  await vi.advanceTimersByTimeAsync(POLL_MS);
  await vi.waitFor(() => expect(run.replies).toEqual(["Merged by dan"]));
  expect(run.sent).toHaveLength(1);
  expect(run.status.get(channel, "hook-d")).toBeUndefined();
  run.stop();
});

it("keeps polls through a reloading hook view, and says when the hook view fails", async () => {
  vi.useFakeTimers();
  const run = runner();
  await vi.waitFor(() => expect(run.gh).toHaveBeenCalled());
  const [first] = run.signals;

  run.hooks.set({ status: "loading", events: [] });
  expect(first?.aborted).toBe(false);
  run.hooks.set({
    status: "live",
    events: [{ ...run.hookEvent, id: "2".repeat(64) }],
  });
  expect(first?.aborted).toBe(true);
  expect(run.status.get(channel, "hook-d")).toBeUndefined();

  const calls = run.gh.mock.calls.length;
  run.hooks.set({
    status: "error",
    error: "error: sync set exceeds max_events",
  });
  expect(run.signals.at(-1)?.aborted).toBe(true);
  expect(run.status.get(channel, "hook-d")).toBe(
    "Publishing from this device stopped: the channels' hooks couldn't be read (error: sync set exceeds max_events).",
  );
  await vi.advanceTimersByTimeAsync(POLL_MS);
  expect(run.gh.mock.calls.length).toBe(calls);
  run.hooks.set({ status: "unsupported", events: [] });
  expect(run.status.get(channel, "hook-d")).toMatch(/needs a relay/);
  run.hooks.set({ status: "live", events: [] });
  expect(run.status.get(channel, "hook-d")).toBeUndefined();
  run.stop();
});

it("spreads each hook's first poll, so clients that reconnect together don't read at once", async () => {
  vi.useFakeTimers();
  const run = runner(
    [channel],
    fakeRelay(),
    undefined,
    memoryStorage(),
    () => 0.5,
  );
  await vi.advanceTimersByTimeAsync(START_SPREAD_MS / 2 - 1);
  expect(run.gh).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await vi.waitFor(() => expect(run.gh).toHaveBeenCalledTimes(1));
  run.stop();
});

it("follows hooks in every channel, each sync within the relay's 256 values per filter", () => {
  const many = Array.from(
    { length: 600 },
    (_, index) =>
      `${index.toString().padStart(8, "0")}-1111-4111-8111-111111111111`,
  );
  const run = runner([channel, ...many]);
  const values = run.filters.map(
    (filter) =>
      ((filter["#h"] as string[]) ?? []).length +
      ((filter["#type"] as string[]) ?? []).length,
  );
  expect(values).toEqual([256, 256, 601 - 2 * MAX_CHANNELS + 1]);
  expect(
    new Set(run.filters.flatMap((filter) => filter["#h"] as string[])),
  ).toEqual(new Set([channel, ...many]));
  run.stop();
});

it("takes a pull request's checks from GitHub's state for all of them, not only those read", () => {
  const rolled = (state: string, conclusion = "SUCCESS") =>
    read({
      commits: {
        nodes: [
          {
            commit: {
              statusCheckRollup: {
                state,
                contexts: {
                  nodes: [
                    {
                      __typename: "CheckRun",
                      name: "build",
                      status: "COMPLETED",
                      conclusion,
                    },
                  ],
                },
              },
            },
          },
        ],
      },
    }).pull.checks;
  // A failure past the first page of checks still fails the card.
  expect(rolled("FAILURE")).toEqual({
    state: "failure",
    runs: { build: "success" },
  });
  expect(rolled("PENDING").state).toBe("pending");
  expect(rolled("EXPECTED").state).toBe("pending");
  expect(rolled("ERROR").state).toBe("failure");
  expect(rolled("SUCCESS", "NEUTRAL").state).toBe("success");
});

it("reads pull requests by number, and finds them in the answer", () => {
  const query = numbersQuery([7, 12]);
  expect(query).toContain("p7: pullRequest(number: 7) { ...pull }");
  expect(query).toContain("p12: pullRequest(number: 12) { ...pull }");
  expect(
    readPulls(
      {
        repository: {
          p7: node(),
          p12: null,
          p8: node({ url: `${url.slice(0, -1)}8`, number: 8 }),
        },
      },
      "block/buzz-app",
    ).map((r) => r.pull.number),
  ).toEqual([7, 8]);
});

it("keeps a card it published current after its pull request leaves the newest, across a restart", async () => {
  vi.useFakeTimers();
  const relay = fakeRelay();
  const first = runner([channel], relay);
  const d = await cardD();
  await vi.waitFor(() =>
    expect(tagOf(relay.headOf(d), "root")).toBe("m".repeat(64)),
  );
  first.stop();

  // Buzz was closed while #7 merged and newer pull requests pushed it out of
  // the ones read by update time.
  const later = runner([channel], relay);
  later.answer();
  later.numbered(
    new Map([[7, node({ state: "MERGED", mergedBy: { login: "dan" } })]]),
  );
  await vi.waitFor(() => expect(later.replies).toEqual(["Merged by dan"]));
  expect(tagOf(relay.headOf(d), "status")).toBe("merged");
  expect(
    later.gh.mock.calls.some(([query]) =>
      String(query).includes("p7: pullRequest(number: 7)"),
    ),
  ).toBe(true);

  // A closed card is read no more.
  const calls = later.gh.mock.calls.length;
  await vi.advanceTimersByTimeAsync(POLL_MS);
  expect(later.gh.mock.calls.length).toBe(calls + 1);
  later.stop();
});

it("keeps reading a card it published until its merge is written", async () => {
  vi.useFakeTimers();
  const relay = fakeRelay();
  const first = runner([channel], relay);
  const d = await cardD();
  await vi.waitFor(() =>
    expect(tagOf(relay.headOf(d), "root")).toBe("m".repeat(64)),
  );
  first.stop();

  let offline = true;
  const later = runner([channel], relay, () => {
    if (offline) throw new Error("offline");
  });
  later.answer();
  later.numbered(
    new Map([[7, node({ state: "MERGED", mergedBy: { login: "dan" } })]]),
  );
  await vi.waitFor(() =>
    expect(later.status.get(channel, "hook-d")).toContain("offline"),
  );
  offline = false;
  await vi.advanceTimersByTimeAsync(POLL_MS);
  await vi.waitFor(() => expect(later.replies).toEqual(["Merged by dan"]));
  expect(tagOf(relay.headOf(d), "status")).toBe("merged");
  later.stop();
});

it("keeps every other card current when GitHub can't find one of them", async () => {
  vi.useFakeTimers();
  const relay = fakeRelay();
  const other = "https://github.com/block/buzz-app/pull/8";
  const first = runner([channel], relay);
  first.answer(node(), node({ number: 8, url: other }));
  const d = await cardD();
  await vi.waitFor(() => expect(tagOf(relay.headOf(d), "root")).toBeTruthy());
  first.stop();

  const later = runner([channel], relay);
  later.answer();
  later.numbered(
    new Map([[7, node({ state: "MERGED", mergedBy: { login: "dan" } })]]),
  );
  await vi.waitFor(() => expect(later.replies).toEqual(["Merged by dan"]));
  expect(later.status.get(channel, "hook-d")).toBeUndefined();
  later.stop();
});

it("keeps reconciling a card someone else wrote on top of, on any device", async () => {
  vi.useFakeTimers();
  const relay = fakeRelay();
  const first = runner([channel], relay);
  const d = await cardD();
  await vi.waitFor(() =>
    expect(tagOf(relay.headOf(d), "root")).toBe("m".repeat(64)),
  );
  first.stop();
  relay.forge(
    d,
    (tags) => tags,
    serialize({ ...read().pull, title: "Edited" }),
  );

  const later = runner([channel], relay);
  later.answer();
  later.numbered(
    new Map([[7, node({ state: "MERGED", mergedBy: { login: "dan" } })]]),
  );
  await vi.waitFor(() => expect(later.replies).toEqual(["Merged by dan"]));
  expect(relay.headOf(d)?.pubkey).toBe(mike);
  expect(tagOf(relay.headOf(d), "status")).toBe("merged");
  later.stop();
});

it("keeps reconciling a card someone else marked done, on the device that kept it", async () => {
  vi.useFakeTimers();
  const relay = fakeRelay();
  const storage = memoryStorage();
  const first = runner([channel], relay, undefined, storage);
  const d = await cardD();
  await vi.waitFor(() =>
    expect(tagOf(relay.headOf(d), "root")).toBe("m".repeat(64)),
  );
  await vi.advanceTimersByTimeAsync(POLL_MS);
  await vi.waitFor(() =>
    expect(
      [...storage.items]
        .filter(([key]) => key.startsWith("buzz.github.publisher.open"))
        .join(),
    ).toContain("/pull/7"),
  );
  first.stop();
  relay.forge(
    d,
    (tags) =>
      tags.map((entry) =>
        entry[0] === "state" || entry[0] === "status"
          ? [entry[0], "closed"]
          : entry,
      ),
    serialize({ ...read().pull, state: "closed" }),
  );

  const later = runner([channel], relay, undefined, storage);
  later.answer();
  later.numbered(
    new Map([[7, node({ state: "MERGED", mergedBy: { login: "dan" } })]]),
  );
  await vi.waitFor(() => expect(later.replies).toEqual(["Merged by dan"]));
  expect(relay.headOf(d)?.pubkey).toBe(mike);
  expect(tagOf(relay.headOf(d), "status")).toBe("merged");
  later.stop();
});

it("never applies a read older than the card another of its devices wrote", async () => {
  const relay = fakeRelay();
  const laptop = device(relay);
  const desktop = device(relay);
  const now = read();
  await laptop.cards.round(target, at([now], 1_000), live());
  const d = await cardD();
  const merged = with_(
    now,
    { state: "merged", updated_at: "2026-11-05T11:00:00Z" },
    { merged: "dan" },
  );
  await laptop.cards.round(target, at([merged], 3_000), live());
  expect(laptop.replies.map(([, text]) => text)).toEqual(["Merged by dan"]);
  const written = relay.revisions.get(d)?.length;

  // The desktop read GitHub before the merge, and writes only now.
  await desktop.cards.round(target, at([now], 2_000), live());
  // Or read it after, with nothing GitHub dates newer, but before the laptop.
  await desktop.cards.round(
    target,
    at([with_(merged, { checks: { state: "failure", runs: {} } })], 2_500),
    live(),
  );
  expect(relay.revisions.get(d)).toHaveLength(written ?? 0);
  expect(tagOf(relay.headOf(d), "status")).toBe("merged");
  expect(desktop.replies).toEqual([]);
  expect(desktop.sent).toEqual([]);

  expect(isStale(merged.pull, 3_000, now.pull, 9_000)).toBe(true);
  expect(isStale(now.pull, 3_000, merged.pull, 1)).toBe(false);
  expect(isStale(now.pull, undefined, now.pull, 1)).toBe(false);
});

it("never announces again when storage refuses the posted ID", async () => {
  vi.useFakeTimers();
  const relay = fakeRelay();
  const storage = memoryStorage();
  const full = {
    ...storage,
    setItem: (key: string, value: string) => {
      if (key.includes(".pending:") || key.includes(".own:"))
        throw new DOMException("full", "QuotaExceededError");
      return storage.setItem(key, value);
    },
  };
  const me = device(relay, { storage: full, land: false });
  const now = read();
  expect((await me.cards.round(target, at([now]), live())).again).toBe(true);
  expect((await me.cards.round(target, at([now]), live())).again).toBe(true);
  expect(me.sent).toHaveLength(1);

  // A restart loses what only memory held; the outbox may still deliver.
  const restarted = device(relay, { storage: full, land: false });
  await restarted.cards.round(target, at([now]), live());
  expect(restarted.sent).toEqual([]);
  const [id] = relay.posts.keys();
  if (!id) throw new Error("not posted");
  relay.messages.add(id);
  await restarted.cards.round(target, at([now]), live());
  expect(tagOf(relay.headOf(await cardD()), "root")).toBe(id);
  expect(restarted.sent).toEqual([]);
});

it("takes over an announcement another device claimed and never posted", async () => {
  vi.useFakeTimers();
  const relay = fakeRelay();
  const laptop = device(relay);
  laptop.messages.send.mockImplementationOnce(() => {
    throw new Error("quit before posting");
  });
  const now = read();
  await laptop.cards.round(target, at([now]), live());
  expect(laptop.sent).toEqual([]);

  const desktop = device(relay);
  const waiting = await desktop.cards.round(target, at([now]), live());
  expect(waiting.problems.join(" ")).toContain("waiting on another device");
  vi.setSystemTime(Date.now() + ABANDONED_CLAIM_S * 1000);
  await desktop.cards.round(target, at([now]), live());
  expect(desktop.sent).toEqual([announcement(now.pull)]);
  expect(tagOf(relay.headOf(await cardD()), "root")).toBe(
    desktop.messages.send.mock.results[0]?.value,
  );
});

it("roots on another device's announcement when that device lost it", async () => {
  vi.useFakeTimers();
  const relay = fakeRelay();
  const laptop = device(relay, {
    before: (event) => {
      if (tagOf(event, "announcing")) return;
      throw new Error("offline");
    },
  });
  const now = read();
  await laptop.cards.round(target, at([now]), live());
  expect(laptop.sent).toEqual([announcement(now.pull)]);

  const desktop = device(relay);
  vi.setSystemTime(Date.now() + ABANDONED_CLAIM_S * 1000);
  await desktop.cards.round(target, at([now]), live());
  expect(desktop.sent).toEqual([]);
  expect(tagOf(relay.headOf(await cardD()), "root")).toBe(
    laptop.messages.send.mock.results[0]?.value,
  );
});

it("announces again after a restart only once its claimed announcement can't still be on its way", async () => {
  vi.useFakeTimers();
  const relay = fakeRelay();
  const storage = memoryStorage();
  const me = device(relay, {
    storage,
    before: (event) => {
      if (tagOf(event, "announcing")) return;
      throw new Error("offline");
    },
  });
  me.messages.send.mockImplementationOnce(() => {
    throw new Error("quit before posting");
  });
  const now = read();
  await me.cards.round(target, at([now]), live());
  expect(me.sent).toEqual([]);

  const restarted = device(relay, { storage });
  await restarted.cards.round(target, at([now]), live());
  expect(restarted.sent).toEqual([]);
  vi.setSystemTime(Date.now() + ANNOUNCE_GRACE_S * 1000);
  await restarted.cards.round(target, at([now]), live());
  expect(restarted.sent).toEqual([announcement(now.pull)]);
  expect(tagOf(relay.headOf(await cardD()), "root")).toBe(
    restarted.messages.send.mock.results[0]?.value,
  );
});
