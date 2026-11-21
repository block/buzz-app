import { GitHubError, type GitHubCli } from "./gh";
import type { Comment, Snapshot } from "./pr-comments";

export const reactionNames = {
  THUMBS_UP: ["👍", "Thumbs up"],
  THUMBS_DOWN: ["👎", "Thumbs down"],
  LAUGH: ["😄", "Laugh"],
  HOORAY: ["🎉", "Hooray"],
  CONFUSED: ["😕", "Confused"],
  HEART: ["❤️", "Heart"],
  ROCKET: ["🚀", "Rocket"],
  EYES: ["👀", "Eyes"],
} as const;
export type ReactionContent = keyof typeof reactionNames;
export type ReactionGroup = Readonly<{
  content: ReactionContent;
  viewerHasReacted: boolean;
  users: { totalCount: number };
}>;
export const reactionFields =
  "reactionGroups { content viewerHasReacted users { totalCount } }";
type Desired = { content: ReactionContent; reacted: boolean };
type State = Readonly<{
  desired?: Desired | undefined;
  phase: "pending" | "unknown" | "error" | "ready";
  viewer: string;
  pullId: string;
  groups?: readonly ReactionGroup[];
  error?: string | undefined;
}>;
export type PrReactions = ReturnType<typeof createPrReactions>;

/** Keeps uncertain writes locked across comment/panel remounts. Reads never replay them. */
export function createPrReactions(gh: GitHubCli) {
  const states = new Map<string, State>();
  const versions = new Map<string, number>();
  let revision = 0;
  const listeners = new Set<() => void>();
  const publish = (id: string, state: State) => {
    states.set(id, state);
    versions.set(id, ++revision);
    for (const notify of listeners) notify();
  };
  const verify = async (snapshot: Snapshot, id: string) => {
    const data = await gh<{
      viewer: { login: string };
      node: {
        id: string;
        pullRequest: { id: string };
        reactionGroups: ReactionGroup[];
      } | null;
    }>(
      `query($id:ID!){viewer{login} node(id:$id){... on PullRequestReviewComment{id pullRequest{id} ${reactionFields}}}}`,
      { id },
    );
    if (
      data.viewer.login !== snapshot.viewer ||
      data.node?.id !== id ||
      data.node.pullRequest?.id !== snapshot.pullId ||
      !Array.isArray(data.node.reactionGroups)
    )
      throw new Error(
        "The GitHub account or comment changed. Refresh the pull request.",
      );
    return data.node.reactionGroups;
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
      id: string,
      viewer: string,
      groups: readonly ReactionGroup[] | undefined,
      started: number,
    ) {
      const state = states.get(id);
      if (
        !state ||
        !groups ||
        state.viewer !== viewer ||
        (versions.get(id) ?? 0) > started ||
        state.phase === "pending" ||
        state.phase === "unknown"
      )
        return;
      publish(id, { ...state, phase: "ready", groups, error: undefined });
    },
    async update(snapshot: Snapshot, comment: Comment, desired?: Desired) {
      const previous = states.get(comment.id);
      if (
        previous?.phase === "pending" ||
        (desired && previous?.phase === "unknown")
      )
        return;
      if (
        previous?.phase === "unknown" &&
        (previous.viewer !== snapshot.viewer ||
          previous.pullId !== snapshot.pullId)
      )
        return;
      const expected = desired ?? previous?.desired;
      publish(comment.id, {
        desired: expected,
        phase: "pending",
        viewer: snapshot.viewer,
        pullId: snapshot.pullId,
        ...(previous?.viewer === snapshot.viewer && previous.groups
          ? { groups: previous.groups }
          : {}),
      });
      let dispatched = false;
      try {
        let groups = await verify(snapshot, comment.id);
        if (desired && !Object.hasOwn(reactionNames, desired.content))
          throw new Error("Unsupported reaction");
        if (
          desired &&
          (groups.find((group) => group.content === desired.content)
            ?.viewerHasReacted ?? false) !== desired.reacted
        ) {
          const action = desired.reacted ? "addReaction" : "removeReaction";
          dispatched = true;
          const data = await gh<
            Record<
              string,
              { subject: { id: string; reactionGroups: ReactionGroup[] } }
            >
          >(
            `mutation($id:ID!,$content:ReactionContent!){${action}(input:{subjectId:$id,content:$content}){subject{id ${reactionFields}}}}`,
            { id: comment.id, content: desired.content },
          );
          const subject = data[action]?.subject;
          if (
            subject?.id !== comment.id ||
            !Array.isArray(subject.reactionGroups)
          )
            throw new Error("Reaction response is incomplete");
          groups = subject.reactionGroups;
        }
        if (
          expected &&
          (groups.find((group) => group.content === expected.content)
            ?.viewerHasReacted ?? false) !== expected.reacted
        ) {
          publish(comment.id, {
            phase: "unknown",
            viewer: snapshot.viewer,
            pullId: snapshot.pullId,
            desired: expected,
            groups,
            error:
              "The requested reaction state is not visible yet. Check again later.",
          });
          return;
        }
        publish(comment.id, {
          phase: "ready",
          viewer: snapshot.viewer,
          pullId: snapshot.pullId,
          groups,
        });
      } catch (error) {
        const refused =
          error instanceof GitHubError &&
          [
            "FORBIDDEN",
            "NOT_FOUND",
            "UNPROCESSABLE",
            "RATE_LIMITED",
            "GRAPHQL_VALIDATION_FAILED",
          ].includes(error.type ?? "");
        // A failed check must retain an earlier uncertain write's lock.
        const unknown =
          (dispatched && !refused) || previous?.phase === "unknown";
        publish(comment.id, {
          phase: unknown ? "unknown" : "error",
          desired: unknown ? expected : undefined,
          viewer: snapshot.viewer,
          pullId: snapshot.pullId,
          ...(previous?.viewer === snapshot.viewer && previous.groups
            ? { groups: previous.groups }
            : {}),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
