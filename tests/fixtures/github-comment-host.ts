import type {
  ReactionGroup,
  ReactionContent,
} from "../../src/bundled/github/pr-reactions";
import type { Host, HostProcessOptions } from "../../src/features/host/service";

export const fixturePull = { repository: "example-org/sample", number: 1 };
export const fixturePatch = `diff --git a/src/old.ts b/src/example.ts
similarity index 80%
rename from src/old.ts
rename to src/example.ts
--- a/src/old.ts
+++ b/src/example.ts
@@ -5000,2 +5000,3 @@
-const previous = true;
+const current = true;
+const inserted = true;
 export const context = true;
`;
export function githubCommentHost() {
  type Row = {
    id: number;
    node_id: string;
    body: string;
    user: { login: string };
    html_url: string;
    created_at: string;
    commit_id: string;
    original_commit_id: string;
    path: string;
    side: string;
    line: number;
    original_line: number;
    in_reply_to_id?: number | undefined;
  };
  const state = {
    patch: fixturePatch,
    head: "a".repeat(40),
    base: "b".repeat(40),
    viewer: "example-reviewer",
    mode: "success" as
      | "success"
      | "denied"
      | "validation"
      | "timeout"
      | "refresh-failed"
      | "hold",
    comments: [] as Row[],
    reactions: {} as Record<string, ReactionGroup[]>,
    calls: [] as { id: string; args: readonly string[]; input: unknown }[],
    pageSize: 100,
    files: [{ filename: "src/example.ts", previous_filename: "src/old.ts" }],
    onCall: (_call: {
      id: string;
      args: readonly string[];
      input: unknown;
    }) => {},
    merged: false,
    snapshotFailed: false,
    refreshFailed: false,
    release: () => {},
  };
  const graphComment = (row: Row) => ({
    id: row.node_id,
    databaseId: row.id,
    body: row.body,
    author: { ...row.user, avatarUrl: "./design-system/assets/avatar.png" },
    reactionGroups: state.reactions[row.node_id] ?? [],
    url: row.html_url,
  });
  const page = <T>(nodes: T[], cursor?: string | null) => {
    const start = Number(cursor ?? 0);
    const end = start + state.pageSize;
    return {
      nodes: nodes.slice(start, end),
      pageInfo: {
        hasNextPage: end < nodes.length,
        endCursor: end < nodes.length ? String(end) : null,
      },
    };
  };
  const spawn: NonNullable<Host["spawn"]> = async (
    id,
    options: HostProcessOptions = {},
  ) => {
    let exit: (code: number | null) => void = () => {};
    const exited = new Promise<number | null>((resolve) => {
      exit = resolve;
    });
    return {
      write: async () => {},
      kill: async () => {
        exit(null);
      },
      exited,
      end: async (input = "") => {
        const value = JSON.parse(input || "{}") as Record<string, unknown>;
        state.calls.push({ id, args: options.args ?? [], input: value });
        state.onCall({ id, args: options.args ?? [], input: value });
        const variables = (value.variables ?? {}) as {
          id?: string;
          cursor?: string;
          content?: ReactionContent;
        };
        const answer = (data: unknown, status = 200) => {
          options.onStdout?.(
            id === "rest"
              ? `HTTP/2.0 ${status} Test\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(data)}`
              : JSON.stringify({ data }),
          );
          if (status >= 400)
            options.onStderr?.(`gh: Request refused (HTTP ${status})`);
          exit(status >= 400 ? 1 : 0);
        };
        if (id === "diff") {
          options.onStdout?.(state.patch);
          exit(0);
          return;
        }
        if (id === "graphql") {
          const query = String(value.query);
          if (
            query.includes("PullRequestReviewComment") ||
            query.startsWith("mutation")
          ) {
            const row = state.comments.find(
              (row) => row.node_id === variables.id,
            );
            if (!row) {
              answer({ node: null, viewer: { login: state.viewer } });
              return;
            }
            let groups = state.reactions[row.node_id] ?? [];
            if (query.startsWith("mutation")) {
              const add = query.includes("addReaction");
              const old = groups.find(
                (group) => group.content === variables.content,
              );
              groups = [
                ...groups.filter(
                  (group) => group.content !== variables.content,
                ),
                {
                  content: variables.content as ReactionContent,
                  viewerHasReacted: add,
                  users: {
                    totalCount: (old?.users.totalCount ?? 0) + (add ? 1 : -1),
                  },
                },
              ];
              state.reactions[row.node_id] = groups;
              answer({
                [add ? "addReaction" : "removeReaction"]: {
                  subject: { id: row.node_id, reactionGroups: groups },
                },
              });
            } else
              answer({
                viewer: { login: state.viewer },
                node: {
                  id: row.node_id,
                  pullRequest: { id: "pull-fixture" },
                  reactionGroups: groups,
                },
              });
            return;
          }

          if (String(value.query).includes("r0:")) {
            answer({
              r0: {
                viewerDefaultMergeMethod: "SQUASH",
                squashMergeAllowed: true,
                mergeCommitAllowed: true,
                pullRequest: {
                  id: "pull-fixture",
                  title: "Inline comments demonstration",
                  state: "OPEN",
                  isDraft: false,
                  body: "Fictional pull request. Every GitHub endpoint is stubbed locally.",
                  author: { login: "example-reviewer" },
                  baseRefName: "main",
                  baseRefOid: state.base,
                  headRefName: "example-change",
                  headRefOid: state.head,
                  headRepository: { nameWithOwner: "example-org/sample" },
                  baseRepository: { nameWithOwner: "example-org/sample" },
                  additions: 2,
                  deletions: 1,
                  changedFiles: 1,
                  mergeStateStatus: "CLEAN",
                  reviewDecision: "REVIEW_REQUIRED",
                  viewerCanUpdate: false,
                  viewerCanUpdateBranch: false,
                  viewerCanMergeAsAdmin: false,
                  reviewRequests: { nodes: [] },
                  latestOpinionatedReviews: { nodes: [] },
                  reviewThreads: { nodes: [] },
                  commits: { nodes: [] },
                },
              },
            });
            return;
          }
          if (
            state.mode === "refresh-failed" &&
            state.comments.length &&
            !state.refreshFailed
          ) {
            state.refreshFailed = true;
            throw new Error("Synthetic thread refresh failed");
          }
          const threads = state.comments
            .filter((row) => !row.in_reply_to_id)
            .map((root) => ({
              id: `thread-${root.id}`,
              path: root.path,
              diffSide: root.side,
              line: root.line,
              originalLine: root.original_line,
              isOutdated: root.commit_id !== state.head,
              isResolved: false,
              comments: page(
                state.comments
                  .filter(
                    (row) =>
                      row.id === root.id || row.in_reply_to_id === root.id,
                  )
                  .map(graphComment),
              ),
            }));
          if (String(value.query).includes("$id:ID!")) {
            const root = state.comments.find(
              (row) => `thread-${row.id}` === variables.id,
            );
            answer({
              viewer: { login: state.viewer },
              node: root
                ? {
                    id: `thread-${root.id}`,
                    path: root.path,
                    diffSide: root.side,
                    line: root.line,
                    isOutdated: root.commit_id !== state.head,
                    pullRequest: {
                      id: "pull-fixture",
                      headRefOid: state.head,
                      baseRefOid: state.base,
                    },
                    root: { nodes: [{ databaseId: root.id }] },
                    comments: page(
                      state.comments
                        .filter(
                          (row) =>
                            row.id === root.id ||
                            row.in_reply_to_id === root.id,
                        )
                        .map(graphComment),
                      variables.cursor,
                    ),
                  }
                : null,
            });
          } else
            answer({
              viewer: { login: state.viewer },
              repository: {
                pullRequest: {
                  headRefOid: state.head,
                  baseRefOid: state.base,
                  reviewThreads: page(threads, variables.cursor),
                },
              },
            });
          return;
        }
        if (id !== "rest")
          throw new Error(`Undeclared fixture operation ${id}`);
        const [method, path = ""] = options.args ?? [];
        if (path === "user") {
          answer({ login: state.viewer });
          return;
        }
        if (method === "GET") {
          if (state.snapshotFailed && !path.includes("/comments?")) {
            answer({ message: "Synthetic snapshot refresh failed" }, 503);
            return;
          }
          if (path.includes("/files?")) {
            const pageNumber = Number(
              new URLSearchParams(path.split("?")[1]).get("page"),
            );
            answer(state.files.slice((pageNumber - 1) * 100, pageNumber * 100));
          } else if (path.includes("/comments?")) answer(state.comments);
          else
            answer({
              node_id: "pull-fixture",
              head: { sha: state.head },
              base: { sha: state.base },
              state: state.merged ? "closed" : "open",
              merged: state.merged,
            });
          return;
        }
        if (state.mode === "denied" || state.mode === "validation") {
          answer(
            {
              message:
                state.mode === "denied"
                  ? "Resource not accessible"
                  : "Invalid diff line",
            },
            state.mode === "denied" ? 403 : 422,
          );
          return;
        }
        if (state.mode === "hold")
          await new Promise<void>((resolve) => {
            state.release = resolve;
          });
        const rootId = /\/comments\/(\d+)\/replies$/.exec(path)?.[1];
        const root = rootId
          ? state.comments.find((row) => row.id === Number(rootId))
          : undefined;
        const nextId = state.comments.length + 1;
        const row: Row = {
          id: nextId,
          node_id: `comment-${nextId}`,
          body: String(value.body),
          user: { login: state.viewer },
          html_url: `https://github.com/example-org/sample/pull/1#discussion_r${nextId}`,
          created_at: "2026-01-01T00:00:00Z",
          commit_id: String(value.commit_id ?? root?.commit_id ?? state.head),
          original_commit_id: String(
            value.commit_id ?? root?.commit_id ?? state.head,
          ),
          path: String(value.path ?? root?.path),
          side: String(value.side ?? root?.side),
          line: Number(value.line ?? root?.line),
          original_line: Number(value.line ?? root?.line),
          in_reply_to_id: root?.id,
        };
        state.comments.push(row);
        if (state.mode === "timeout")
          throw new Error("Synthetic timeout after GitHub stored the comment");
        answer(row, 201);
      },
    };
  };
  return { state, host: { spawn } };
}
