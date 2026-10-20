// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import type { RelaySession } from "../../features/relay/session";
import type { EventData } from "../../features/relay/events";
import { uuidv5 } from "../../features/agents/agent-config-artifacts";
import type { ReadFilter } from "../../features/relay/events";
import { createRelaySession } from "../../features/relay/session";
import { keypair } from "../../features/relay/testing";
import { GhUnavailable, GitHubError, type GitHubCli } from "./gh";
import {
  createSoloPulls,
  linkOf,
  SOLO_PULL_TYPE,
  SOLO_REFRESH_MS,
  writeLink,
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
  url: string | null,
  extra: Partial<EventData> = {},
) => ({
  id: `${channel.slice(0, 8)}${"e".repeat(56)}`,
  pubkey: "c".repeat(64),
  sig: "",
  created_at: 1,
  kind: 45010,
  content: JSON.stringify({ version: 1, url }),
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

it("reads a link only from a Solo pull request revision", () => {
  expect(linkOf(revision(chat, pull))).toBe(pull);
  expect(linkOf(revision(chat, null))).toBeNull();
  expect(linkOf(revision(chat, "https://github.com/block/buzz-app"))).toBe(
    undefined,
  );
  expect(
    linkOf({
      ...revision(chat, pull),
      tags: [["type", "buzz.agent.settings"]],
    }),
  ).toBeUndefined();
  expect(linkOf({ ...revision(chat, pull), content: "{" })).toBeUndefined();
});

it("creates, replaces and unlinks a chat's pull request as one artifact", async () => {
  const empty = session();
  await writeLink(empty.session, chat, pull);
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
  expect(JSON.parse(created.content)).toEqual({ version: 1, url: pull });
  expect(empty.publish).toHaveBeenCalledOnce();

  const linked = session([revision(chat, pull)]);
  await writeLink(linked.session, chat, pull);
  expect(linked.sign).not.toHaveBeenCalled();
  await writeLink(linked.session, chat, second);
  await writeLink(linked.session, chat, null);
  const [replaced, unlinked] = linked.sign.mock.calls.map(
    ([event]) => event as EventData,
  );
  expect(replaced?.tags).toContainEqual(["op", "update"]);
  expect(replaced?.tags).toContainEqual(["prev", revision(chat, pull).id]);
  expect(JSON.parse(replaced?.content ?? "")).toEqual({
    version: 1,
    url: second,
  });
  expect(JSON.parse(unlinked?.content ?? "")).toEqual({
    version: 1,
    url: null,
  });

  // Nothing to unlink writes nothing; without a writer it says why.
  await writeLink(empty.session, other, null);
  expect(empty.sign).toHaveBeenCalledOnce();
  await expect(writeLink({} as RelaySession, chat, pull)).rejects.toThrow(
    "needs the Buzz desktop app",
  );
});

const rollup = (
  state: string,
  extra: Record<string, unknown> = {},
  checks?: string,
) => ({
  pullRequest: {
    state,
    isDraft: false,
    mergeStateStatus: "CLEAN",
    commits: {
      nodes: [
        { commit: { statusCheckRollup: checks ? { state: checks } : null } },
      ],
    },
    ...extra,
  },
});

it("reads every shown chat's link and pull request together, then again each minute", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const relay = session([revision(chat, pull), revision(other, second)]);
  const gh = vi.fn(async () => ({
    r0: rollup("OPEN", { mergeStateStatus: "DIRTY" }, "FAILURE"),
    r1: rollup("MERGED"),
  })) as unknown as GitHubCli & ReturnType<typeof vi.fn>;
  const pulls = createSoloPulls(relay.session, gh);
  const changed = vi.fn();
  const stop = [
    pulls.watch(chat, changed),
    pulls.watch(other, changed),
    pulls.watch("33333333-3333-4333-8333-333333333333", changed),
  ];
  await vi.waitFor(() => expect(pulls.get(other)?.state).toBeDefined());
  expect(relay.snapshotRead).toHaveBeenCalledOnce();
  expect(relay.snapshotRead.mock.calls[0]?.[0]).toEqual([
    expect.objectContaining({
      "#h": [chat, other, "33333333-3333-4333-8333-333333333333"],
    }),
  ]);
  expect(gh).toHaveBeenCalledOnce();
  expect(gh.mock.calls[0]?.[1]).toEqual({
    o0: "block",
    n0: "buzz-app",
    p0: 7,
    o1: "block",
    n1: "buzz",
    p1: 9,
  });
  expect(pulls.get(chat)).toEqual({
    url: pull,
    state: { state: "open", checks: "failure", conflicts: true },
  });
  expect(pulls.get(chat)).toBe(pulls.get(chat));
  expect(pulls.get(other)?.state?.state).toBe("merged");
  expect(pulls.get("33333333-3333-4333-8333-333333333333")).toBeUndefined();

  await vi.advanceTimersByTimeAsync(SOLO_REFRESH_MS);
  expect(gh).toHaveBeenCalledTimes(2);
  for (const unwatch of stop) unwatch();
  await vi.advanceTimersByTimeAsync(SOLO_REFRESH_MS * 3);
  expect(gh).toHaveBeenCalledTimes(2);
});

it("reads each pull request alone when one is missing, and public data without gh", async () => {
  const relay = session([revision(chat, pull), revision(other, second)]);
  const gh = vi.fn(
    async (_query: string, variables: Record<string, unknown>) => {
      if ("o1" in variables) throw new GitHubError("Not found", "NOT_FOUND");
      if (variables.n0 === "buzz")
        throw new GitHubError("Not found", "NOT_FOUND");
      return { r0: rollup("OPEN", { isDraft: true }, "PENDING") };
    },
  ) as unknown as GitHubCli;
  const pulls = createSoloPulls(relay.session, gh);
  pulls.watch(chat, () => {});
  pulls.watch(other, () => {});
  await vi.waitFor(() => expect(pulls.get(other)?.failed).toBe(true));
  expect(pulls.get(chat)?.state).toEqual({
    state: "draft",
    checks: "pending",
    conflicts: false,
  });

  const fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({ title: "A", state: "closed", merged: true }),
      ),
  );
  vi.stubGlobal("fetch", fetch);
  const signedOut = createSoloPulls(relay.session, async () => {
    throw new GhUnavailable();
  });
  signedOut.watch(chat, () => {});
  await vi.waitFor(() =>
    expect(signedOut.get(chat)?.state).toEqual({ state: "merged" }),
  );
  expect(fetch).toHaveBeenCalledWith(
    "https://api.github.com/repos/block/buzz-app/pulls/7",
    expect.anything(),
  );
});

it("goes back to gh once it is available again", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ state: "open" }))),
  );
  const relay = session([revision(chat, pull)]);
  let signedIn = false;
  const gh = vi.fn(async () => {
    if (!signedIn) throw new GhUnavailable();
    return { r0: rollup("OPEN", {}, "SUCCESS") };
  }) as unknown as GitHubCli & ReturnType<typeof vi.fn>;
  const pulls = createSoloPulls(relay.session, gh);
  pulls.watch(chat, () => {});
  await vi.waitFor(() =>
    expect(pulls.get(chat)?.state).toEqual({ state: "open" }),
  );
  signedIn = true;
  await vi.advanceTimersByTimeAsync(5 * SOLO_REFRESH_MS);
  expect(gh).toHaveBeenCalledTimes(2);
  expect(pulls.get(chat)?.state?.checks).toBe("success");
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
    const pulls = createSoloPulls(owner.session, undefined);
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

it("keeps a refresh that was given up on from marking pull requests unavailable", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const relay = session([revision(chat, pull)]);
  let answer: (value: unknown) => void = () => {};
  const gh = vi.fn(
    (_query: string, _variables: unknown, signal?: AbortSignal) =>
      new Promise((resolve, reject) => {
        answer = resolve;
        signal?.addEventListener("abort", () => reject(signal.reason));
      }),
  ) as unknown as GitHubCli & ReturnType<typeof vi.fn>;
  const pulls = createSoloPulls(relay.session, gh);
  const unwatch = pulls.watch(chat, () => {});
  await vi.waitFor(() => expect(gh).toHaveBeenCalledOnce());
  // The last row goes away mid-read, then comes back.
  unwatch();
  await vi.advanceTimersByTimeAsync(0);
  pulls.watch(chat, () => {});
  expect(pulls.get(chat)?.failed).toBeUndefined();
  await vi.waitFor(() => expect(gh).toHaveBeenCalledTimes(2));
  answer({ r0: rollup("OPEN", {}, "SUCCESS") });
  await vi.waitFor(() =>
    expect(pulls.get(chat)?.state?.checks).toBe("success"),
  );
});

it("shows a link this device wrote before the next read", async () => {
  const relay = session();
  const gh = vi.fn(async () => ({ r0: rollup("OPEN", {}, "SUCCESS") }));
  const pulls = createSoloPulls(relay.session, gh as unknown as GitHubCli);
  const changed = vi.fn();
  pulls.watch(chat, changed);
  await vi.waitFor(() => expect(relay.snapshotRead).toHaveBeenCalled());
  expect(pulls.get(chat)).toBeUndefined();
  pulls.linked(chat, pull);
  expect(pulls.get(chat)).toEqual({ url: pull, state: undefined });
  expect(changed).toHaveBeenCalled();
});
