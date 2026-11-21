// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { GitHubReactions } from "./GitHubReactions";
import { createPrReactions, type ReactionGroup } from "./pr-reactions";
import type { GitHubCli } from "./gh";
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
const groups: ReactionGroup[] = [
  { content: "HEART", viewerHasReacted: false, users: { totalCount: 3 } },
];
const comment: Comment = {
  id: "comment",
  databaseId: 1,
  author: "sam",
  body: "Hello",
  url: "https://example.org/comment",
  reactions: groups,
};
it("announces server counts and selection while isolating unknown delivery across remount", async () => {
  let release: () => void = () => {};
  let sent = false;
  const gh = vi.fn(async (query: string) => {
    if (query.startsWith("mutation")) {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      sent = true;
      throw new Error("Lost response");
    }
    return {
      viewer: { login: "alex" },
      node: {
        id: "comment",
        pullRequest: { id: "pull" },
        reactionGroups: sent
          ? [
              {
                content: "HEART",
                viewerHasReacted: true,
                users: { totalCount: 4 },
              },
            ]
          : groups,
      },
    };
  });
  const api = createPrReactions(gh as GitHubCli);
  const view = render(
    <GitHubReactions api={api} snapshot={snapshot} comment={comment} />,
  );
  const heart = () => screen.getByRole("button", { name: /^Heart,/ });
  expect(heart().getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(heart());
  await waitFor(() =>
    expect(gh.mock.calls.some(([query]) => query.startsWith("mutation"))).toBe(
      true,
    ),
  );
  expect(heart().hasAttribute("disabled")).toBe(true);
  expect(heart().getAttribute("aria-label")).toBe("Heart, 4");
  expect(heart().getAttribute("aria-busy")).toBe("true");
  expect(screen.queryByText("Updating reactions…")).toBeNull();
  await act(async () => {
    release();
  });
  expect(screen.getByRole("button", { name: "Check reactions" })).toBeTruthy();
  view.unmount();
  render(<GitHubReactions api={api} snapshot={snapshot} comment={comment} />);
  expect(heart().hasAttribute("disabled")).toBe(true);
  act(() => api.accept(comment.id, snapshot.viewer, groups, api.revision()));
  expect(heart().hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Check reactions" }));
  await waitFor(() =>
    expect(heart().getAttribute("aria-label")).toBe("Heart, 4"),
  );
  expect(heart().getAttribute("aria-pressed")).toBe("true");
  expect(
    gh.mock.calls.filter(([query]) => query.startsWith("mutation")),
  ).toHaveLength(1);
});

it("updates visible counts after an authoritative comment read", async () => {
  const gh = vi.fn(async () => ({
    viewer: { login: "alex" },
    node: {
      id: "comment",
      pullRequest: { id: "pull" },
      reactionGroups: groups,
    },
  }));
  const api = createPrReactions(gh as GitHubCli);
  render(<GitHubReactions api={api} snapshot={snapshot} comment={comment} />);
  await act(async () => {
    await api.update(snapshot, comment);
  });
  expect(screen.getByRole("button", { name: "Heart, 3" })).toBeTruthy();
  act(() =>
    api.accept(
      comment.id,
      snapshot.viewer,
      [{ content: "HEART", viewerHasReacted: false, users: { totalCount: 7 } }],
      api.revision(),
    ),
  );
  expect(screen.getByRole("button", { name: "Heart, 7" })).toBeTruthy();
});

it("shows a reaction immediately and rolls it back on a preflight failure", async () => {
  let fail: (error: Error) => void = () => {};
  const gh = vi.fn(
    () =>
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
  );
  const api = createPrReactions(gh as GitHubCli);
  render(<GitHubReactions api={api} snapshot={snapshot} comment={comment} />);
  fireEvent.click(screen.getByRole("button", { name: "Heart, 3" }));
  expect(
    screen
      .getByRole("button", { name: "Heart, 4" })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  await act(async () => {
    fail(new Error("Account unavailable"));
  });
  expect(
    screen.getByRole("button", { name: "Heart, 3" }).hasAttribute("disabled"),
  ).toBe(false);
  expect(screen.getByText("Account unavailable")).toBeTruthy();
});
