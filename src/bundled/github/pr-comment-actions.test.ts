import { expect, it, vi } from "vitest";
import { createPrCommentActions } from "./pr-comment-actions";
import { GhStartFailed, parseAnswer, GitHubError, type GitHubCli } from "./gh";
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
  author: "alex",
  body: "Hello",
  url: "https://example.org/comment",
  viewerCanUpdate: true,
  viewerCanDelete: true,
};
function fixture() {
  const state = {
    viewer: "alex",
    pullId: "pull",
    body: "Hello",
    update: true,
    delete: true,
    exists: true,
    lost: false,
    refused: false,
    readFailed: false,
    apply: true,
    gate: undefined as Promise<void> | undefined,
  };
  const gh = vi.fn(
    async (query: string, variables: Record<string, unknown>) => {
      if (query.startsWith("query")) {
        if (state.readFailed) throw new Error("Read failed");
        return {
          viewer: { login: state.viewer },
          pull: { id: state.pullId },
          node: state.exists
            ? {
                id: comment.id,
                body: state.body,
                viewerCanUpdate: state.update,
                viewerCanDelete: state.delete,
                pullRequest: { id: state.pullId },
              }
            : null,
        };
      }
      await state.gate;
      if (state.refused) throw new GitHubError("Denied", "FORBIDDEN");
      if (state.apply) {
        if (query.includes("deletePullRequestReviewComment"))
          state.exists = false;
        else state.body = String(variables.body);
      }
      if (state.lost) throw new Error("Lost response");
      return query.includes("deletePullRequestReviewComment")
        ? {
            deletePullRequestReviewComment: {
              clientMutationId: variables.receipt,
            },
          }
        : {
            updatePullRequestReviewComment: {
              pullRequestReviewComment: { id: comment.id, body: state.body },
            },
          };
    },
  );
  return {
    state,
    gh,
    api: createPrCommentActions(gh as GitHubCli),
    mutations: () => gh.mock.calls.filter(([q]) => q.startsWith("mutation")),
  };
}
it("edits and deletes using node IDs and verifies mutation receipts", async () => {
  const { api, state, mutations } = fixture();
  expect(await api.update(snapshot, comment, { body: "Edited" })).toBe(true);
  expect(mutations()[0]?.[1]).toEqual({ id: comment.id, body: "Edited" });
  expect(
    await api.update(
      snapshot,
      { ...comment, body: "Edited" },
      { delete: true },
    ),
  ).toBe(true);
  expect(state.exists).toBe(false);
  expect(mutations()[1]?.[1]).toEqual({ id: comment.id, receipt: comment.id });
});
it.each(["viewer", "pull", "body", "permission", "missing", "empty"])(
  "refuses %s changes before dispatch",
  async (reason) => {
    const { api, state, mutations } = fixture();
    if (reason === "viewer") state.viewer = "other";
    if (reason === "pull") state.pullId = "other";
    if (reason === "body") state.body = "Changed elsewhere";
    if (reason === "permission") {
      state.update = false;
      state.delete = false;
    }
    if (reason === "missing") state.exists = false;
    expect(
      await api.update(snapshot, comment, {
        body: reason === "empty" ? "  " : "Edited",
      }),
    ).toBe(false);
    expect(mutations()).toHaveLength(0);
    expect(api.get(comment.id)?.phase).toBe("error");
    if (reason !== "empty") {
      expect(await api.update(snapshot, comment, { delete: true })).toBe(false);
      expect(mutations()).toHaveLength(0);
    }
  },
);
it.each([false, true])(
  "locks a lost response and reconciles without replay (delete=%s)",
  async (deleting) => {
    const { api, state, mutations } = fixture();
    state.lost = true;
    expect(
      await api.update(
        snapshot,
        comment,
        deleting ? { delete: true } : { body: "Edited" },
      ),
    ).toBe(false);
    expect(api.get(comment.id)?.phase).toBe("unknown");
    expect(await api.update(snapshot, comment, { body: "Retry" })).toBe(false);
    state.readFailed = true;
    expect(await api.update(snapshot, comment)).toBe(false);
    expect(api.get(comment.id)?.phase).toBe("unknown");
    state.readFailed = false;
    expect(await api.update({ ...snapshot, viewer: "other" }, comment)).toBe(
      false,
    );
    expect(await api.update(snapshot, comment)).toBe(true);
    expect(api.get(comment.id)?.phase).toBe("ready");
    expect(mutations()).toHaveLength(1);
  },
);
it("retains an unknown lock while a delayed write has not appeared", async () => {
  const { api, state, mutations } = fixture();
  state.lost = true;
  state.apply = false;
  await api.update(snapshot, comment, { body: "Edited" });
  expect(await api.update(snapshot, comment)).toBe(false);
  expect(api.get(comment.id)?.phase).toBe("unknown");
  state.body = "Edited";
  expect(await api.update(snapshot, comment)).toBe(true);
  expect(mutations()).toHaveLength(1);
});
it("serializes mutations and rejects stale, mismatched receipt reads", async () => {
  const { api, state, mutations, gh } = fixture();
  let release = () => {};
  state.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = api.revision();
  const writing = api.update(snapshot, comment, { body: "Edited" });
  await vi.waitFor(() => expect(mutations()).toHaveLength(1));
  try {
    const calls = gh.mock.calls.length;
    expect(await api.update(snapshot, comment, { delete: true })).toBe(false);
    expect(gh.mock.calls).toHaveLength(calls);
  } finally {
    release();
  }
  await writing;
  api.accept(
    { ...comment, body: "Edited" },
    snapshot.viewer,
    snapshot.pullId,
    started,
  );
  expect(api.get(comment.id)?.phase).toBe("ready");
  api.accept(comment, snapshot.viewer, snapshot.pullId, api.revision());
  api.accept(
    { ...comment, body: "Edited" },
    "other",
    snapshot.pullId,
    api.revision(),
  );
  expect(api.get(comment.id)?.phase).toBe("ready");
  api.accept(
    { ...comment, body: "Edited" },
    snapshot.viewer,
    snapshot.pullId,
    api.revision(),
  );
  expect(api.get(comment.id)?.change).toEqual({ body: "Edited" });
});
it("allows retry after a definite refusal", async () => {
  const { api, state } = fixture();
  state.refused = true;
  await api.update(snapshot, comment, { delete: true });
  expect(api.get(comment.id)?.phase).toBe("error");
  state.refused = false;
  expect(await api.update(snapshot, comment, { delete: true })).toBe(true);
});

it("allows retry when gh could not start the mutation process", async () => {
  const { api, gh } = fixture();
  gh.mockImplementationOnce(async () => ({
    viewer: { login: snapshot.viewer },
    pull: { id: snapshot.pullId },
    node: {
      id: comment.id,
      body: comment.body,
      viewerCanUpdate: true,
      viewerCanDelete: true,
      pullRequest: { id: snapshot.pullId },
    },
  })).mockRejectedValueOnce(new GhStartFailed("Cannot start gh"));
  expect(await api.update(snapshot, comment, { delete: true })).toBe(false);
  expect(api.get(comment.id)?.phase).toBe("error");
  expect(await api.update(snapshot, comment, { delete: true })).toBe(true);
});

it.each([true, false])(
  "reconciles deletion NOT_FOUND only with retained PR access (%s)",
  async (accessible) => {
    const { api, state, gh } = fixture();
    state.lost = true;
    await api.update(snapshot, comment, { delete: true });
    gh.mockRejectedValueOnce(
      new GitHubError("Missing", "NOT_FOUND", {
        viewer: { login: snapshot.viewer },
        node: null,
        pull: accessible ? { id: snapshot.pullId } : null,
      }),
    );
    expect(await api.update(snapshot, comment)).toBe(accessible);
    expect(api.get(comment.id)?.phase).toBe(accessible ? "ready" : "unknown");
  },
);

it("keeps an empty post-dispatch response locked", async () => {
  const { api, gh } = fixture();
  gh.mockImplementationOnce(async () => ({
    viewer: { login: snapshot.viewer },
    pull: { id: snapshot.pullId },
    node: {
      id: comment.id,
      body: comment.body,
      viewerCanUpdate: true,
      viewerCanDelete: true,
      pullRequest: { id: snapshot.pullId },
    },
  })).mockImplementationOnce(async () =>
    parseAnswer("", "connection reset", 1),
  );
  expect(await api.update(snapshot, comment, { delete: true })).toBe(false);
  expect(api.get(comment.id)?.phase).toBe("unknown");
});
it("retains confirmed edits for other mounted panels and accepts later authoritative edits", async () => {
  const { api } = fixture();
  await api.update(snapshot, comment, { body: "Edited" });
  api.accept(
    { ...comment, body: "Edited" },
    snapshot.viewer,
    snapshot.pullId,
    api.revision(),
  );
  expect(api.get(comment.id)?.change).toEqual({ body: "Edited" });
  api.accept(
    { ...comment, body: "New remote edit" },
    snapshot.viewer,
    snapshot.pullId,
    api.revision(),
  );
  expect(api.get(comment.id)?.body).toBe("New remote edit");
});

it("retains a confirmed body through a later refused mutation", async () => {
  const { api, state } = fixture();
  await api.update(snapshot, comment, { body: "Edited" });
  state.refused = true;
  await api.update(snapshot, { ...comment, body: "Edited" }, { delete: true });
  expect(api.get(comment.id)?.phase).toBe("error");
  expect(api.get(comment.id)?.body).toBe("Edited");
});

it.each([false, true])(
  "accepts refreshed remote text after a definite stale-body refusal (delete=%s)",
  async (deleting) => {
    const { api, state } = fixture();
    await api.update(snapshot, comment, { body: "Edited" });
    state.body = "Remote edit";
    await api.update(
      snapshot,
      { ...comment, body: "Edited" },
      deleting ? { delete: true } : { body: "Another edit" },
    );
    expect(api.get(comment.id)?.phase).toBe("error");
    api.accept(
      { ...comment, body: state.body },
      snapshot.viewer,
      snapshot.pullId,
      api.revision(),
    );
    expect(api.get(comment.id)?.body).toBe("Remote edit");
    expect(api.get(comment.id)?.error).toBeUndefined();
    expect(
      await api.update(
        snapshot,
        { ...comment, body: state.body },
        deleting ? { delete: true } : { body: "Another edit" },
      ),
    ).toBe(true);
  },
);
