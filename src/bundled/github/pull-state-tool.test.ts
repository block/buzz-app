// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import type { AddedTool } from "../../buzz-mcp/session-tools";
import type { BuzzClient } from "../../buzz-mcp/client";
import { GitHubError, type GitHubCli } from "./gh";
import { addPullStateTool } from "./pull-state-tool";
import { createPullStates, PULL_REFRESH_MS } from "./pull-states";

const url = "https://github.com/block/buzz-app/pull/7";

afterEach(() => {
  vi.useRealTimers();
});

function setup(gh: GitHubCli) {
  const tools: AddedTool[] = [];
  const states = createPullStates(gh);
  addPullStateTool({ addTool: (tool) => tools.push(tool) }, states);
  const tool = tools[0] as AddedTool;
  return {
    states,
    call: (args: Record<string, unknown>) =>
      tool.call({} as BuzzClient, { channel: "c" }, args),
  };
}

const answer = {
  r0: {
    pullRequest: {
      state: "OPEN",
      isDraft: true,
      mergeStateStatus: "DIRTY",
      headRefOid: "abc123",
      commits: {
        nodes: [
          {
            commit: {
              statusCheckRollup: {
                state: "FAILURE",
                contexts: {
                  totalCount: 1,
                  nodes: [
                    {
                      __typename: "CheckRun",
                      name: "unit",
                      status: "COMPLETED",
                      conclusion: "FAILURE",
                    },
                  ],
                },
              },
            },
          },
        ],
      },
    },
  },
};

it("answers what the owner's links show, with when it was read, from the shared store", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const gh = vi.fn(async () => answer) as unknown as GitHubCli &
    ReturnType<typeof vi.fn>;
  const { states, call } = setup(gh);
  // A link already showing it: the agent is answered from the same read.
  const unwatch = states.watch(url, () => {});
  await vi.waitFor(() => expect(states.get(url)).toBeDefined());
  const readAt = states.readAt(url)?.readAt ?? 0;
  vi.setSystemTime(readAt + 12_000);
  expect(JSON.parse(String(await call({ url })))).toEqual({
    state: "draft",
    checks: "failure",
    failed: ["unit"],
    settled: true,
    conflicts: true,
    head: "abc123",
    read_at: new Date(readAt).toISOString(),
    age_seconds: 12,
    source: "gh",
  });
  expect(gh).toHaveBeenCalledOnce();
  // Fresh reads it again; so does a minute on.
  await call({ url, fresh: true });
  expect(gh).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(PULL_REFRESH_MS);
  expect(JSON.parse(String(await call({ url })))).toMatchObject({
    age_seconds: 0,
  });
  expect(gh).toHaveBeenCalledTimes(3);
  unwatch();
});

it("says why it could not read a pull request, and refuses other links", async () => {
  const { call } = setup(async () => {
    throw new GitHubError("Not found", "NOT_FOUND", {
      r0: { pullRequest: null },
    });
  });
  await expect(call({ url })).rejects.toThrow(
    `Could not read ${url}: GitHub couldn’t find this`,
  );
  await expect(
    call({ url: "https://github.com/block/buzz-app/issues/7" }),
  ).rejects.toThrow("Not a GitHub pull request URL");
});

it("answers the last state read, and why reading it again failed", async () => {
  let fail = false;
  const { call } = setup((async () => {
    if (fail)
      throw new GitHubError("Not found", "NOT_FOUND", {
        r0: { pullRequest: null },
      });
    return answer;
  }) as unknown as GitHubCli);
  await call({ url });
  fail = true;
  expect(JSON.parse(String(await call({ url, fresh: true })))).toMatchObject({
    state: "draft",
    head: "abc123",
    last_read_failed: expect.stringContaining("couldn’t find this"),
  });
});

it("answers the last state read when GitHub answered for nothing", async () => {
  let fail = false;
  const { call } = setup((async () => {
    if (fail) throw new Error("socket hang up");
    return answer;
  }) as unknown as GitHubCli);
  await call({ url });
  fail = true;
  expect(JSON.parse(String(await call({ url, fresh: true })))).toMatchObject({
    state: "draft",
    head: "abc123",
    last_read_failed: "socket hang up",
  });
});
