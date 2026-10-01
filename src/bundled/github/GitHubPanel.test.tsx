// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, assert, expect, it, vi } from "vitest";
import { GitHubPanel } from "./index";
import styles from "./GitHub.module.css";

assert.exists(styles.additions);
assert.exists(styles.deletions);
assert.exists(styles.branch);
assert.exists(styles.branchLabel);
const additionsClass = styles.additions;
const deletionsClass = styles.deletions;
const branchClass = styles.branch;
const branchLabelClass = styles.branchLabel;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it.each([
  ["open", false, false, "open", true],
  ["open", true, false, "Draft", false],
  ["closed", false, false, "closed", false],
  ["closed", false, true, "Merged", false],
])(
  "colors only open PRs: %s, draft=%s, merged=%s",
  async (state, draft, merged, label, open) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            title: "A small improvement",
            state,
            draft,
            merged,
            additions: 174,
            deletions: 28,
            changed_files: 6,
          }),
        ),
      ),
    );
    render(
      <GitHubPanel
        target="https://github.com/example/project/pull/1"
        close={() => {}}
      />,
    );
    await screen.findByRole("heading", { name: "A small improvement" });
    expect(screen.getByText(label).hasAttribute("data-open")).toBe(open);
    const changes = screen.getByText("Changes").parentElement;
    if (!changes) throw new Error("Missing Changes row");
    expect(changes.querySelector("dd")).toHaveTextContent("+174 / −28");
    expect(within(changes).getByText("+174")).toHaveClass(additionsClass);
    expect(within(changes).getByText("−28")).toHaveClass(deletionsClass);
  },
);

it("preserves zero counts and leaves an open issue neutral", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          title: "A small improvement",
          state: "open",
          additions: 0,
          deletions: 0,
        }),
      ),
    ),
  );
  render(
    <GitHubPanel
      target="https://github.com/example/project/issues/1"
      close={() => {}}
    />,
  );
  await screen.findByRole("heading", { name: "A small improvement" });
  expect(screen.getByText("open")).not.toHaveAttribute("data-open");
  expect(screen.getByText("+0")).toHaveClass(additionsClass);
  expect(screen.getByText("−0")).toHaveClass(deletionsClass);
});

it("links branch labels to their own repositories and preserves unavailable branches", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          title: "A fork contribution",
          state: "open",
          head: {
            label: "contributor:fix/small detail",
            ref: "fix/small detail",
            repo: { full_name: "contributor/project" },
          },
          base: {
            label: "example:main",
            ref: "main",
            repo: { full_name: "example/project" },
          },
        }),
      ),
    ),
  );
  const { unmount } = render(
    <GitHubPanel
      target="https://github.com/example/project/pull/1"
      close={() => {}}
    />,
  );
  const head = await screen.findByRole("link", {
    name: "contributor:fix/small detail",
  });
  expect(head).toHaveAttribute(
    "href",
    "https://github.com/contributor/project/tree/fix/small%20detail",
  );
  expect(head).toHaveClass(branchClass);
  expect(screen.getByRole("link", { name: "main" })).toHaveClass(branchClass);
  expect(head).toHaveAttribute("target", "_blank");
  expect(head).toHaveAttribute("rel", "noreferrer");
  expect(screen.getByRole("link", { name: "main" })).toHaveAttribute(
    "href",
    "https://github.com/example/project/tree/main",
  );
  unmount();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          title: "An unavailable branch",
          head: { label: "contributor:deleted", ref: "deleted", repo: null },
          base: { label: "example:main" },
        }),
      ),
    ),
  );
  render(
    <GitHubPanel
      target="https://github.com/example/project/pull/2"
      close={() => {}}
    />,
  );
  await screen.findByRole("heading", { name: "An unavailable branch" });
  const deleted = screen.getByText("contributor:deleted");
  expect(deleted).toBeVisible();
  expect(deleted).toHaveClass(branchLabelClass);
  expect(deleted).not.toHaveClass(branchClass);
  expect(screen.getByText("example:main")).toHaveClass(branchLabelClass);
  expect(deleted.parentElement).toHaveTextContent(
    "contributor:deleted → example:main",
  );
  expect(
    screen.queryByRole("link", { name: "contributor:deleted" }),
  ).not.toBeInTheDocument();
});
