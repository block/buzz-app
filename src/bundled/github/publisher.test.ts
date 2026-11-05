import { expect, it, vi } from "vitest";
import type { EventData } from "../../features/relay/events";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import type { GitHubCli } from "./gh";
import {
  POLL_MS,
  announcement,
  cardTags,
  checksState,
  plan,
  pullId,
  readPull,
  readPulls,
  serialize,
  startPublisher,
  type Pull,
  type Read,
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

const card = (
  pull: Pull,
  extra: { root?: string | undefined; ours?: boolean } = {},
) => ({
  pull,
  root: "r".repeat(64),
  ours: true,
  ...extra,
});
const with_ = (base: Read, pull: Partial<Pull>, actors = base.actors) => ({
  pull: { ...base.pull, ...pull },
  actors,
});
const hookMadeAt = Date.parse("2026-11-05T09:00:00Z") / 1000;

it("starts a card and its announcement only for an open pull request changed since the hook was made", () => {
  const open = read();
  expect(plan(undefined, open, hookMadeAt)).toEqual({
    write: open.pull,
    announce: true,
    replies: [],
  });
  expect(plan(undefined, open, hookMadeAt + 7200)).toEqual({
    announce: false,
    replies: [],
  });
  expect(plan(undefined, with_(open, { state: "merged" }), hookMadeAt)).toEqual(
    { announce: false, replies: [] },
  );
});

it("writes a card only when it changed, and replies in its thread as the relay does", () => {
  const before = read();
  expect(plan(card(before.pull), before, hookMadeAt)).toEqual({
    announce: false,
    replies: [],
  });
  const merged = with_(before, { state: "merged" }, { merged: "dan" });
  expect(plan(card(before.pull), merged, hookMadeAt)).toEqual({
    write: merged.pull,
    announce: false,
    replies: ["Merged by dan"],
  });
  const reviewed = with_(before, {
    reviews: { ana: "approved", bo: "changes_requested", "@x": "approved" },
  });
  expect(plan(card(before.pull), reviewed, hookMadeAt).replies).toEqual([
    "bo requested changes",
    "@⁠x approved",
  ]);
  const ready = with_(before, { state: "open" });
  expect(
    plan(card({ ...before.pull, state: "draft" }), ready, hookMadeAt).replies,
  ).toEqual(["Ready for review"]);
  expect(
    plan(card(before.pull), with_(before, { state: "closed" }, {}), hookMadeAt)
      .replies,
  ).toEqual(["Closed"]);
});

it("puts back a card someone else wrote, without replying from their version", () => {
  const now = read();
  const forged = { ...now.pull, state: "merged" as const };
  expect(plan(card(forged, { ours: false }), now, hookMadeAt)).toEqual({
    write: now.pull,
    announce: false,
    replies: [],
  });
});

it("announces a card that has no root yet", () => {
  const now = read();
  expect(plan(card(now.pull, { root: undefined }), now, hookMadeAt)).toEqual({
    announce: true,
    replies: [],
  });
});

it("names each card the same way on every device, as a UUIDv8", async () => {
  const d = await pullId(channel, "hook-d", url);
  expect(d).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  expect(await pullId(channel, "hook-d", url)).toBe(d);
  expect(await pullId(channel, "other", url)).not.toBe(d);
});

it("tags and announces a card as the relay does", () => {
  const { pull } = read({ title: "Fix @here" });
  expect(cardTags("d1", channel, "hook-d", pull, "update", "p", "r")).toEqual([
    ["ar", "1"],
    ["d", "d1"],
    ["h", channel],
    ["type", "buzz.github.pull"],
    ["title", "#7 · Fix @here"],
    ["op", "update"],
    ["r", url],
    ["repo", "block/buzz-app"],
    ["hook", "hook-d"],
    ["sha", "c0ffee"],
    ["state", "open"],
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

function gate() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("keeps a hook's cards from this device: card, announcement, root, then replies", async () => {
  vi.useFakeTimers();
  try {
    const mike = "c".repeat(64);
    const hookEvent = {
      id: "1".repeat(64),
      pubkey: mike,
      created_at: hookMadeAt,
      kind: 45010,
      sig: "",
      content: JSON.stringify({ version: 1, repo: "block/buzz-app" }),
      tags: [
        ["d", "hook-d"],
        ["h", channel],
        ["type", "buzz.github.hook"],
        ["repo", "block/buzz-app"],
        ["publisher", mike],
      ],
    };
    let cards: EventData[] = [];
    const filters: Record<string, unknown>[] = [];
    let ids = 0;
    // The poll's own work (gh, SHA-256, reads) resolves outside fake time, so
    // each step is awaited by the write that ends it, not by a clock.
    const signed = [gate(), gate(), gate()];
    const sign = vi.fn(async (template: Omit<EventData, "id" | "pubkey">) => {
      const event = {
        ...template,
        id: String(++ids).padStart(64, "a"),
        pubkey: mike,
        sig: "",
      };
      signed[ids - 1]?.resolve();
      return event;
    });
    const send = vi.fn(() => "m".repeat(64));
    const replied = gate();
    const reply = vi.fn(() => {
      replied.resolve();
      return "n".repeat(64);
    });
    const session = {
      viewer: mike,
      configArtifactWriter: { sign, publish: vi.fn(async () => "") },
      snapshotRead: vi.fn(async () => []),
      messages: { send, reply },
      channels: {
        list: () => ({
          channels: [{ id: channel, channelType: "stream", members: [mike] }],
        }),
        subscribeList: () => () => {},
      },
      artifacts: {
        sync(filter: Record<string, unknown>) {
          filters.push(filter);
          const hooks = (filter["#type"] as string[])[0] === "buzz.github.hook";
          return {
            snapshot: () => ({
              status: "live",
              events: hooks ? [hookEvent] : cards,
            }),
            subscribe: (listener: () => void) => {
              if (hooks) queueMicrotask(listener);
              return () => {};
            },
            dispose() {},
          };
        },
      },
    } as unknown as RelaySession;
    const relay = {
      snapshot: () => ({ status: "ready", session }),
      subscribe: () => () => {},
    } as unknown as RelayData;
    let answer = node();
    const gh = vi.fn(async () => ({
      repository: { open: { nodes: [answer] }, done: { nodes: [] } },
    })) as unknown as GitHubCli;

    const stop = startPublisher(relay, gh);
    await vi.advanceTimersByTimeAsync(0);
    expect(filters[1]).toMatchObject({
      "#h": [channel],
      "#type": ["buzz.github.pull"],
      "#hook": ["hook-d"],
    });
    await signed[1]?.promise;
    await vi.advanceTimersByTimeAsync(0);
    expect(gh).toHaveBeenCalledWith(
      expect.stringContaining("pullRequests"),
      { owner: "block", name: "buzz-app" },
      expect.anything(),
    );
    const [created, rooted] = await Promise.all(
      sign.mock.results.map((result) => result.value),
    );
    const tagOf = (event: EventData | undefined, name: string) =>
      event?.tags.find((entry) => entry[0] === name)?.[1];
    expect(tagOf(created, "op")).toBe("create");
    expect(tagOf(created, "root")).toBeUndefined();
    expect(send).toHaveBeenCalledWith(channel, `#7 · Add the card\n${url}`);
    expect(tagOf(rooted, "op")).toBe("update");
    expect(tagOf(rooted, "prev")).toBe(created?.id);
    expect(tagOf(rooted, "root")).toBe("m".repeat(64));

    cards = [rooted as EventData];
    answer = node({ state: "MERGED", mergedBy: { login: "dan" } });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await signed[2]?.promise;
    await replied.promise;
    expect(sign).toHaveBeenCalledTimes(3);
    expect(send).toHaveBeenCalledOnce();
    expect(reply).toHaveBeenCalledWith(
      channel,
      "m".repeat(64),
      "Merged by dan",
    );
    stop();
  } finally {
    vi.useRealTimers();
  }
});
