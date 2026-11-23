import { GhStartFailed, GitHubError, type GitHubCli } from "./gh";
import type { Comment, Snapshot } from "./pr-comments";

export type CommentChange = { body: string } | { delete: true };
type State = Readonly<{
  phase: "pending" | "unknown" | "error" | "ready";
  viewer: string;
  pullId: string;
  change: CommentChange;
  body?: string;
  checking: boolean;
  error?: string | undefined;
}>;
type ReadResult = {
  viewer: { login: string };
  node: Node | null;
  pull: { id: string } | null;
};
type Node = {
  id: string;
  body: string;
  viewerCanUpdate: boolean;
  viewerCanDelete: boolean;
  pullRequest: { id: string };
};
export type PrCommentActions = ReturnType<typeof createPrCommentActions>;

/** Retains mutation receipts and uncertain writes across panel remounts. */
export function createPrCommentActions(gh: GitHubCli) {
  const states = new Map<string, State>();
  const versions = new Map<string, number>();
  const listeners = new Set<() => void>();
  let revision = 0;
  const publish = (id: string, state: State) => {
    states.set(id, state);
    versions.set(id, ++revision);
    for (const notify of listeners) notify();
  };
  return {
    subscribe(notify: () => void) {
      listeners.add(notify);
      return () => {
        listeners.delete(notify);
      };
    },
    get: (id: string) => states.get(id),
    revision: () => revision,
    accept(
      comment: Pick<Comment, "id" | "body">,
      viewer: string,
      pullId: string,
      started: number,
    ) {
      const state = states.get(comment.id);
      if (
        state &&
        (state.phase === "error" ||
          (state.phase === "ready" && "body" in state.change)) &&
        state.viewer === viewer &&
        state.pullId === pullId &&
        (versions.get(comment.id) ?? 0) <= started
      )
        publish(comment.id, {
          ...state,
          phase: "ready",
          change: { body: comment.body },
          body: comment.body,
          error: undefined,
        });
    },
    async update(snapshot: Snapshot, comment: Comment, change?: CommentChange) {
      const previous = states.get(comment.id);
      if (
        previous?.phase === "pending" ||
        (change && previous?.phase === "unknown")
      )
        return false;
      if (!change && previous?.phase !== "unknown") return false;
      if (
        previous?.phase === "unknown" &&
        (previous.viewer !== snapshot.viewer ||
          previous.pullId !== snapshot.pullId)
      )
        return false;
      const desired = change ?? previous?.change;
      if (!desired) return false;
      const scope = {
        viewer: snapshot.viewer,
        pullId: snapshot.pullId,
        change: desired,
        checking: !change,
        ...(previous?.viewer === snapshot.viewer &&
        previous.pullId === snapshot.pullId &&
        previous.body !== undefined
          ? { body: previous.body }
          : {}),
      };
      publish(comment.id, { ...scope, phase: "pending" });
      let dispatched = false;
      try {
        let data: ReadResult;
        try {
          data = await gh<ReadResult>(
            `query($id:ID!,$pull:ID!){viewer{login} pull:node(id:$pull){... on PullRequest{id}} node(id:$id){... on PullRequestReviewComment{id body viewerCanUpdate viewerCanDelete pullRequest{id}}}}`,
            { id: comment.id, pull: snapshot.pullId },
          );
        } catch (error) {
          // GitHub may report a deleted node as NOT_FOUND with partial data.
          const partial =
            error instanceof GitHubError
              ? (error.data as ReadResult | undefined)
              : undefined;
          if (
            !change &&
            "delete" in desired &&
            error instanceof GitHubError &&
            error.type === "NOT_FOUND" &&
            partial?.node === null &&
            partial.viewer?.login === snapshot.viewer &&
            partial.pull?.id === snapshot.pullId
          )
            data = partial;
          else throw error;
        }
        if (
          data.viewer.login !== snapshot.viewer ||
          data.pull?.id !== snapshot.pullId ||
          (data.node &&
            (data.node.id !== comment.id ||
              data.node.pullRequest?.id !== snapshot.pullId))
        )
          throw new Error(
            "The GitHub account or comment changed. Refresh the pull request.",
          );
        if (!change) {
          if (
            "delete" in desired
              ? data.node !== null
              : data.node?.body !== desired.body
          ) {
            publish(comment.id, {
              ...scope,
              phase: "unknown",
              error: "The change is not visible yet. Check again later.",
            });
            return false;
          }
        } else {
          const node = data.node;
          if (
            !node ||
            !("delete" in desired ? node.viewerCanDelete : node.viewerCanUpdate)
          )
            throw new Error(
              "GitHub no longer allows this comment change. Refresh the pull request.",
            );
          if (node.body !== comment.body)
            throw new Error(
              "This comment changed on GitHub. Refresh before editing or deleting it.",
            );
          if (!("delete" in desired) && !desired.body.trim())
            throw new Error("A comment cannot be empty.");
          dispatched = true;
          if ("delete" in desired) {
            const result = await gh<{
              deletePullRequestReviewComment: { clientMutationId: string };
            }>(
              `mutation($id:ID!,$receipt:String!){deletePullRequestReviewComment(input:{id:$id,clientMutationId:$receipt}){clientMutationId}}`,
              { id: comment.id, receipt: comment.id },
            );
            if (
              result.deletePullRequestReviewComment?.clientMutationId !==
              comment.id
            )
              throw new Error("GitHub did not confirm deletion.");
          } else {
            const result = await gh<{
              updatePullRequestReviewComment: {
                pullRequestReviewComment: { id: string; body: string };
              };
            }>(
              `mutation($id:ID!,$body:String!){updatePullRequestReviewComment(input:{pullRequestReviewCommentId:$id,body:$body}){pullRequestReviewComment{id body}}}`,
              { id: comment.id, body: desired.body },
            );
            const updated =
              result.updatePullRequestReviewComment?.pullRequestReviewComment;
            if (updated?.id !== comment.id || updated.body !== desired.body)
              throw new Error("GitHub did not confirm the updated comment.");
          }
        }
        publish(comment.id, {
          ...scope,
          phase: "ready",
          ...("body" in desired ? { body: desired.body } : {}),
        });
        return true;
      } catch (error) {
        const refused =
          error instanceof GhStartFailed ||
          (error instanceof GitHubError &&
            [
              "FORBIDDEN",
              "NOT_FOUND",
              "UNPROCESSABLE",
              "RATE_LIMITED",
              "GRAPHQL_VALIDATION_FAILED",
            ].includes(error.type ?? ""));
        publish(comment.id, {
          ...scope,
          phase:
            previous?.phase === "unknown" || (dispatched && !refused)
              ? "unknown"
              : "error",
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    },
  };
}
