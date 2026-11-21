import { expect, it, vi } from "vitest";
import * as patchParser from "../diffs/parse";
import { createPrComments, anchorInSnapshot } from "./pr-comments";
import {
  fixturePull,
  githubCommentHost,
} from "../../../tests/fixtures/github-comment-host";

function seed(
  state: ReturnType<typeof githubCommentHost>["state"],
  body = "Comment 1",
  id = 1,
  root?: number,
) {
  const row = {
    id,
    node_id: `comment-${id}`,
    body,
    user: { login: state.viewer },
    html_url: `https://github.com/example-org/sample/pull/1#discussion_r${id}`,
    created_at: "2026-01-01T00:00:00Z",
    commit_id: state.head,
    original_commit_id: state.head,
    path: "src/example.ts",
    side: "RIGHT",
    line: 5001,
    original_line: 5001,
    ...(root ? { in_reply_to_id: root } : {}),
  };
  state.comments.push(row);
  return row;
}

async function setup() {
  const fixture = githubCommentHost();
  const api = createPrComments(fixture.host);
  if (!api) throw new Error("Missing adapter");
  const snapshot = await api.loadSnapshot(fixturePull);
  const anchor = {
    head: snapshot.head,
    base: snapshot.base,
    path: "src/example.ts",
    side: "LEFT",
    line: 5000,
  } as const;
  return { ...fixture, api, snapshot, anchor };
}
it("loads the PR endpoint with verified SHAs and canonical renamed path", async () => {
  const { snapshot, anchor, state } = await setup();
  expect(snapshot.files).toEqual([
    { path: "src/example.ts", previousPath: "src/old.ts" },
  ]);
  expect(anchorInSnapshot(snapshot, anchor)).toBe(true);
  expect(anchorInSnapshot(snapshot, { ...anchor, path: "src/old.ts" })).toBe(
    false,
  );
  expect(
    anchorInSnapshot(snapshot, { ...anchor, side: "RIGHT", line: 5002 }),
  ).toBe(true);
  expect(
    anchorInSnapshot(snapshot, { ...anchor, side: "LEFT", line: 5002 }),
  ).toBe(false);
  expect(state.calls.find((call) => call.id === "diff")?.args).toEqual([
    "repos/example-org/sample/pulls/1",
  ]);
});
it("indexes patch coordinates once per snapshot and invalidates on replacement", async () => {
  const { snapshot, anchor } = await setup();
  const parse = vi.spyOn(patchParser, "parsePatch");
  try {
    expect(anchorInSnapshot(snapshot, anchor)).toBe(true);
    const reads = parse.mock.calls.length;
    expect(reads).toBeGreaterThan(0);
    for (let index = 0; index < 100; index++)
      expect(anchorInSnapshot(snapshot, anchor)).toBe(true);
    expect(parse).toHaveBeenCalledTimes(reads);
    expect(anchorInSnapshot({ ...snapshot, diff: "" }, anchor)).toBe(false);
    expect(parse.mock.calls.length).toBeGreaterThan(reads);
  } finally {
    parse.mockRestore();
  }
});

it("reads file pages, outer thread cursors, and nested comment cursors", async () => {
  const { api, state } = await setup();
  state.files = Array.from({ length: 101 }, (_, index) => ({
    filename: `file-${index}`,
    previous_filename: "previous",
  }));
  expect((await api.loadSnapshot(fixturePull)).files).toHaveLength(101);
  seed(state, "First", 1);
  seed(state, "Reply", 2, 1);
  seed(state, "Second", 3);
  state.pageSize = 1;
  const first = await api.loadThreads(fixturePull);
  expect(first.items).toHaveLength(1);
  expect(first.nextCursor).toBe("1");
  expect(first.items[0]?.commentsCursor).toBe("1");
  expect(
    (await api.loadThreads(fixturePull, first.nextCursor ?? undefined)).items[0]
      ?.comments[0]?.body,
  ).toBe("Second");
  const replies = await api.loadComments("thread-1", "1");
  const input = state.calls.at(-1)?.input as { query?: string } | undefined;
  const query = input?.query;
  expect(query).toContain("id path diffSide line isOutdated");
  expect(query).toContain("pullRequest{id headRefOid baseRefOid}");
  expect(query).toContain("root:comments(first:1){nodes{databaseId}}");
  expect(replies.items[0]?.body).toBe("Reply");
  expect(replies).toMatchObject({
    pullId: "pull-fixture",
    head: state.head,
    base: state.base,
    thread: {
      id: "thread-1",
      path: "src/example.ts",
      side: "RIGHT",
      line: 5001,
      outdated: false,
      rootCommentId: 1,
    },
  });
});
it("normalizes inaccessible PR/thread GraphQL reads", async () => {
  const fixture = githubCommentHost();
  const spawn = async (
    id: string,
    options?: Parameters<typeof fixture.host.spawn>[1],
  ) => {
    if (id !== "graphql") return fixture.host.spawn(id, options);
    return {
      write: async () => {},
      kill: async () => {},
      exited: Promise.resolve(1),
      end: async () => {
        options?.onStdout?.(
          JSON.stringify({
            errors: [{ type: "FORBIDDEN", message: "Access denied" }],
          }),
        );
      },
    };
  };
  const api = createPrComments({ spawn });
  await expect(api?.loadThreads(fixturePull)).rejects.toMatchObject({
    kind: "forbidden",
  });
  await expect(api?.loadComments("thread-1")).rejects.toMatchObject({
    kind: "forbidden",
  });
});
