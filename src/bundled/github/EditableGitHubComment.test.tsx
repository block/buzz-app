// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { EditableGitHubComment, type EditDraft } from "./EditableGitHubComment";
import { createPrCommentActions } from "./pr-comment-actions";
import { GitHubError, type GitHubCli } from "./gh";
import type { Comment, Snapshot } from "./pr-comments";

afterEach(cleanup);
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
  body: "Original",
  url: "https://example.org/comment",
  viewerCanUpdate: true,
  viewerCanDelete: true,
};
function fixture() {
  let body = comment.body;
  const gh = vi.fn(async (query: string) => {
    if (query.startsWith("mutation")) throw new Error("Unexpected mutation");
    return {
      viewer: { login: snapshot.viewer },
      pull: { id: snapshot.pullId },
      node: {
        id: comment.id,
        body,
        viewerCanUpdate: true,
        viewerCanDelete: true,
        pullRequest: { id: snapshot.pullId },
      },
    };
  });
  const api = createPrCommentActions(gh as GitHubCli);
  const draft: EditDraft = { body, editing: false };
  const onChanged = vi.fn();
  const ui = () => (
    <EditableGitHubComment
      api={api}
      snapshot={snapshot}
      comment={{ ...comment, body }}
      draft={draft}
      onChanged={onChanged}
    />
  );
  const view = render(ui());
  return {
    api,
    gh,
    onChanged,
    change() {
      body = "Changed elsewhere";
      view.rerender(ui());
    },
  };
}
it("uses the opened edit baseline after a newer comment renders", async () => {
  const { change, gh, onChanged } = fixture();
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), {
    target: { value: "My edit" },
  });
  change();
  expect(
    (screen.getByRole("textbox", { name: "Comment" }) as HTMLTextAreaElement)
      .value,
  ).toBe("My edit");
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await screen.findByText(/This comment changed on GitHub/);
  expect(gh.mock.calls.every(([query]) => query.startsWith("query"))).toBe(
    true,
  );
  expect(onChanged).not.toHaveBeenCalled();
});
it("uses the opened confirmation baseline after a newer comment renders", async () => {
  const { change, gh, onChanged } = fixture();
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  change();
  fireEvent.click(screen.getByRole("button", { name: "Delete comment" }));
  await screen.findByText(/This comment changed on GitHub/);
  expect(gh.mock.calls.every(([query]) => query.startsWith("query"))).toBe(
    true,
  );
  expect(onChanged).not.toHaveBeenCalled();
});
it("hides controls GitHub does not permit and restores focus after cancelling an edit", async () => {
  const api = createPrCommentActions(vi.fn() as GitHubCli);
  const draft: EditDraft = { body: comment.body, editing: false };
  const ui = (permissions: boolean) => (
    <EditableGitHubComment
      api={api}
      snapshot={snapshot}
      comment={{
        ...comment,
        viewerCanUpdate: permissions,
        viewerCanDelete: permissions,
      }}
      draft={draft}
      onChanged={() => {}}
    />
  );
  const view = render(ui(false));
  expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  view.rerender(ui(true));
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  expect(document.activeElement).toBe(
    screen.getByRole("textbox", { name: "Comment" }),
  );
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Comment" }), {
    key: "Escape",
  });
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Edit" }),
    ),
  );
});

it.each(["success", "refused", "unknown"])(
  "keeps deletion modal while pending and recovers focus on %s",
  async (outcome) => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gh = vi.fn(async (query: string) => {
      if (query.startsWith("query"))
        return {
          viewer: { login: snapshot.viewer },
          pull: { id: snapshot.pullId },
          node: {
            id: comment.id,
            body: comment.body,
            viewerCanUpdate: true,
            viewerCanDelete: true,
            pullRequest: { id: snapshot.pullId },
          },
        };
      await gate;
      if (outcome === "refused") throw new GitHubError("Denied", "FORBIDDEN");
      if (outcome === "unknown") throw new Error("Lost response");
      return {
        deletePullRequestReviewComment: { clientMutationId: comment.id },
      };
    });
    const api = createPrCommentActions(gh as GitHubCli);
    render(
      <>
        <button type="button">Refresh fallback</button>
        <EditableGitHubComment
          api={api}
          snapshot={snapshot}
          comment={comment}
          draft={{ body: comment.body, editing: false }}
          onChanged={() => {}}
          focusFallback={() =>
            screen.getByRole("button", {
              name: "Refresh fallback",
              hidden: true,
            })
          }
        />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete comment" }));
    try {
      await waitFor(() => expect(api.get(comment.id)?.phase).toBe("pending"));
      expect(screen.getByRole("alertdialog")).toBeTruthy();
      expect(
        (
          screen.getByRole("button", {
            name: "Delete comment",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
    } finally {
      release();
    }
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", {
          name:
            outcome === "success"
              ? "Refresh fallback"
              : outcome === "refused"
                ? "Delete"
                : "Check comment",
        }),
      ),
    );
    if (outcome === "unknown") {
      const check = screen.getByRole("button", { name: "Check comment" });
      check.focus();
      fireEvent.click(check);
      await waitFor(() => expect(api.get(comment.id)?.phase).toBe("unknown"));
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Check comment" }),
      );
    }
  },
);
