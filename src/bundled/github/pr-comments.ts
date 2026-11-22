import { commentLines } from "../diffs/comment-lines";
import type { Host } from "../../features/host/service";
import {
  gitHubCli,
  gitHubDiff,
  gitHubRest,
  GitHubRestError,
  GhUnavailable,
  GitHubError,
} from "./gh";
import { parsePatch } from "../diffs/parse";

export type PullRef = Readonly<{ repository: string; number: number }>;
export type Side = "LEFT" | "RIGHT";
export type Snapshot = PullRef &
  Readonly<{
    pullId: string;
    viewer: string;
    head: string;
    base: string;
    diff: string;
    files: readonly { path: string; previousPath?: string | undefined }[];
  }>;
export type Anchor = Readonly<{
  head: string;
  base: string;
  path: string;
  side: Side;
  line: number;
}>;
export type Comment = Readonly<{
  id: string;
  databaseId: number;
  body: string;
  author: string;
  avatarUrl?: string | undefined;
  url: string;
}>;
export type Thread = Readonly<{
  id: string;
  path: string;
  side: Side;
  line: number | null;
  originalLine: number | null;
  outdated: boolean;
  resolved: boolean;
  rootCommentId: number;
  comments: readonly Comment[];
  commentsComplete: boolean;
  commentsCursor: string | null;
}>;
export type Page<T> = Readonly<{
  items: readonly T[];
  nextCursor: string | null;
}>;
export type CommentPage = Page<Comment> & {
  thread: Pick<
    Thread,
    "id" | "path" | "side" | "line" | "outdated" | "rootCommentId"
  >;
  pullId: string;
  head: string;
  base: string;
};
export class PrCommentError extends Error {
  constructor(
    message: string,
    readonly kind:
      | "unavailable"
      | "forbidden"
      | "not-found"
      | "validation"
      | "rate-limited"
      | "transient",
  ) {
    super(message);
  }
}
export interface PrComments {
  loadSnapshot(pull: PullRef, signal?: AbortSignal): Promise<Snapshot>;
  loadThreads(
    pull: PullRef,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<Page<Thread> & { head: string; base: string }>;
  loadComments(
    threadId: string,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<CommentPage>;
}
function failure(error: unknown): PrCommentError {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof PrCommentError) return error;
  const graphType = error instanceof GitHubError ? error.type : undefined;
  const status =
    error instanceof GitHubRestError
      ? error.status
      : graphType === "FORBIDDEN"
        ? 403
        : graphType === "NOT_FOUND"
          ? 404
          : graphType === "RATE_LIMITED"
            ? 429
            : 0;
  const kind =
    /rate limit|secondary limit/i.test(message) || status === 429
      ? "rate-limited"
      : status === 401 || error instanceof GhUnavailable
        ? "unavailable"
        : status === 403
          ? "forbidden"
          : status === 404
            ? "not-found"
            : status === 400 || status === 422
              ? "validation"
              : "transient";
  return new PrCommentError(message, kind);
}
type Meta = {
  node_id: string;
  head: { sha: string };
  base: { sha: string };
  state: string;
  merged: boolean;
};
const commentFields = `id databaseId body author { login avatarUrl } url`;
type GraphComment = Omit<Comment, "author"> & {
  author: { login: string; avatarUrl?: string } | null;
};
type Connection<T> = {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
};
const pageOf = <T>(connection: Connection<T>): Page<T> => ({
  items: connection.nodes,
  nextCursor: connection.pageInfo.hasNextPage
    ? connection.pageInfo.endCursor
    : null,
});
const graphComment = (comment: GraphComment): Comment => ({
  ...comment,
  author: comment.author?.login ?? "deleted user",
  avatarUrl: comment.author?.avatarUrl,
});

const snapshotLines = new WeakMap<Snapshot, Map<string, Set<string>>>();

export function anchorInSnapshot(snapshot: Snapshot, anchor: Anchor): boolean {
  if (
    anchor.head !== snapshot.head ||
    anchor.base !== snapshot.base ||
    !Number.isSafeInteger(anchor.line) ||
    anchor.line < 1 ||
    !snapshot.files.some((file) => file.path === anchor.path)
  )
    return false;
  let paths = snapshotLines.get(snapshot);
  if (!paths) {
    paths = new Map();
    for (const part of snapshot.diff.split(/^(?=diff --git )/m)) {
      for (const file of parsePatch(part) ?? []) {
        const path = file.newPath === "/dev/null" ? file.oldPath : file.newPath;
        if (paths.has(path)) continue;
        paths.set(
          path,
          new Set(
            file.isBinary
              ? []
              : commentLines(file)
                  .flat()
                  .map(
                    (line) =>
                      `${line.side === "deletions" ? "LEFT" : "RIGHT"}:${line.lineNumber}`,
                  ),
          ),
        );
      }
    }
    snapshotLines.set(snapshot, paths);
  }
  return paths.get(anchor.path)?.has(`${anchor.side}:${anchor.line}`) ?? false;
}

/** One instance owns delivery attempts for the plugin session, across panel remounts. */
export function createPrComments(
  host: Pick<Host, "spawn">,
): PrComments | undefined {
  const availableRest = gitHubRest(host),
    gh = gitHubCli(host),
    diff = gitHubDiff(host);
  if (!availableRest || !gh || !diff) return undefined;
  const rest = availableRest;
  const endpoint = (pull: PullRef) => {
    if (
      !/^[\w.-]+\/[\w.-]+$/.test(pull.repository) ||
      !Number.isSafeInteger(pull.number) ||
      pull.number < 1
    )
      throw new PrCommentError("Unsupported pull request", "validation");
    return `repos/${pull.repository}/pulls/${pull.number}`;
  };
  const meta = (pull: PullRef, signal?: AbortSignal) =>
    rest<Meta>("GET", endpoint(pull), undefined, signal);
  const viewer = async () =>
    (await rest<{ login: string }>("GET", "user")).login;
  return {
    async loadSnapshot(pull, signal) {
      try {
        const before = await meta(pull, signal);
        const readFiles = async () => {
          const files: { path: string; previousPath?: string | undefined }[] =
            [];
          for (let page = 1; page <= 30; page++) {
            const rows = await rest<
              { filename: string; previous_filename?: string }[]
            >(
              "GET",
              `${endpoint(pull)}/files?per_page=100&page=${page}`,
              undefined,
              signal,
            );
            files.push(
              ...rows.map((row) => ({
                path: row.filename,
                previousPath: row.previous_filename,
              })),
            );
            if (rows.length < 100) break;
            if (page === 30)
              throw new PrCommentError(
                "PR has too many files to verify anchors",
                "validation",
              );
          }
          return files;
        };
        const [identity, content, files] = await Promise.all([
          viewer(),
          diff(
            {
              repository: pull.repository,
              head: before.head.sha,
              base: before.base.sha,
              merged: pull.number,
            },
            signal,
          ),
          readFiles(),
        ]);
        const after = await meta(pull, signal);
        if (
          before.node_id !== after.node_id ||
          before.head.sha !== after.head.sha ||
          before.base.sha !== after.base.sha
        )
          throw new PrCommentError(
            "PR changed while loading; refresh the diff",
            "transient",
          );
        return {
          ...pull,
          pullId: before.node_id,
          viewer: identity,
          head: before.head.sha,
          base: before.base.sha,
          diff: content,
          files,
        };
      } catch (error) {
        signal?.throwIfAborted();
        throw failure(error);
      }
    },
    async loadThreads(pull, cursor, signal) {
      try {
        type Row = Omit<
          Thread,
          | "side"
          | "outdated"
          | "resolved"
          | "rootCommentId"
          | "comments"
          | "commentsComplete"
          | "commentsCursor"
        > & {
          diffSide: Side;
          isOutdated: boolean;
          isResolved: boolean;
          comments: Connection<GraphComment>;
        };
        const [owner, name] = pull.repository.split("/");
        const data = await gh<{
          viewer: { login: string };
          repository: {
            pullRequest: {
              headRefOid: string;
              baseRefOid: string;
              reviewThreads: Connection<Row>;
            };
          };
        }>(
          `query($owner:String!,$name:String!,$number:Int!,$cursor:String){viewer{login} repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid baseRefOid reviewThreads(first:100,after:$cursor){nodes{id path diffSide line originalLine isOutdated isResolved comments(first:100){nodes{${commentFields}} pageInfo{hasNextPage endCursor}}} pageInfo{hasNextPage endCursor}}}}}`,
          { owner, name, number: pull.number, cursor: cursor ?? null },
          signal,
        );
        if (!data.repository?.pullRequest)
          throw new PrCommentError("Pull request is unavailable", "not-found");
        const page = pageOf(data.repository.pullRequest.reviewThreads);
        return {
          head: data.repository.pullRequest.headRefOid,
          base: data.repository.pullRequest.baseRefOid,
          nextCursor: page.nextCursor,
          items: page.items.map((row) => ({
            ...row,
            side: row.diffSide,
            outdated: row.isOutdated,
            resolved: row.isResolved,
            rootCommentId: row.comments.nodes[0]?.databaseId ?? 0,
            comments: row.comments.nodes.map((comment) => {
              return graphComment(comment);
            }),
            commentsComplete: !row.comments.pageInfo.hasNextPage,
            commentsCursor: row.comments.pageInfo.hasNextPage
              ? row.comments.pageInfo.endCursor
              : null,
          })),
        };
      } catch (error) {
        signal?.throwIfAborted();
        throw failure(error);
      }
    },
    async loadComments(threadId, cursor, signal) {
      try {
        const data = await gh<{
          viewer: { login: string };
          node: {
            id: string;
            path: string;
            diffSide: Side;
            line: number | null;
            isOutdated: boolean;
            pullRequest: { id: string; headRefOid: string; baseRefOid: string };
            root: { nodes: { databaseId: number }[] };
            comments: Connection<GraphComment>;
          };
        }>(
          `query($id:ID!,$cursor:String){viewer{login} node(id:$id){... on PullRequestReviewThread{id path diffSide line isOutdated pullRequest{id headRefOid baseRefOid} root:comments(first:1){nodes{databaseId}} comments(first:100,after:$cursor){nodes{${commentFields}} pageInfo{hasNextPage endCursor}}}}}`,
          { id: threadId, cursor: cursor ?? null },
          signal,
        );
        if (!data.node?.comments)
          throw new PrCommentError(
            "Comment thread is unavailable",
            "not-found",
          );
        const page = pageOf(data.node.comments);
        return {
          ...page,
          pullId: data.node.pullRequest.id,
          head: data.node.pullRequest.headRefOid,
          base: data.node.pullRequest.baseRefOid,
          thread: {
            id: data.node.id,
            path: data.node.path,
            side: data.node.diffSide,
            line: data.node.line,
            outdated: data.node.isOutdated,
            rootCommentId: data.node.root.nodes[0]?.databaseId ?? 0,
          },
          items: page.items.map((comment) => {
            return graphComment(comment);
          }),
        };
      } catch (error) {
        signal?.throwIfAborted();
        throw failure(error);
      }
    },
  };
}
