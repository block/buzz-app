// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import type { RelaySession } from "../../features/relay/session";
import type { EventData } from "../../features/relay/events";
import { uuidv5 } from "../../features/agents/agent-config-artifacts";
import type { ReadFilter } from "../../features/relay/events";
import { createRelaySession } from "../../features/relay/session";
import { keypair } from "../../features/relay/testing";
import { PublishRejected } from "../../features/relay/outbox";
import type { GitHubCli } from "./gh";
import { createPullStates, PULL_REFRESH_MS } from "./pull-states";
import {
  createSoloPulls,
  linkPull,
  linksOf,
  SOLO_PULL_TYPE,
  SOLO_REFRESH_MS,
  unlinkPull,
  writeLinks,
} from "./solo-pull";

const chat = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const pull = "https://github.com/block/buzz-app/pull/7";
const second = "https://github.com/block/buzz/pull/9";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const revision = (
  channel: string,
  url: string | null | readonly string[],
  extra: Partial<EventData> = {},
) => ({
  id: `${channel.slice(0, 8)}${"e".repeat(56)}`,
  pubkey: "c".repeat(64),
  sig: "",
  created_at: 1,
  kind: 45010,
  content: JSON.stringify(
    Array.isArray(url)
      ? { version: 2, url: url[0] ?? null, urls: url }
      : { version: 1, url },
  ),
  tags: [
    ["ar", "1"],
    ["d", "d"],
    ["h", channel],
    ["type", SOLO_PULL_TYPE],
    ["title", "Pull request"],
    ["op", "create"],
  ],
  ...extra,
});

function session(heads: ReturnType<typeof revision>[] = []) {
  const snapshotRead = vi.fn(
    async (_filters: unknown, _options?: unknown) => heads,
  );
  const sign = vi.fn(async (template: object) => ({
    ...template,
    id: "f".repeat(64),
    pubkey: "c".repeat(64),
    sig: "",
  }));
  const publish = vi.fn(async () => "");
  return {
    snapshotRead,
    sign,
    publish,
    session: {
      snapshotRead,
      configArtifactWriter: { sign, publish },
    } as unknown as RelaySession,
  };
}

it("reads links only from a Solo pull request revision", () => {
  expect(linksOf(revision(chat, pull))).toEqual([pull]);
  expect(linksOf(revision(chat, null))).toEqual([]);
  expect(linksOf(revision(chat, [pull, second]))).toEqual([pull, second]);
  // A list wins over the first-link field older clients read, and drops
  // repeats and what isn't a pull request.
  expect(
    linksOf({
      ...revision(chat, pull),
      content: JSON.stringify({
        version: 2,
        url: pull,
        urls: [second, "https://github.com/block/buzz-app", second],
      }),
    }),
  ).toEqual([second]);
  expect(linksOf(revision(chat, []))).toEqual([]);
  expect(linksOf(revision(chat, "https://github.com/block/buzz-app"))).toBe(
    undefined,
  );
  expect(
    linksOf({
      ...revision(chat, pull),
      tags: [["type", "buzz.agent.settings"]],
    }),
  ).toBeUndefined();
  expect(linksOf({ ...revision(chat, pull), content: "{" })).toBeUndefined();
});

it("adds and removes a chat's pull requests in one artifact", async () => {
  const empty = session();
  expect(await writeLinks(empty.session, chat, linkPull(pull))).toEqual([pull]);
  expect(empty.snapshotRead).toHaveBeenCalledWith(
    [
      expect.objectContaining({
        kinds: [45010],
        "#h": [chat],
        "#d": [expect.stringMatching(/^[0-9a-f-]{36}$/)],
        artifact: "current",
      }),
    ],
    expect.anything(),
  );
  const created = empty.sign.mock.calls[0]?.[0] as EventData;
  expect(created.tags).toEqual([
    ["ar", "1"],
    ["d", expect.stringMatching(/^[0-9a-f-]{36}$/)],
    ["h", chat],
    ["type", SOLO_PULL_TYPE],
    ["title", "Pull request"],
    ["op", "create"],
  ]);
  expect(JSON.parse(created.content)).toEqual({
    version: 2,
    url: pull,
    urls: [pull],
  });
  expect(empty.publish).toHaveBeenCalledOnce();

  // Each change applies to the head it reads, so a link another device added
  // since stays linked.
  const linked = session([revision(chat, pull)]);
  expect(await writeLinks(linked.session, chat, linkPull(pull))).toEqual([
    pull,
  ]);
  expect(linked.sign).not.toHaveBeenCalled();
  expect(await writeLinks(linked.session, chat, linkPull(second))).toEqual([
    pull,
    second,
  ]);
  expect(await writeLinks(linked.session, chat, unlinkPull(pull))).toEqual([]);
  expect(await writeLinks(linked.session, chat, unlinkPull())).toEqual([]);
  const [added, removed, cleared] = linked.sign.mock.calls.map(
    ([event]) => event as EventData,
  );
  expect(added?.tags).toContainEqual(["op", "update"]);
  expect(added?.tags).toContainEqual(["prev", revision(chat, pull).id]);
  expect(JSON.parse(added?.content ?? "")).toEqual({
    version: 2,
    url: pull,
    urls: [pull, second],
  });
  expect(JSON.parse(removed?.content ?? "")).toEqual({
    version: 2,
    url: null,
    urls: [],
  });
  expect(JSON.parse(cleared?.content ?? "")).toEqual({
    version: 2,
    url: null,
    urls: [],
  });

  // Nothing to unlink writes nothing; without a writer it says why.
  await writeLinks(empty.session, other, unlinkPull());
  expect(empty.sign).toHaveBeenCalledOnce();
  await expect(
    writeLinks({} as RelaySession, chat, linkPull(pull)),
  ).rejects.toThrow("can't save pull request links");
});

const rollup = (state: string, checks?: string) => ({
  pullRequest: {
    state,
    isDraft: false,
    mergeStateStatus: "CLEAN",
    commits: {
      nodes: [
        { commit: { statusCheckRollup: checks ? { state: checks } : null } },
      ],
    },
  },
});
/** Solo pull requests over a store with `gh`, or the public API without. */
const pullsOver = (relay: RelaySession, gh?: GitHubCli) =>
  createSoloPulls(relay, createPullStates(gh));

it("shows every shown chat's linked pull request from one shared read", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const relay = session([revision(chat, pull), revision(other, pull)]);
  const gh = vi.fn(async () => ({
    r0: rollup("OPEN", "FAILURE"),
  })) as unknown as GitHubCli & ReturnType<typeof vi.fn>;
  const pulls = pullsOver(relay.session, gh);
  const changed = vi.fn();
  const stop = [
    pulls.watch(chat, changed),
    pulls.watch(other, changed),
    pulls.watch("33333333-3333-4333-8333-333333333333", changed),
  ];
  await vi.waitFor(() => expect(pulls.get(other)?.[0]?.state).toBeDefined());
  expect(relay.snapshotRead).toHaveBeenCalledOnce();
  expect(relay.snapshotRead.mock.calls[0]?.[0]).toEqual([
    expect.objectContaining({
      "#h": [chat, other, "33333333-3333-4333-8333-333333333333"],
    }),
  ]);
  // Two chats linking one pull request cost one read of it.
  expect(gh).toHaveBeenCalledOnce();
  expect(gh.mock.calls[0]?.[1]).toEqual({ o0: "block", n0: "buzz-app", p0: 7 });
  expect(pulls.get(chat)).toEqual([
    {
      url: pull,
      state: { state: "open", checks: "failure", conflicts: false },
    },
  ]);
  expect(pulls.get(chat)).toBe(pulls.get(chat));
  expect(pulls.get(other)?.[0]?.state).toBe(pulls.get(chat)?.[0]?.state);
  expect(pulls.get("33333333-3333-4333-8333-333333333333")).toBeUndefined();
  // The store polls it while a chat that links it is shown; a poll that
  // reads the same state leaves the rows' views, and the rows, alone.
  const view = pulls.get(chat);
  const told = changed.mock.calls.length;
  await vi.advanceTimersByTimeAsync(PULL_REFRESH_MS);
  expect(gh).toHaveBeenCalledTimes(2);
  expect(pulls.get(chat)).toBe(view);
  expect(changed).toHaveBeenCalledTimes(told);
  for (const unwatch of stop) unwatch();
  await vi.advanceTimersByTimeAsync(PULL_REFRESH_MS * 3);
  expect(gh).toHaveBeenCalledTimes(2);
});

it("shows a state the shared store moved to while the chat was not shown", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const relay = session([revision(chat, pull), revision(other, pull)]);
  let state = "OPEN";
  const gh = vi.fn(async () => ({
    r0: rollup(state),
  })) as unknown as GitHubCli & ReturnType<typeof vi.fn>;
  const pulls = pullsOver(relay.session, gh);
  const unwatch = pulls.watch(chat, () => {});
  const stopOther = pulls.watch(other, () => {});
  await vi.waitFor(() =>
    expect(pulls.get(chat)?.[0]?.state?.state).toBe("open"),
  );
  // The chat scrolls out; the other, still shown, keeps the pull request read.
  unwatch();
  state = "MERGED";
  await vi.advanceTimersByTimeAsync(PULL_REFRESH_MS);
  expect(pulls.get(other)?.[0]?.state?.state).toBe("merged");
  // Back in view, the chat shows where the pull request is now, not where it
  // was: merged is terminal, so no later read would have corrected it.
  const changed = vi.fn();
  pulls.watch(chat, changed);
  expect(pulls.get(chat)?.[0]?.state?.state).toBe("merged");
  expect(pulls.get(chat)).toBe(pulls.get(chat));
  stopOther();
});

it("writes on top of the forked head the chat shows", async () => {
  const forked = () =>
    session([
      revision(chat, []),
      revision(chat, [second], { id: "d".repeat(64) }),
    ]);
  const unlink = forked();
  expect(await writeLinks(unlink.session, chat, unlinkPull(second))).toEqual(
    [],
  );
  const removed = unlink.sign.mock.calls[0]?.[0] as EventData | undefined;
  expect(removed?.tags).toContainEqual(["prev", "d".repeat(64)]);
  const link = forked();
  expect(await writeLinks(link.session, chat, linkPull(pull))).toEqual([
    second,
    pull,
  ]);
  expect(link.snapshotRead.mock.calls[0]?.[0]).toEqual([
    expect.objectContaining({ limit: 20 }),
  ]);
});

it("prefers a forked head that links pull requests over an empty one", async () => {
  const relay = session([revision(chat, []), revision(chat, [second])]);
  const pulls = pullsOver(relay.session);
  pulls.watch(chat, () => {});
  await vi.waitFor(() =>
    expect(pulls.get(chat)?.map((item) => item.url)).toEqual([second]),
  );
});

it("reads links within the session reader's limit, only the link artifacts", async () => {
  const query = vi.fn(async (_filters: readonly ReadFilter[]) => []);
  const owner = createRelaySession({
    viewer: keypair().pubkey,
    relayAuthor: keypair().pubkey,
    media: () => undefined,
    query,
    subscribe: () => ({ update() {}, retry() {}, dispose() {} }),
  });
  try {
    const pulls = pullsOver(owner.session);
    pulls.watch(chat, () => {});
    await vi.waitFor(() => expect(query).toHaveBeenCalled());
    const [filter] = query.mock.calls[0]?.[0] ?? [];
    expect(filter).toMatchObject({
      "#h": [chat],
      "#d": [await uuidv5(chat, SOLO_PULL_TYPE)],
    });
  } finally {
    owner.dispose();
  }
});

it("reads links once, not on the poll, and only a new row's own link", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const relay = session([revision(chat, pull)]);
  const gh = vi.fn(async () => ({
    r0: rollup("OPEN", "SUCCESS"),
  })) as unknown as GitHubCli & ReturnType<typeof vi.fn>;
  const pulls = pullsOver(relay.session, gh);
  pulls.watch(chat, () => {});
  await vi.waitFor(() => expect(pulls.get(chat)?.[0]?.state).toBeDefined());
  await vi.advanceTimersByTimeAsync(3 * PULL_REFRESH_MS);
  expect(relay.snapshotRead).toHaveBeenCalledOnce();
  expect(gh).toHaveBeenCalledTimes(4);
  pulls.watch(other, () => {});
  await vi.waitFor(() => expect(relay.snapshotRead).toHaveBeenCalledTimes(2));
  expect(relay.snapshotRead.mock.calls[1]?.[0]).toEqual([
    expect.objectContaining({ "#h": [other] }),
  ]);
});

it("reads shown chats' links again when the window comes back after a while", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const relay = session([revision(chat, null)]);
  const pulls = pullsOver(relay.session);
  pulls.watch(chat, () => {});
  await vi.waitFor(() => expect(relay.snapshotRead).toHaveBeenCalledOnce());
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(0);
  expect(relay.snapshotRead).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(5 * SOLO_REFRESH_MS);
  expect(relay.snapshotRead).toHaveBeenCalledOnce();
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.waitFor(() => expect(relay.snapshotRead).toHaveBeenCalledTimes(2));
});

it("shows a link this device wrote before the next read", async () => {
  const relay = session();
  const gh = vi.fn(async () => ({ r0: rollup("OPEN", "SUCCESS") }));
  const pulls = pullsOver(relay.session, gh as unknown as GitHubCli);
  const changed = vi.fn();
  pulls.watch(chat, changed);
  await vi.waitFor(() => expect(relay.snapshotRead).toHaveBeenCalled());
  expect(pulls.get(chat)).toBeUndefined();
  pulls.linked(chat, [pull]);
  expect(pulls.get(chat)).toEqual([{ url: pull, state: undefined }]);
  expect(changed).toHaveBeenCalled();
});

it("reads links again on the poll after a first read fails", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const relay = session([revision(chat, pull)]);
  relay.snapshotRead.mockRejectedValueOnce(new Error("relay unavailable"));
  const gh = vi.fn(async () => ({
    r0: rollup("OPEN", "SUCCESS"),
  })) as unknown as GitHubCli & ReturnType<typeof vi.fn>;
  const pulls = pullsOver(relay.session, gh);
  pulls.watch(chat, () => {});
  await vi.waitFor(() => expect(relay.snapshotRead).toHaveBeenCalledOnce());
  await vi.advanceTimersByTimeAsync(0);
  expect(pulls.get(chat)).toBeUndefined();
  await vi.advanceTimersByTimeAsync(SOLO_REFRESH_MS);
  expect(relay.snapshotRead).toHaveBeenCalledTimes(2);
  expect(pulls.get(chat)?.[0]?.state?.checks).toBe("success");
  // Once read, links are not read again on the poll.
  await vi.advanceTimersByTimeAsync(SOLO_REFRESH_MS);
  expect(relay.snapshotRead).toHaveBeenCalledTimes(2);
});

it("shows each of a chat's linked pull requests, in the order linked", async () => {
  const relay = session([revision(chat, [second, pull])]);
  const gh = vi.fn(async (_query: string, vars: Record<string, unknown>) =>
    Object.fromEntries(
      Object.keys(vars)
        .filter((key) => key.startsWith("p"))
        .map((key) => [
          `r${key.slice(1)}`,
          rollup("OPEN", vars[key] === 7 ? "FAILURE" : "SUCCESS"),
        ]),
    ),
  ) as unknown as GitHubCli & ReturnType<typeof vi.fn>;
  const pulls = pullsOver(relay.session, gh);
  pulls.watch(chat, () => {});
  await vi.waitFor(() =>
    expect(pulls.get(chat)?.map((item) => item.state?.checks)).toEqual([
      "success",
      "failure",
    ]),
  );
  expect(pulls.get(chat)?.map((item) => item.url)).toEqual([second, pull]);
});

it("applies this app's changes to one chat in turn, keeping each", async () => {
  let head: ReturnType<typeof revision> | undefined;
  const relay = session();
  relay.snapshotRead.mockImplementation(async () => (head ? [head] : []));
  relay.publish.mockImplementation(async (event?: unknown) => {
    head = event as ReturnType<typeof revision>;
    return "";
  });
  const third = "https://github.com/block/buzz/pull/10";
  const written = await Promise.all([
    writeLinks(relay.session, chat, linkPull(pull)),
    writeLinks(relay.session, chat, linkPull(second)),
    writeLinks(relay.session, chat, linkPull(third)),
  ]);
  expect(written.at(-1)).toEqual([pull, second, third]);
  expect(JSON.parse(head?.content ?? "")).toMatchObject({
    urls: [pull, second, third],
  });
});

it("reads the head again once when another device saved first", async () => {
  const third = "https://github.com/block/buzz/pull/10";
  const relay = session([revision(chat, pull)]);
  // The other device's revision is what the second read finds.
  relay.snapshotRead
    .mockResolvedValueOnce([revision(chat, pull)])
    .mockResolvedValueOnce([revision(chat, [pull, third])]);
  relay.publish
    .mockRejectedValueOnce(
      new PublishRejected("Not saved", "conflict: stale revision"),
    )
    .mockResolvedValue("");
  expect(await writeLinks(relay.session, chat, linkPull(second))).toEqual([
    pull,
    third,
    second,
  ]);
  expect(relay.snapshotRead).toHaveBeenCalledTimes(2);
  expect(relay.publish).toHaveBeenCalledTimes(2);
  relay.publish.mockRejectedValueOnce(new Error("blocked: no"));
  await expect(
    writeLinks(relay.session, chat, linkPull(second)),
  ).rejects.toThrow("blocked");
});
