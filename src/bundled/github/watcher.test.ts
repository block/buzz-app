// @vitest-environment jsdom
import type { Context } from "@deepseek-ai/cordis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddedTool } from "../../buzz-mcp/session-tools";
import type { BuzzClient } from "../../buzz-mcp/client";
import { POLL_MS, watchPulls } from "./watcher";
import { QUIET_MS } from "./watch";

const agent = "a".repeat(64);
const root = "f".repeat(64);
const url = "https://github.com/block/buzz-app/pull/7";

/** A gh GraphQL answer for an open pull request. */
const answer = ({
  head = "1111111111",
  checks = [] as { name: string; conclusion: string | null }[],
  comments = [] as { id: number; login: string; body: string }[],
  state = "OPEN",
} = {}) =>
  JSON.stringify({
    data: {
      viewer: { login: "baxen" },
      repository: {
        pullRequest: {
          state,
          headRefOid: head,
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
          reviews: { nodes: [] },
          comments: {
            nodes: comments.map(({ id, login, body }) => ({
              databaseId: id,
              author: { login },
              body,
              url: `${url}#${id}`,
            })),
          },
          reviewThreads: { nodes: [] },
        },
      },
    },
  });

function setup(initial: string | null = answer()) {
  let gh = initial;
  const runCommand = vi.fn(async () => gh);
  const woke = vi.fn();
  let runs = true;
  const tools: AddedTool[] = [];
  const disposers: (() => void)[] = [];
  const ctx = {
    host: { runCommand },
    agents: {
      addTool: (tool: AddedTool) => tools.push(tool),
      wake: (pubkey: string, wake: unknown) => {
        if (!runs) throw new Error("This copy of Buzz does not run that agent");
        woke(pubkey, wake);
      },
    },
    effect: (fn: () => () => void) => disposers.push(fn()),
  } as unknown as Context;
  watchPulls(ctx);
  const tool = tools[0] as AddedTool;
  const call = (args: Record<string, unknown>, topLevel = false) =>
    tool.call(
      { pubkey: agent } as BuzzClient,
      topLevel ? { channel: "c", topLevel } : { channel: "c", root },
      args,
    );
  return {
    call,
    tool,
    woke,
    /** The text of each wake, in order. */
    texts: () =>
      woke.mock.calls.map(([, wake]) => (wake as { text: string }).text),
    runCommand,
    gh: (value: string | null) => {
      gh = value;
    },
    runs: (value: boolean) => {
      runs = value;
    },
    dispose: () => {
      for (const dispose of disposers) dispose();
    },
  };
}

describe("watch_pr", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });
  afterEach(() => vi.useRealTimers());

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

  it("answers what is already there instead of waking, and wakes a Solo chat with what is new", async () => {
    const app = setup();
    app.gh(
      answer({
        checks: [{ name: "unit", conclusion: "SUCCESS" }],
        comments: [{ id: 1, login: "wes", body: "body-old" }],
      }),
    );
    expect(await app.call({ url }, true)).toContain(
      "Already there:\nCI passed on 111111111",
    );
    app.gh(
      answer({
        checks: [{ name: "unit", conclusion: "SUCCESS" }],
        comments: [
          { id: 1, login: "wes", body: "body-old" },
          { id: 2, login: "wes", body: "body-new" },
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
          text: `New feedback on ${url}, quoted from GitHub:\n- comment by wes ${url}#2:\n  > body-new`,
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
    expect(
      JSON.parse(localStorage.getItem("buzz.github.pull-watches.v1") ?? ""),
    ).toEqual([]);
    expect(app.woke).not.toHaveBeenCalled();
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
    expect(
      JSON.parse(localStorage.getItem("buzz.github.pull-watches.v1") ?? ""),
    ).toEqual([]);
    app.dispose();
  });

  it("lets a read still in flight when the plugin stops do nothing", async () => {
    const old = setup();
    await old.call({ url });
    let finish: (value: string) => void = () => {};
    old.runCommand.mockImplementationOnce(
      () => new Promise<string>((resolve) => (finish = resolve)),
    );
    await vi.advanceTimersByTimeAsync(POLL_MS);
    old.dispose();
    // Its replacement takes over the saved watch, then the agent stops it.
    const next = setup();
    await vi.advanceTimersByTimeAsync(0);
    await next.call({ url, stop: true });
    finish(answer({ checks: [{ name: "unit", conclusion: "SUCCESS" }] }));
    await vi.advanceTimersByTimeAsync(0);
    expect(old.woke).not.toHaveBeenCalled();
    expect(
      JSON.parse(localStorage.getItem("buzz.github.pull-watches.v1") ?? ""),
    ).toEqual([]);
    next.dispose();
  });

  it("needs a thread or a Solo chat to wake in", async () => {
    const app = setup();
    await expect(
      app.tool.call({ pubkey: agent } as BuzzClient, { channel: "c" }, { url }),
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
