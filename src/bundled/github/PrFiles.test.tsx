// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useEffect } from "react";
import type { DiffComments } from "../diffs/DiffViewer";
import { PrFiles } from "./PrFiles";
import {
  createPrComments,
  type Comment,
  type Thread,
  type CommentPage,
} from "./pr-comments";
import {
  fixturePull,
  githubCommentHost,
} from "../../../tests/fixtures/github-comment-host";

afterEach(cleanup);

const diffRender = vi.hoisted(() => vi.fn());
const commentRender = vi.hoisted(() => vi.fn());
vi.mock("./GitHubComment", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./GitHubComment")>();
  return {
    ...actual,
    GitHubComment: (props: Parameters<typeof actual.GitHubComment>[0]) => {
      commentRender();
      return <actual.GitHubComment {...props} />;
    },
  };
});

// Exercise panel ownership while the browser suite covers Pierre's portals.
vi.mock("../diffs/DiffViewer", () => ({
  DiffViewer: ({ comments }: { comments?: DiffComments }) => {
    diffRender();
    useEffect(() => {
      comments?.onAvailabilityChange?.("src/example.ts", true);
      return () => comments?.onAvailabilityChange?.("src/example.ts", false);
    }, [comments?.onAvailabilityChange]);
    return (
      <>
        <button
          type="button"
          onClick={() =>
            comments?.onSelect(
              "src/example.ts",
              [{ side: "additions", lineNumber: 5001 }],
              () => {},
            )
          }
        >
          Select line
        </button>
        <button
          type="button"
          onClick={() =>
            comments?.onSelect(
              "src/example.ts",
              [{ side: "deletions", lineNumber: 5000 }],
              () => {},
            )
          }
        >
          Select other line
        </button>
        {comments?.annotations.map((annotation) => (
          <div key={`${annotation.side}:${annotation.lineNumber}`}>
            {annotation.content}
          </div>
        ))}
      </>
    );
  },
}));

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

it("discards a reply page that completes after a new snapshot replaces its owner", async () => {
  const fixture = githubCommentHost();
  const transport = createPrComments(fixture.host);
  if (!transport) throw new Error("Missing adapter");
  const snapshot = await transport.loadSnapshot(fixturePull);
  const comment: Comment = {
    id: "first",
    databaseId: 1,
    body: "First page",
    author: "reviewer",
    url: "https://github.com/example-org/sample/pull/1#discussion_r1",
  };
  const thread: Thread = {
    id: "thread",
    path: "src/example.ts",
    side: "RIGHT",
    line: 5001,
    originalLine: 5001,
    outdated: false,
    resolved: false,
    rootCommentId: 1,
    comments: [comment],
    commentsComplete: false,
    commentsCursor: "page-2",
  };
  let release!: (value: CommentPage) => void;
  const page = new Promise<CommentPage>((resolve) => {
    release = resolve;
  });
  const loadSnapshot = vi.fn().mockResolvedValue(snapshot);
  const loadComments = vi.fn().mockReturnValue(page);
  const api = {
    ...transport,
    loadSnapshot,
    loadComments,
    loadThreads: vi.fn().mockResolvedValue({
      items: [thread],
      head: snapshot.head,
      base: snapshot.base,
      nextCursor: null,
    }),
  };
  render(
    <PrFiles
      api={api}
      pull={fixturePull}
      head={snapshot.head}
      base={snapshot.base}
    />,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Load more replies" }),
  );
  expect(loadComments).toHaveBeenCalledWith("thread", "page-2");
  // A refresh gets a distinct verified object even when the refs did not move.
  loadSnapshot.mockResolvedValue({ ...snapshot });
  fireEvent.click(screen.getByRole("button", { name: "Refresh changes" }));
  await screen.findByText("First page");
  await act(async () => {
    release({
      items: [{ ...comment, id: "late", body: "Late old page" }],
      nextCursor: null,
      thread,
      pullId: snapshot.pullId,
      head: snapshot.head,
      base: snapshot.base,
    });
  });
  expect(screen.queryByText("Late old page")).toBeNull();
  expect(
    screen.getByRole("button", { name: "Load more replies" }),
  ).toBeTruthy();
});

it("loads all three reply pages without confusing ownership with pagination", async () => {
  const fixture = githubCommentHost();
  const api = createPrComments(fixture.host);
  if (!api) throw new Error("Missing adapter");
  const snapshot = await api.loadSnapshot(fixturePull);
  const loadThreads = vi.spyOn(api, "loadThreads");
  seed(fixture.state);
  const root = fixture.state.comments[0];
  if (!root) throw new Error("Missing root");
  for (let id = 2; id <= 201; id++)
    fixture.state.comments.push({
      ...root,
      id,
      node_id: `comment-${id}`,
      body: `Comment ${id}`,
      in_reply_to_id: root.id,
    });
  render(
    <PrFiles
      api={api}
      pull={fixturePull}
      head={snapshot.head}
      base={snapshot.base}
    />,
  );
  const firstMore = (await screen.findByText("Load more replies")).closest(
    "button",
  );
  if (!firstMore) throw new Error("Missing pagination button");
  fireEvent.click(firstMore);
  await screen.findByText("Comment 200");
  const lastMore = screen.getByText("Load more replies").closest("button");
  if (!lastMore) throw new Error("Missing pagination button");
  fireEvent.click(lastMore);
  await screen.findByText("Comment 201");
  expect(lastMore.isConnected).toBe(false);
  expect(screen.queryByText("Load more replies")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByText("Comment 1")).toBeTruthy();
  expect(loadThreads).toHaveBeenCalledTimes(1);
});

it.each([
  "pullId",
  "head",
  "base",
  "id",
  "path",
  "side",
  "rootCommentId",
  "line",
  "outdated",
] as const)("rejects a reply page when %s ownership changes", async (field) => {
  const fixture = githubCommentHost();
  const transport = createPrComments(fixture.host);
  if (!transport) throw new Error("Missing adapter");
  seed(fixture.state);
  seed(fixture.state, "Late reply", 2, 1);
  fixture.state.pageSize = 1;
  const snapshot = await transport.loadSnapshot(fixturePull);
  const loadThreads = vi.spyOn(transport, "loadThreads");
  const api = {
    ...transport,
    async loadComments(...args: Parameters<typeof transport.loadComments>) {
      const page = await transport.loadComments(...args);
      if (field === "pullId" || field === "head" || field === "base")
        return { ...page, [field]: "changed" };
      return {
        ...page,
        thread: {
          ...page.thread,
          [field]:
            field === "line" || field === "rootCommentId"
              ? 99
              : field === "outdated"
                ? true
                : field === "side"
                  ? "LEFT"
                  : "changed",
        },
      } as CommentPage;
    },
  };
  render(
    <PrFiles
      api={api}
      pull={fixturePull}
      head={snapshot.head}
      base={snapshot.base}
    />,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Load more replies" }),
  );
  await screen.findByText("Thread changed; refresh changes.");
  expect(screen.queryByText("Late reply")).toBeNull();
  expect(loadThreads).toHaveBeenCalledTimes(1);
});
