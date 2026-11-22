import { expect, it, vi } from "vitest";
import {
  createPrReactions,
  type ReactionContent,
  type ReactionGroup,
} from "./pr-reactions";
import { GitHubError, type GitHubCli } from "./gh";
import type { Comment, Snapshot } from "./pr-comments";

const snapshot: Snapshot = {
  repository: "example-org/sample",
  number: 1,
  pullId: "pull",
  viewer: "alex",
  head: "a",
  base: "b",
  diff: "",
  files: [],
};
const comment: Comment = {
  id: "comment",
  databaseId: 1,
  author: "sam",
  body: "Hello",
  url: "https://example.org/comment",
};
function fixture() {
  let groups: ReactionGroup[] = [
    { content: "HEART", viewerHasReacted: false, users: { totalCount: 3 } },
  ];
  const state = {
    viewer: "alex",
    pull: "pull",
    fail: false,
    refused: false,
    release: undefined as (() => void) | undefined,
    hold: false,
  };
  const gh = vi.fn(
    async (query: string, variables: Record<string, unknown>) => {
      if (query.startsWith("query")) {
        if (state.fail) throw new Error("Read failed");
        return {
          viewer: { login: state.viewer },
          node: {
            id: variables.id,
            pullRequest: { id: state.pull },
            reactionGroups: groups,
          },
        };
      }
      if (state.hold)
        await new Promise<void>((resolve) => {
          state.release = resolve;
        });
      if (state.refused) throw new GitHubError("Denied", "FORBIDDEN");
      const content = variables.content as ReactionContent;
      const add = query.includes("addReaction");
      const before = groups.find((group) => group.content === content);
      groups = [
        ...groups.filter((group) => group.content !== content),
        {
          content,
          viewerHasReacted: add,
          users: {
            totalCount: (before?.users.totalCount ?? 0) + (add ? 1 : -1),
          },
        },
      ];
      if (state.fail) throw new Error("Lost response");
      return {
        [add ? "addReaction" : "removeReaction"]: {
          subject: { id: variables.id, reactionGroups: groups },
        },
      };
    },
  );
  const api = createPrReactions(gh as GitHubCli);
  return {
    api,
    state,
    gh,
    mutations: () =>
      gh.mock.calls.filter(([query]) => query.startsWith("mutation")),
  };
}
it("uses comment node IDs, desired-state add/remove and authoritative counts", async () => {
  const { api, mutations } = fixture();
  await api.update(snapshot, comment, { content: "HEART", reacted: true });
  expect(mutations()[0]?.[1]).toEqual({ id: "comment", content: "HEART" });
  expect(api.get(comment.id)?.groups?.[0]).toMatchObject({
    viewerHasReacted: true,
    users: { totalCount: 4 },
  });
  await api.update(snapshot, comment, { content: "HEART", reacted: true });
  expect(mutations()).toHaveLength(1);
  await api.update(snapshot, comment, { content: "HEART", reacted: false });
  expect(mutations()[1]?.[0]).toContain("removeReaction");
  expect(api.get(comment.id)?.groups?.[0]?.users.totalCount).toBe(3);
});
it.each(["viewer", "pull"] as const)(
  "refuses changed %s before a mutation",
  async (field) => {
    const { api, state, mutations } = fixture();
    state[field] = "different";
    await api.update(snapshot, comment, { content: "HEART", reacted: true });
    expect(mutations()).toHaveLength(0);
    expect(api.get(comment.id)?.phase).toBe("error");
  },
);
it("locks concurrent conflicting updates but permits another comment", async () => {
  const { api, state, mutations } = fixture();
  state.hold = true;
  const pending = api.update(snapshot, comment, {
    content: "HEART",
    reacted: true,
  });
  await vi.waitFor(() => expect(state.release).toBeTypeOf("function"));
  try {
    await api.update(snapshot, comment, { content: "ROCKET", reacted: true });
    expect(mutations()).toHaveLength(1);
    expect(api.get(comment.id)?.phase).toBe("pending");
    state.hold = false;
    await api.update(
      snapshot,
      { ...comment, id: "another" },
      { content: "EYES", reacted: true },
    );
    expect(mutations()).toHaveLength(2);
  } finally {
    state.release?.();
    await pending;
  }
});
it("keeps unknown outcomes locked across refresh and failed checks without replay", async () => {
  const { api, state, mutations } = fixture();
  state.hold = true;
  const pending = api.update(snapshot, comment, {
    content: "HEART",
    reacted: true,
  });
  await vi.waitFor(() => expect(state.release).toBeTypeOf("function"));
  state.fail = true;
  state.release?.();
  await pending;
  expect(api.get(comment.id)?.phase).toBe("unknown");
  api.accept(comment.id, snapshot.viewer, [], api.revision());
  await api.update(snapshot, comment, { content: "HEART", reacted: true });
  await api.update(snapshot, comment);
  expect(api.get(comment.id)?.phase).toBe("unknown");
  expect(mutations()).toHaveLength(1);
  state.fail = false;
  await api.update(snapshot, comment);
  expect(api.get(comment.id)?.phase).toBe("ready");
  expect(api.get(comment.id)?.groups?.[0]?.users.totalCount).toBe(4);
  expect(mutations()).toHaveLength(1);
});
it("unlocks definitive refusals without claiming a count change", async () => {
  const { api, state } = fixture();
  state.refused = true;
  await api.update(snapshot, comment, { content: "HEART", reacted: true });
  expect(api.get(comment.id)).toMatchObject({
    phase: "error",
    error: "Denied",
  });
  expect(api.get(comment.id)?.groups).toBeUndefined();
});

it("keeps a timed-out mutation locked when a check precedes delayed server application", async () => {
  let applied = false;
  let apply: () => void = () => {};
  const gh = vi.fn(async (query: string) => {
    if (query.startsWith("mutation")) {
      apply = () => {
        applied = true;
      };
      throw new Error("Response timed out before server completion");
    }
    return {
      viewer: { login: "alex" },
      node: {
        id: comment.id,
        pullRequest: { id: snapshot.pullId },
        reactionGroups: [
          {
            content: "HEART",
            viewerHasReacted: applied,
            users: { totalCount: applied ? 4 : 3 },
          },
        ],
      },
    };
  });
  const api = createPrReactions(gh as GitHubCli);
  await api.update(snapshot, comment, { content: "HEART", reacted: true });
  expect(api.get(comment.id)?.phase).toBe("unknown");
  await api.update(snapshot, comment);
  expect(api.get(comment.id)?.phase).toBe("unknown");
  await api.update(snapshot, comment, { content: "HEART", reacted: true });
  expect(
    gh.mock.calls.filter(([query]) => query.startsWith("mutation")),
  ).toHaveLength(1);
  apply();
  await api.update(snapshot, comment);
  expect(api.get(comment.id)?.phase).toBe("ready");
  expect(api.get(comment.id)?.groups?.[0]?.users.totalCount).toBe(4);
});

it("accepts fresh counts but rejects reads begun before a newer mutation", async () => {
  const { api } = fixture();
  const oldRead = api.revision();
  await api.update(snapshot, comment, { content: "HEART", reacted: true });
  const fresh = [
    { content: "HEART", viewerHasReacted: true, users: { totalCount: 9 } },
  ] as const;
  api.accept(comment.id, snapshot.viewer, fresh, oldRead);
  expect(api.get(comment.id)?.groups?.[0]?.users.totalCount).toBe(4);
  api.accept(comment.id, snapshot.viewer, fresh, api.revision());
  expect(api.get(comment.id)?.groups?.[0]?.users.totalCount).toBe(9);
});
