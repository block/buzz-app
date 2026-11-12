import { afterEach, expect, it, vi } from "vitest";
import type { EventData, ReadFilter } from "../../features/relay/events";
import { PublishRejected } from "../../features/relay/outbox";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import type { GitHubCli } from "./gh";
import type { Hook } from "./hooks";
import {
  POLL_MS,
  ROOT_ATTEMPTS,
  announcement,
  cardTags,
  changes,
  checksState,
  createCards,
  createPublisherStatus,
  isFresh,
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

it("reads a pull request as the relay's card content, field for field", () => {
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

it("settles checks by the relay's rule", () => {
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

it("names each card under a key only its publisher holds, as a UUIDv8", async () => {
  const key = "ab".repeat(32);
  const d = await pullId(key, channel, url);
  expect(d).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  expect(await pullId(key, channel, url)).toBe(d);
  expect(await pullId("cd".repeat(32), channel, url)).not.toBe(d);
  expect(await pullId(key, channel, `${url}0`)).not.toBe(d);
});

it("tags and announces a card as the relay does", () => {
  const { pull } = read({ title: "Fix @here" });
  expect(cardTags("d1", channel, "hook-d", pull, "update", "p", "r")).toEqual([
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
    "me",
  );
  expect(tags).toContainEqual(["announcing", "me"]);
});

const mike = "c".repeat(64);
const mallory = "e".repeat(64);
const hookKey = "ab".repeat(32);
const tagOf = (event: EventData | undefined, name: string) =>
  event?.tags.find((entry) => entry[0] === name)?.[1];

/** A relay holding artifacts the way NIP-AR does: any channel writer may
 * write any revision whose `prev` is the head, a deletion takes only a
 * `restore` in its channel, and a `root` must name a message the relay
 * holds. Channels in `hidden` are ones the reader can't read. */
function fakeRelay() {
  const revisions = new Map<string, EventData[]>();
  const messages = new Set<string>();
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
    if (filter.artifact === "history") {
      const [h] = filter["#h"] as string[];
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
    hookKey: async () => hookKey,
  };
  return { cards: createCards(deps), sent, replies, messages, storage };
}

const live = () => new AbortController().signal;

async function cardD(pull = read().pull) {
  return pullId(hookKey, channel, pull.url);
}

it("starts a card, announces it once and roots the card on it", async () => {
  const relay = fakeRelay();
  const me = device(relay);
  const now = read();
  expect(await me.cards.round(target, [now], live())).toEqual({
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
  await me.cards.round(target, [now], live());
  expect(relay.revisions.get(d)).toHaveLength(2);
});

it("puts its own root back when someone strips it, and never announces again", async () => {
  const relay = fakeRelay();
  const me = device(relay);
  const now = read();
  await me.cards.round(target, [now], live());
  const d = await cardD();
  const root = tagOf(relay.headOf(d), "root");
  for (let minute = 0; minute < 3; minute++) {
    relay.forge(d, (tags) => tags.filter(([name]) => name !== "root"));
    await me.cards.round(target, [now], live());
    expect(relay.headOf(d)?.pubkey).toBe(mike);
    expect(tagOf(relay.headOf(d), "root")).toBe(root);
  }
  expect(me.sent).toHaveLength(1);
});

it("keeps replies and the card on its own announcement when someone points the root elsewhere", async () => {
  const relay = fakeRelay();
  const me = device(relay);
  const now = read();
  await me.cards.round(target, [now], live());
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
  await me.cards.round(target, [merged], live());
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
  const outcome = await me.cards.round(target, [read()], live());
  expect(outcome.problems).toEqual([
    "#7's card is in use by someone else, so it is not kept.",
  ]);
  expect(me.sent).toEqual([]);
});

it("restores its card when someone deletes it, on its own root, as the relay does", async () => {
  const relay = fakeRelay();
  const me = device(relay);
  const now = read();
  await me.cards.round(target, [now], live());
  const d = await cardD();
  const root = tagOf(relay.headOf(d), "root");
  const deletion = relay.remove(d);
  const merged = with_(now, { state: "merged" }, { merged: "dan" });
  expect(await me.cards.round(target, [merged], live())).toEqual({
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
  await me.cards.round(target, [now], live());
  const d = await cardD();
  const root = tagOf(relay.headOf(d), "root");
  const moved = relay.move(d, "elsewhere");
  await me.cards.round(target, [now], live());
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
  await me.cards.round(target, [now], live());
  const d = await cardD();
  relay.remove(d);
  relay.refuse("blocked: the revision was redacted");
  const refused = await me.cards.round(target, [now], live());
  expect(refused.problems).toEqual([
    "#7's card was deleted or moved, and the relay won't put it back (blocked: the revision was redacted), so it is no longer kept.",
  ]);
  expect(tagOf(relay.headOf(d), "op")).toBe("delete");
  relay.refuse(undefined);
  expect((await me.cards.round(target, [now], live())).problems).toEqual(
    refused.problems,
  );
  expect(tagOf(relay.headOf(d), "op")).toBe("delete");

  const other = fakeRelay();
  const you = device(other);
  await you.cards.round(target, [now], live());
  other.move(d, "private");
  other.hidden.add("private");
  expect((await you.cards.round(target, [now], live())).problems).toEqual([
    "#7's card is gone from this channel, so it is no longer kept.",
  ]);
  expect(you.sent).toHaveLength(1);
});

it("repairs another writer's revision however far back it dates itself", async () => {
  const relay = fakeRelay();
  const me = device(relay);
  const now = read();
  await me.cards.round(target, [now], live());
  const d = await cardD();
  const mine = relay.headOf(d) as EventData;
  relay.forge(
    d,
    (tags) => tags.filter(([name]) => name !== "root"),
    serialize({ ...now.pull, title: "Forged" }),
    { createdAt: mine.created_at - 1 },
  );
  await me.cards.round(target, [now], live());
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
  await me.cards.round(target, [now], live());
  const d = await cardD();
  const root = tagOf(relay.headOf(d), "root");
  for (let count = 0; count < 501; count++)
    relay.forge(d, (tags) => tags, serialize({ ...now.pull, title: "Spam" }));
  const restarted = device(relay, { storage });
  expect(await restarted.cards.round(target, [now], live())).toEqual({
    again: false,
    problems: [],
  });
  expect(relay.headOf(d)?.pubkey).toBe(mike);
  expect(tagOf(relay.headOf(d), "root")).toBe(root);
  expect(restarted.sent).toEqual([]);

  const forgetful = device(relay);
  for (let count = 0; count < 501; count++)
    relay.forge(d, (tags) => tags, serialize({ ...now.pull, title: "Spam" }));
  expect((await forgetful.cards.round(target, [now], live())).problems).toEqual(
    ["#7's card is in use by someone else, so it is not kept."],
  );
});

it("reads only the heads of the cards a round names, however many artifacts the channel holds", async () => {
  const relay = fakeRelay();
  const me = device(relay);
  const eight = read({ url: `${url.slice(0, -1)}8`, number: 8 });
  await me.cards.round(target, [read(), eight], live());
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
    expect((await first.cards.round(target, [now], live())).again).toBe(true);
  const late = await first.cards.round(target, [now], live());
  expect(late).toEqual({
    again: false,
    problems: ["#7's announcement hasn't reached the channel yet."],
  });
  await first.cards.round(target, [now], live());
  expect(first.sent).toHaveLength(1);
  const id = first.messages.send.mock.results[0]?.value as string;

  const restarted = device(relay, { storage });
  relay.messages.add(id);
  expect(await restarted.cards.round(target, [now], live())).toEqual({
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
    laptop.cards.round(target, [now], live()),
    desktop.cards.round(target, [now], live()),
    laptop.cards.round(target, [now], live()),
  ]);
  expect(laptop.sent.length + desktop.sent.length).toBe(1);
  await laptop.cards.round(target, [now], live());
  await desktop.cards.round(target, [now], live());
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
  await me.cards.round(target, [now], live());
  const d = await cardD();
  race = true;
  const changed = with_(now, { title: "Renamed" });
  await me.cards.round(target, [changed], live());
  expect(race).toBe(false);
  expect(relay.headOf(d)?.pubkey).toBe(mike);
  expect(JSON.parse(relay.headOf(d)?.content ?? "{}").title).toBe("Renamed");
  expect(relay.revisions.get(d)?.at(-2)?.pubkey).toBe(mallory);
});

it("posts nothing once its poll stops", async () => {
  const relay = fakeRelay();
  const stop = new AbortController();
  const me = device(relay, { before: () => stop.abort() });
  await expect(me.cards.round(target, [read()], stop.signal)).rejects.toThrow();
  expect(me.sent).toEqual([]);

  const again = fakeRelay();
  const you = device(again);
  const now = read();
  await you.cards.round(target, [now], live());
  const halt = new AbortController();
  const late = device(again, {
    storage: you.storage,
    before: () => halt.abort(),
  });
  await expect(
    late.cards.round(
      target,
      [with_(now, { state: "merged" }, { merged: "dan" })],
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
  const outcome = await me.cards.round(target, [read(), eight], live());
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

function runner(channels = [channel]) {
  const relay = fakeRelay();
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
    configArtifactWriter: relay.writer(mike),
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
  let answer = node();
  const signals: AbortSignal[] = [];
  const gh = vi.fn(
    async (_query: string, _vars: unknown, signal: AbortSignal) => {
      signals.push(signal);
      return { repository: { open: { nodes: [answer] }, done: { nodes: [] } } };
    },
  ) as unknown as GitHubCli;
  const status = createPublisherStatus();
  const stop = startPublisher(
    relayData,
    gh,
    status,
    async () => hookKey,
    memoryStorage(),
  );
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
    answer: (next: ReturnType<typeof node>) => {
      answer = next;
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

it("keeps each sync within the relay's 256 values per filter", () => {
  const many = Array.from(
    { length: 300 },
    (_, index) =>
      `${index.toString().padStart(8, "0")}-1111-4111-8111-111111111111`,
  );
  const run = runner([channel, ...many]);
  const values = run.filters.map(
    (filter) =>
      ((filter["#h"] as string[]) ?? []).length +
      ((filter["#type"] as string[]) ?? []).length,
  );
  expect(values[0]).toBe(256);
  expect(Math.max(...values)).toBeLessThanOrEqual(256);
  run.stop();
});
