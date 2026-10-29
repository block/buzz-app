// @vitest-environment jsdom
import type { Context } from "@deepseek-ai/cordis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddedTool } from "../../buzz-mcp/session-tools";
import type { BuzzClient } from "../../buzz-mcp/client";
import {
  AttentionSources,
  type AttentionSource,
} from "../../features/agents/attention-sources";
import type { Agent, AgentAttention } from "../../features/agents/service";
import type { AttentionValue } from "../../features/agents/attention";
import { GitHubError, type GitHubCli } from "./gh";
import { createPullStates } from "./pull-states";
import { POLL_MS, watchPulls } from "./watcher";
import { QUIET_MS, WAKE_LIMIT } from "./watch";

const agent = "a".repeat(64);
const root = "f".repeat(64);
const url = "https://github.com/block/buzz-app/pull/7";

type Comment = { id: string; login: string; body: string };
type Pull = ReturnType<typeof answer>;
/** A pull request as GitHub holds it. */
const answer = ({
  head = "1111111111",
  checks = [] as { name: string; conclusion: string | null }[],
  comments = [] as Comment[],
  reviews = [] as (Comment & { inline: (Comment & { path: string })[] })[],
  state = "OPEN",
} = {}) => ({ head, checks, comments, reviews, state });

/** What gh answers the store for every pull request in `variables`, all
 * `pull`, or for the text of feedback `ids`. */
function respond(
  pull: Pull,
  query: string,
  variables: { ids?: string[] } & Record<string, unknown>,
) {
  if (variables.ids) {
    const all = [
      ...pull.comments.map((item) => ({ ...item, __typename: "IssueComment" })),
      ...pull.reviews.flatMap(({ inline, ...review }) => [
        { ...review, __typename: "PullRequestReview", state: "COMMENTED" },
        ...inline.map((item) => ({
          ...item,
          __typename: "PullRequestReviewComment",
        })),
      ]),
    ];
    return {
      nodes: variables.ids.map((id) => {
        const found = all.find((item) => item.id === id);
        if (!found) return null;
        const { login, ...node } = found;
        return { ...node, author: { login }, url: `${url}#${id}` };
      }),
    };
  }
  const { checks } = pull;
  const data: Record<string, unknown> = query.includes("viewer{login}")
    ? { viewer: { login: "baxen" } }
    : {};
  for (let i = 0; `n${i}` in variables; i++)
    data[`r${i}`] = {
      pullRequest: {
        state: pull.state,
        isDraft: false,
        mergeStateStatus: "CLEAN",
        headRefOid: pull.head,
        commits: {
          nodes: [
            {
              commit: {
                statusCheckRollup: {
                  state: checks.some((check) => !check.conclusion)
                    ? "PENDING"
                    : "SUCCESS",
                  contexts: {
                    totalCount: checks.length,
                    nodes: checks.map(({ name, conclusion }) => ({
                      __typename: "CheckRun",
                      name,
                      status: conclusion ? "COMPLETED" : "IN_PROGRESS",
                      conclusion,
                    })),
                  },
                },
              },
            },
          ],
        },
        reviews: {
          nodes: pull.reviews.map((review) => ({
            id: review.id,
            comments: { nodes: review.inline.map(({ id }) => ({ id })) },
          })),
        },
        comments: { nodes: pull.comments.map(({ id }) => ({ id })) },
      },
    };
  return data;
}

function setup(initial: Pull | null = answer()) {
  let gh = initial;
  let texts = true;
  /** GitHub through gh, as the store reads it. */
  const github = vi.fn(
    async (query: string, variables: Record<string, unknown>) => {
      if (!gh) throw new GitHubError("Could not resolve to a Repository");
      if (!texts && "ids" in variables)
        throw new GitHubError("Something went wrong");
      return respond(gh, query, variables);
    },
  );
  const states = createPullStates(github as unknown as GitHubCli);
  const woke = vi.fn();
  const records: Record<string, Record<string, AttentionValue>> = JSON.parse(
    localStorage.getItem("test.attention") ?? "{}",
  );
  const completed = new Set<string>();
  const listeners: (() => void)[] = [];
  let source: AttentionSource;
  let enabled = true;
  const objects = (key: string) =>
    Object.fromEntries(
      Object.entries(records[key] ?? {}).map(([slug, value]) => [
        slug,
        { slug, value },
      ]),
    );
  const snapshot = () =>
    Object.keys(records).map(
      (key) =>
        ({ key, attentionEnabled: enabled, attention: objects(key) }) as Agent,
    );
  const lifecycle = new AttentionSources({
    emit(key, object, text) {
      if (!runs) throw new Error("Delivery unavailable");
      const value = object.value;
      woke(key, {
        channel: value.channel,
        ...(value.root ? { root: value.root } : {}),
        text,
      });
    },
    completed: (key, object) => completed.has(`${key}/${object.slug}`),
    async finish(key, object) {
      completed.add(`${key}/${object.slug}`);
    },
  });
  const reconcile = () => {
    if (source) lifecycle.reconcile("attention/github-pr", source, snapshot());
  };
  const save = async (
    key: string,
    change: { attention: Record<string, AttentionValue | null> },
  ) => {
    records[key] ??= {};
    const record = records[key];
    for (const [slug, value] of Object.entries(change.attention)) {
      if (value) record[slug] = value;
      else delete record[slug];
      completed.delete(`${key}/${slug}`);
    }
    localStorage.setItem("test.attention", JSON.stringify(records));
    reconcile();
    for (const listener of listeners) listener();
  };
  const attention = (key: string) => {
    // As the real store does, a watch of another Interest is out of scope.
    const scope = (
      slug: string,
      value: AttentionValue | null,
      interest?: string,
    ) => {
      const owned = records[key]?.[slug] ?? value;
      if (interest && owned && owned.type !== "interest")
        if (owned.interest_id !== interest)
          throw new Error(
            `wrong-scope: Watch ${slug} belongs to Interest ${owned.interest_id}`,
          );
    };
    const show = async (slug: string, interest?: string) => {
      scope(slug, null, interest);
      const object = records[key]?.[slug];
      return {
        result: object ? "found" : "not-found",
        object: object
          ? {
              ...object,
              id: slug.split("/")[1],
              status: completed.has(`${key}/${slug}`) ? "completed" : "enabled",
            }
          : null,
        expected_state: JSON.stringify(object) ?? "absent",
      };
    };
    return {
      enabled: () => enabled,
      classifier: () => "available",
      show,
      async write(
        slug: string,
        value: AttentionValue | null,
        options: { expected: string; interest?: string },
      ) {
        scope(slug, value, options.interest);
        expect(options.expected).toBe(
          JSON.stringify(records[key]?.[slug]) ?? "absent",
        );
        await save(key, { attention: { [slug]: value } });
        return show(slug);
      },
    } as unknown as AgentAttention;
  };
  const addAttentionSource = vi.fn((value: AttentionSource) => {
    source = value;
    reconcile();
  });
  let runs = true;
  const tools: AddedTool[] = [];
  const disposers: (() => void)[] = [];
  const ctx = {
    agents: {
      addAttentionSource,
      snapshot: () => ({ running: snapshot() }),
      subscribe: (listener: () => void) => {
        listeners.push(listener);
        return () => {};
      },
      save,
      addTool: (tool: AddedTool) => tools.push(tool),
      wake: (key: string, wake: unknown) => {
        if (!runs) throw new Error("This copy of Buzz does not run that agent");
        woke(key, wake);
      },
    },
    effect: (fn: () => () => void) => disposers.push(fn()),
  } as unknown as Context;
  watchPulls(ctx, states);
  const tool = tools[0] as AddedTool;
  const call = (
    args: Record<string, unknown>,
    topLevel = false,
    key = agent,
  ) => {
    // The agent's own Interest, which every watch it adds names.
    records[key] ??= {};
    records[key]["interest/pr"] ??= {
      type: "interest",
      instructions: "Land the pull request",
    };
    return tool.call(
      { key, pubkey: agent, attention: attention(key) } as BuzzClient,
      topLevel ? { channel: "c", topLevel } : { channel: "c", root },
      { interest: "pr", ...args },
    );
  };
  return {
    call,
    records,
    save,
    attention: attention(agent),
    completed,
    attentionEnabled(value: boolean) {
      enabled = value;
      reconcile();
    },
    addAttentionSource,
    tool,
    woke,
    /** The text of each wake, in order. */
    texts: () =>
      woke.mock.calls.map(([, wake]) => (wake as { text: string }).text),
    github,
    /** GitHub's listings of pull requests, not feedback text. */
    listings: () =>
      github.mock.calls.filter(([, variables]) => !("ids" in variables)).length,
    states,
    gh: (value: Pull | null) => {
      gh = value;
    },
    /** Whether reads of feedback text succeed, as a too-long answer cannot. */
    readsText: (value: boolean) => {
      texts = value;
    },
    runs: (value: boolean) => {
      runs = value;
    },
    dispose: () => {
      lifecycle.stop();
      for (const dispose of disposers) dispose();
    },
  };
}

describe("github_watch_pr", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });
  afterEach(() => vi.useRealTimers());

  it("registers PR watching as an Attention source", () => {
    const app = setup();
    expect(app.addAttentionSource).toHaveBeenCalledWith(
      expect.objectContaining({ id: "github-pr", run: expect.any(Function) }),
    );
    app.dispose();
  });

  it("keeps generic subscriptions for the same PR independent", async () => {
    const app = setup(
      answer({ checks: [{ name: "unit", conclusion: "SUCCESS" }] }),
    );
    const source = {
      type: "source" as const,
      interest_id: "first",
      enabled: true,
      provider: "attention/github-pr",
      channel: "c",
      config: { pr: url },
    };
    await app.save(agent, {
      attention: {
        "interest/first": { type: "interest", instructions: "First" },
        "interest/second": { type: "interest", instructions: "Second" },
        "watch/first": source,
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(app.woke).toHaveBeenCalledTimes(1);
    await app.save(agent, {
      attention: { "watch/second": { ...source, interest_id: "second", root } },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(app.woke).toHaveBeenCalledTimes(2);
    app.dispose();
  });

  it("starts fresh when a generic subscription is deleted and recreated", async () => {
    const app = setup(
      answer({ checks: [{ name: "unit", conclusion: "SUCCESS" }] }),
    );
    const source = {
      type: "source" as const,
      interest_id: "first",
      enabled: true,
      provider: "attention/github-pr",
      channel: "c",
      config: { pr: url },
    };
    await app.save(agent, {
      attention: {
        "interest/first": { type: "interest", instructions: "Follow" },
        "watch/first": source,
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(app.woke).toHaveBeenCalledTimes(1);
    await app.save(agent, { attention: { "watch/first": null } });
    await app.save(agent, { attention: { "watch/first": source } });
    await vi.advanceTimersByTimeAsync(0);
    expect(app.woke).toHaveBeenCalledTimes(2);
    app.dispose();
  });

  it("starts fresh when a subscription is edited to another PR", async () => {
    const app = setup(
      answer({ checks: [{ name: "unit", conclusion: "SUCCESS" }] }),
    );
    const source = {
      type: "source" as const,
      interest_id: "first",
      enabled: true,
      provider: "attention/github-pr",
      channel: "c",
      config: { pr: url },
    };
    await app.save(agent, {
      attention: {
        "interest/first": { type: "interest", instructions: "Follow" },
        "watch/first": source,
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    const next = "https://github.com/block/buzz-app/pull/8";
    app.gh(
      answer({
        head: "2222222222",
        checks: [{ name: "unit", conclusion: "SUCCESS" }],
      }),
    );
    await app.save(agent, {
      attention: { "watch/first": { ...source, config: { pr: next } } },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(app.texts().at(-1)).toBe(`CI passed on 222222222 for ${next}.`);
    app.dispose();
  });

  it("pauses polling with Attention and catches up when resumed", async () => {
    const app = setup();
    await app.call({ url });
    app.attentionEnabled(false);
    await vi.advanceTimersByTimeAsync(0);
    const count = app.github.mock.calls.length;
    app.gh(answer({ checks: [{ name: "unit", conclusion: "SUCCESS" }] }));
    await vi.advanceTimersByTimeAsync(3 * POLL_MS);
    expect(app.github).toHaveBeenCalledTimes(count);
    expect(app.woke).not.toHaveBeenCalled();
    await expect(app.call({ url })).rejects.toThrow(/Turn on Attention/);
    app.attentionEnabled(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(app.texts()).toEqual([`CI passed on 111111111 for ${url}.`]);
    app.dispose();
  });

  it("moves a PR's watch from another Interest to the one named", async () => {
    const app = setup();
    await app.call({ url });
    const id = Object.keys(app.records[agent] ?? {}).find((slug) =>
      slug.startsWith("watch/"),
    );
    if (!id) throw new Error("Missing watch");
    const watch = app.records[agent]?.[id];
    if (watch?.type !== "source") throw new Error("Missing source");
    // As the shipped plugin saved it, under its own Interest.
    await app.save(agent, {
      attention: {
        "interest/github-pulls": { type: "interest", instructions: "Follow" },
        [id]: { ...watch, interest_id: "github-pulls" },
      },
    });
    expect(await app.call({ url }, true)).toContain(
      "The watch moved to Interest pr from Interest github-pulls, which gets no more wakes for this pull request.",
    );
    expect(app.records[agent]?.[id]).toEqual(
      expect.objectContaining({ interest_id: "pr", channel: "c" }),
    );
    expect(app.records[agent]?.[id]).not.toHaveProperty("root");
    app.dispose();
  });

  it("drops watches saved before Attention instead of importing them", async () => {
    localStorage.setItem(
      "buzz.github.pull-watches.v1",
      JSON.stringify([{ agent, url, channel: "c", root, wakes: 2 }]),
    );
    const app = setup();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(localStorage.getItem("buzz.github.pull-watches.v1")).toBeNull();
    expect(app.records).toEqual({});
    expect(app.github).not.toHaveBeenCalled();
    app.dispose();
  });

  it("adds the watch to the agent's Interest, and needs one that exists", async () => {
    const app = setup();
    await expect(app.call({ url, interest: undefined })).rejects.toThrow(
      /interest is required/,
    );
    await expect(app.call({ url, interest: "missing" })).rejects.toThrow(
      /Interest missing does not exist.*interest_set/,
    );
    expect(app.github).not.toHaveBeenCalled();
    await app.call({ url });
    const sources = () =>
      Object.entries(app.records[agent] ?? {}).filter(
        ([, value]) => value.type === "source",
      );
    expect(sources()).toEqual([
      [
        expect.stringMatching(/^watch\/github-/),
        expect.objectContaining({
          interest_id: "pr",
          provider: "attention/github-pr",
          channel: "c",
          root,
        }),
      ],
    ]);
    expect(Object.keys(app.records[agent] ?? {})).not.toContain(
      "interest/github-pulls",
    );
    // A second call updates the same watch, now at the top of a Solo chat.
    await app.call({ url }, true);
    expect(sources()).toHaveLength(1);
    expect(sources()[0]?.[1]).not.toHaveProperty("root");
    app.dispose();
  });

  it("starts fresh after the owner deletes a watch outside the tool", async () => {
    const app = setup();
    await app.call({ url });
    app.gh(answer({ checks: [{ name: "unit", conclusion: "SUCCESS" }] }));
    await vi.advanceTimersByTimeAsync(POLL_MS);
    const id = Object.keys(app.records[agent] ?? {}).find((id) =>
      id.startsWith("watch/"),
    );
    if (!id) throw new Error("Missing watch");
    await app.save(agent, { attention: { [id]: null } });
    const reply = await app.call({ url }, true);
    expect(reply).not.toContain("no longer in the conversation");
    const record = app.records[agent]?.[id];
    if (record?.type !== "source") throw new Error("Missing source");
    expect((record.config.initial as { wakes: number }).wakes).toBe(0);
    app.dispose();
  });

  it("finishes at the wake limit and a new call starts a fresh watch", async () => {
    const app = setup();
    await app.call({ url });
    for (let index = 0; index < WAKE_LIMIT; index++) {
      app.gh(
        answer({
          head: index.toString(16).padStart(10, "0"),
          checks: [{ name: "unit", conclusion: "SUCCESS" }],
        }),
      );
      await vi.advanceTimersByTimeAsync(POLL_MS);
    }
    expect(app.texts()).toHaveLength(WAKE_LIMIT);
    expect(app.texts().at(-1)).toContain("this watch has ended");
    expect(app.completed.size).toBe(1);
    await app.call({ url });
    app.gh(
      answer({
        head: "abcdef0123",
        checks: [{ name: "unit", conclusion: "SUCCESS" }],
      }),
    );
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(app.texts()).toHaveLength(WAKE_LIMIT + 1);
    expect(app.texts().at(-1)).not.toContain("this watch has ended");
    app.dispose();
  });

  it("wakes the agent in its thread when CI finishes, naming the failed checks", async () => {
    const app = setup();
    app.gh(answer({ checks: [{ name: "unit", conclusion: null }] }));
    expect(await app.call({ url })).toMatch(/^Watching https:/);
    app.gh(answer({ checks: [{ name: "unit", conclusion: "FAILURE" }] }));
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(app.woke.mock.calls).toEqual([
      [
        agent,
        {
          channel: "c",
          root,
          text: `CI failed on 111111111 for ${url}: 1 check failed, as GitHub names them:\n> unit`,
        },
      ],
    ]);
    // Reported once per head commit.
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(app.woke).toHaveBeenCalledTimes(1);
    app.dispose();
  });

  it("wakes the community whose membership set the watch, apart from the agent's other one", async () => {
    const other = `${agent}@other.example`;
    const app = setup();
    app.gh(answer({ checks: [{ name: "unit", conclusion: null }] }));
    await app.call({ url });
    await app.call({ url }, false, other);
    app.gh(answer({ checks: [{ name: "unit", conclusion: "FAILURE" }] }));
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(app.woke.mock.calls.map(([key]) => key).sort()).toEqual(
      [agent, other].sort(),
    );
    // Stopping one leaves the other's.
    await app.call({ url, stop: true }, false, other);
    expect(
      JSON.parse(
        localStorage.getItem("buzz.github.attention-cursors.v1") ?? "[]",
      ).map((watch: { agent: string }) => watch.agent),
    ).toEqual([agent]);
    app.dispose();
  });

  it("answers what is already there instead of waking, and wakes a Solo chat with what is new", async () => {
    const app = setup();
    app.gh(
      answer({
        checks: [{ name: "unit", conclusion: "SUCCESS" }],
        comments: [{ id: "I1", login: "wes", body: "body-old" }],
      }),
    );
    expect(await app.call({ url }, true)).toContain(
      "Already there:\nCI passed on 111111111",
    );
    app.gh(
      answer({
        checks: [{ name: "unit", conclusion: "SUCCESS" }],
        comments: [
          { id: "I1", login: "wes", body: "body-old" },
          { id: "I2", login: "wes", body: "body-new" },
        ],
      }),
    );
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(app.woke).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(QUIET_MS + POLL_MS);
    expect(app.woke.mock.calls).toEqual([
      [
        agent,
        {
          channel: "c",
          text: `New feedback on ${url}, quoted from GitHub:\n- comment by wes ${url}#I2:\n  > body-new`,
        },
      ],
    ]);
    app.dispose();
  });

  it("keeps news it could not send, and survives a restart", async () => {
    const app = setup();
    await app.call({ url });
    app.runs(false);
    app.gh(answer({ checks: [{ name: "unit", conclusion: "SUCCESS" }] }));
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(app.woke).not.toHaveBeenCalled();
    app.dispose();
    // The restarted app reads at once.
    const next = setup(
      answer({ checks: [{ name: "unit", conclusion: "SUCCESS" }] }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(next.woke).toHaveBeenCalledTimes(1);
    next.dispose();
  });

  it("reads, after a restart, the text of only the feedback the watch has not seen", async () => {
    const before = [{ id: "R1", login: "wes", body: "Looks off", inline: [] }];
    const app = setup(answer({ reviews: before }));
    await app.call({ url });
    app.dispose();
    const next = setup(
      answer({
        reviews: [
          ...before,
          { id: "R2", login: "wes", body: "Still off", inline: [] },
        ],
      }),
    );
    await vi.advanceTimersByTimeAsync(QUIET_MS + 2 * POLL_MS);
    expect(next.texts().join("\n")).toContain("Still off");
    expect(next.texts().join("\n")).not.toContain("Looks off");
    expect(
      [app, next].flatMap((one) =>
        one.github.mock.calls
          .map(([, variables]) => variables.ids)
          .filter(Boolean),
      ),
    ).toEqual([["R2"]]);
    next.dispose();
  });

  it("stops on request, when merged, and refuses unreadable pull requests", async () => {
    const app = setup();
    await app.call({ url });
    expect(await app.call({ url, stop: true })).toBe(
      `Stopped watching ${url}.`,
    );
    app.gh(null);
    await expect(app.call({ url })).rejects.toThrow(/gh/);
    await expect(app.call({ url: "https://example.com/x" })).rejects.toThrow(
      /pull request URL/,
    );
    app.gh(answer());
    await app.call({ url });
    app.gh(answer({ state: "MERGED" }));
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect([...app.completed]).toHaveLength(1);
    expect(app.texts()).toEqual([
      expect.stringMatching(
        new RegExp(`^${url} was merged, so this watch has ended`),
      ),
    ]);
    app.dispose();
  });

  it("ends a watch it cannot read for half an hour, telling the agent", async () => {
    const app = setup();
    await app.call({ url });
    app.gh(null);
    await vi.advanceTimersByTimeAsync(29 * POLL_MS);
    expect(app.woke).not.toHaveBeenCalled();
    // A good read in between starts the count again.
    app.gh(answer());
    await vi.advanceTimersByTimeAsync(POLL_MS);
    app.gh(null);
    await vi.advanceTimersByTimeAsync(29 * POLL_MS);
    expect(app.woke).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(app.texts()).toEqual([
      expect.stringContaining(`Stopped watching ${url}`),
    ]);
    expect([...app.completed]).toHaveLength(1);
    app.dispose();
  });

  it("lets a read still in flight when the plugin stops do nothing", async () => {
    const old = setup();
    await old.call({ url });
    let finish: (value: unknown) => void = () => {};
    old.github.mockImplementationOnce(
      () =>
        new Promise<Record<string, unknown>>(
          (resolve) => (finish = (value) => resolve(value as never)),
        ),
    );
    await vi.advanceTimersByTimeAsync(POLL_MS);
    old.dispose();
    // Its replacement takes over the saved watch, then the agent stops it.
    const next = setup();
    await vi.advanceTimersByTimeAsync(0);
    await next.call({ url, stop: true });
    finish(
      respond(
        answer({ checks: [{ name: "unit", conclusion: "SUCCESS" }] }),
        "viewer{login}",
        { o0: "block", n0: "buzz-app", p0: 7 },
      ),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(old.woke).not.toHaveBeenCalled();
    expect(
      JSON.parse(
        localStorage.getItem("buzz.github.attention-cursors.v1") ?? "",
      ),
    ).toEqual([]);
    next.dispose();
  });

  it("still reports CI while feedback text cannot be read, and tells the feedback once it can", async () => {
    const app = setup();
    await app.call({ url });
    app.readsText(false);
    app.gh(
      answer({
        checks: [{ name: "unit", conclusion: "SUCCESS" }],
        comments: [{ id: "I1", login: "wes", body: "x".repeat(22_000) }],
      }),
    );
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(app.texts()).toEqual([`CI passed on 111111111 for ${url}.`]);
    app.readsText(true);
    await vi.advanceTimersByTimeAsync(2 * POLL_MS + QUIET_MS);
    expect(app.texts()).toHaveLength(2);
    expect(app.texts()[1]).toMatch(
      new RegExp(`^New feedback on .+\\n- comment by wes ${url}#I1:`),
    );
    expect(app.woke).toHaveBeenCalledTimes(2);
    app.dispose();
  });

  it("wakes for a reply on an older thread, which comes with its own review", async () => {
    const old = Array.from({ length: 40 }, (_, i) => ({
      id: `R${i}`,
      login: "wes",
      body: "",
      inline: [
        { id: `C${i}`, login: "wes", body: `old ${i}`, path: "src/a.ts" },
      ],
    }));
    const app = setup(answer({ reviews: old }));
    await app.call({ url });
    app.gh(
      answer({
        reviews: [
          ...old,
          {
            id: "R40",
            login: "wes",
            body: "",
            inline: [
              {
                id: "C40",
                login: "wes",
                body: "Still broken",
                path: "src/a.ts",
              },
            ],
          },
        ],
      }),
    );
    await vi.advanceTimersByTimeAsync(2 * POLL_MS + QUIET_MS);
    expect(app.texts()).toEqual([
      [
        `New feedback on ${url}, quoted from GitHub:`,
        `- inline comment by wes ${url}#C40, on:`,
        "  > src/a.ts",
        "  > Still broken",
      ].join("\n"),
    ]);
    // What was there when the watch started is never read in full; only the
    // new review and its comment are.
    expect(
      app.github.mock.calls
        .map(([, variables]) => variables.ids)
        .filter(Boolean),
    ).toEqual([["R40", "C40"]]);
    app.dispose();
  });

  it("reads a pull request both watched and shown once a minute, for both", async () => {
    const app = setup(answer({ checks: [{ name: "unit", conclusion: null }] }));
    await app.call({ url });
    const shown = vi.fn();
    const unwatch = app.states.watch(url, shown);
    await vi.advanceTimersByTimeAsync(0);
    const before = app.listings();
    app.gh(answer({ checks: [{ name: "unit", conclusion: "SUCCESS" }] }));
    await vi.advanceTimersByTimeAsync(3 * POLL_MS);
    // The watch asks for the feedback the link does not need, and the one
    // read serves both: the link shows the checks, the agent is woken.
    expect(app.listings() - before).toBe(3);
    expect(app.states.get(url)).toMatchObject({ checks: "success" });
    expect(shown).toHaveBeenCalled();
    expect(app.texts()).toEqual([`CI passed on 111111111 for ${url}.`]);
    unwatch();
    app.dispose();
  });

  it("needs a thread or a Solo chat to wake in", async () => {
    const app = setup();
    await expect(
      app.tool.call(
        { key: agent, pubkey: agent, attention: app.attention } as BuzzClient,
        { channel: "c" },
        { url, interest: "pr" },
      ),
    ).rejects.toThrow(/thread or a Solo chat/);
    app.dispose();
  });

  it("says when a watch moves to another conversation", async () => {
    const app = setup();
    await app.call({ url });
    expect(await app.call({ url }, true)).toContain(
      "no longer in the conversation that asked before",
    );
    app.dispose();
  });
});
