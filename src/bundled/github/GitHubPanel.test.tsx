// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
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
  ["open", false, false, "open"],
  ["open", true, false, "Draft"],
  ["closed", true, false, "closed"],
  ["closed", false, false, "closed"],
  ["closed", false, true, "Merged"],
  ["closed", true, true, "Merged"],
])(
  "presents PR state with terminal states before draft: %s, draft=%s, merged=%s",
  async (state, draft, merged, label) => {
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
    await screen.findByRole("heading", { name: "A small improvement #1" });
    expect(screen.getByText(label)).toHaveAttribute(
      "data-pr-state",
      label.toLowerCase(),
    );
    expect(screen.getByText(label).querySelector("svg")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
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
  expect(screen.getByText("open")).not.toHaveAttribute("data-pr-state");
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
  await screen.findByRole("heading", { name: "An unavailable branch #2" });
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

it("links the author login to their external GitHub profile", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          title: "A small improvement",
          user: { login: "tellaho" },
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
  const authors = await screen.findAllByRole("link", { name: "tellaho" });
  const author = authors.find(
    (link) => link.parentElement?.textContent === "by tellaho",
  );
  expect(authors).toHaveLength(2);
  expect(author).toHaveAttribute("href", "https://github.com/tellaho");
  expect(author).toHaveAttribute("target", "_blank");
  expect(author).toHaveAttribute("rel", "noreferrer");
  expect(author?.parentElement).toHaveTextContent("by tellaho");
});

it.each([
  [
    {
      commit: { message: "A commit", author: { name: "Sample Author" } },
      owner: { login: "someone-else" },
    },
    "Sample Author",
  ],
  [{ user: { login: "invalid/profile" } }, "invalid/profile"],
])(
  "does not invent a profile for raw or invalid authors",
  async (data, name) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify(data))),
    );
    render(
      <GitHubPanel
        target="https://github.com/example/project/commit/abcdef1"
        close={() => {}}
      />,
    );
    await screen.findByText(`by ${name}`);
    expect(screen.queryByRole("link", { name })).not.toBeInTheDocument();
  },
);

it("links the PR owner and repository and moves its number to the title", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ title: "A small improvement" })),
      ),
  );
  render(
    <GitHubPanel
      target="https://github.com/block/buzz-app/pull/629"
      close={() => {}}
    />,
  );
  const owner = screen.getByRole("link", { name: "block" });
  const repository = screen.getByRole("link", { name: "buzz-app" });
  expect(owner).toHaveAttribute("href", "https://github.com/block");
  expect(repository).toHaveAttribute(
    "href",
    "https://github.com/block/buzz-app",
  );
  for (const link of [owner, repository]) {
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer");
  }
  const identity = screen.getByText("Pull request", {
    selector: "small",
  }).parentElement;
  expect(identity).toHaveTextContent("block / buzz-appPull request");
  expect(identity).not.toHaveTextContent("#629");
  const title = await screen.findByRole("heading", {
    name: "A small improvement #629",
  });
  expect(within(title).getByText("#629")).toBeVisible();
  const titleLink = within(title).getByRole("link", {
    name: "A small improvement #629",
  });
  expect(titleLink).toHaveAttribute(
    "href",
    "https://github.com/block/buzz-app/pull/629",
  );
  expect(titleLink).toHaveAttribute("target", "_blank");
  expect(titleLink).toHaveAttribute("rel", "noreferrer");
  expect(
    screen.queryByRole("link", { name: "Open on GitHub" }),
  ).not.toBeInTheDocument();
});

it.each([
  ["https://github.com/example/project", "Repository project"],
  ["https://github.com/example/project/issues/2", "Issue #2"],
  ["https://github.com/example/project/commit/abcdef1", "Commit abcdef1"],
])(
  "preserves the non-PR identity and title for %s",
  async (target, identity) => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ title: "GitHub object" })),
        ),
    );
    render(<GitHubPanel target={target} close={() => {}} />);
    expect(screen.getByText(identity)).toBeVisible();
    expect(screen.getByText("example/project")).toBeVisible();
    expect(
      screen.queryByRole("link", { name: "example" }),
    ).not.toBeInTheDocument();
    await screen.findByRole("heading", { name: "GitHub object" });
    expect(
      screen.getByRole("link", { name: "Open on GitHub" }),
    ).toHaveAttribute("href", target);
  },
);

it.each([403, 404, 429, 500])(
  "keeps the PR title and prominent external recovery action usable after API failure %s",
  async (status) => {
    const target = "https://github.com/block/buzz-app/pull/629#discussion_r1";
    let finish!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const fetch = vi
      .fn()
      .mockReturnValueOnce(response)
      .mockImplementation(
        async (input: string) =>
          new Response(
            JSON.stringify(
              input === "https://api.github.com/repos/block/buzz-app/pulls/629"
                ? { title: "Recovered PR" }
                : [],
            ),
          ),
      );
    vi.stubGlobal("fetch", fetch);
    render(<GitHubPanel target={target} close={() => {}} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading");
    expect(
      screen.queryByRole("link", { name: "Open on Github" }),
    ).not.toBeInTheDocument();
    const titleLink = screen.getByRole("link", { name: "Pull request #629" });
    expect(titleLink).toHaveAttribute("href", target);
    finish(new Response(null, { status }));
    const alert = await screen.findByRole("alert");
    expect(titleLink).toBeVisible();
    const external = within(alert).getByRole("link", {
      name: "Open on Github",
    });
    const retry = within(alert).getByRole("button", { name: "Retry" });
    expect(external).toHaveAttribute("href", target);
    expect(external).toHaveAttribute("target", "_blank");
    expect(external).toHaveAttribute("rel", "noreferrer");
    expect(external).toHaveAttribute("data-variant", "prominent");
    expect(retry).toHaveAttribute("data-variant", "subtle");
    expect(external.nextElementSibling).toBe(retry);
    fireEvent.click(retry);
    expect(screen.getByRole("status")).toHaveTextContent("Loading");
    await screen.findByRole("heading", { name: "Recovered PR #629" });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Open on Github" }),
    ).not.toBeInTheDocument();
    expect(fetch.mock.calls[1]?.[0]).toBe(
      "https://api.github.com/repos/block/buzz-app/pulls/629",
    );
  },
);

it("defers both checks requests until opened and retains pending checks and discussion across tab switches", async () => {
  const pending: ((response: Response) => void)[] = [];
  const fetch = vi.fn((target: string) => {
    if (target.includes("/commits/"))
      return new Promise<Response>((resolve) => pending.push(resolve));
    return Promise.resolve(
      new Response(
        JSON.stringify(
          target.endsWith("/pulls/1")
            ? {
                title: "Lazy checks",
                body: "Summary\n\n## Details",
                head: { sha: "head-sha" },
              }
            : [],
        ),
      ),
    );
  });
  vi.stubGlobal("fetch", fetch);
  render(
    <GitHubPanel
      target="https://github.com/sample/project/pull/1"
      close={() => {}}
    />,
  );
  await screen.findByRole("region", { name: "Pull request conversation" });
  await waitFor(() =>
    expect(
      screen.queryByText(/some sources are incomplete/),
    ).not.toBeInTheDocument(),
  );
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(screen.getByRole("tab", { name: "Discussion" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(
    screen.queryByText("Checks", { selector: "dt" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Expand Description" }));
  fireEvent.click(screen.getByRole("tab", { name: "Checks" }));
  await waitFor(() => expect(pending).toHaveLength(2));
  expect(screen.getByRole("tabpanel", { name: "Checks" })).toHaveTextContent(
    "Loading…",
  );
  expect(
    fetch.mock.calls
      .slice(3)
      .map(([target]) => target)
      .sort(),
  ).toEqual([
    "https://api.github.com/repos/sample/project/commits/head-sha/check-runs?per_page=100&page=1&filter=latest",
    "https://api.github.com/repos/sample/project/commits/head-sha/status?per_page=100&page=1",
  ]);
  fireEvent.click(screen.getByRole("tab", { name: "Discussion" }));
  expect(screen.getByRole("heading", { name: "Details" })).toBeVisible();
  await act(async () => {
    pending[0]?.(
      new Response(JSON.stringify({ total_count: 0, check_runs: [] })),
    );
    pending[1]?.(
      new Response(JSON.stringify({ total_count: 0, statuses: [] })),
    );
  });
  fireEvent.click(screen.getByRole("tab", { name: "Checks" }));
  expect(screen.getByRole("tabpanel", { name: "Checks" })).toHaveTextContent(
    "No checks",
  );
  expect(fetch).toHaveBeenCalledTimes(5);
});

it("aborts old checks and resets lazy tabs when the PR changes", async () => {
  const signals: AbortSignal[] = [];
  const fetch = vi.fn((target: string, options: RequestInit) => {
    if (target.includes("/commits/")) {
      signals.push(options.signal as AbortSignal);
      return new Promise<Response>(() => {});
    }
    return Promise.resolve(
      new Response(
        JSON.stringify(
          /\/pulls\/\d+$/.test(target)
            ? {
                title: target.endsWith("/1") ? "First PR" : "Second PR",
                head: { sha: "head-sha" },
              }
            : [],
        ),
      ),
    );
  });
  vi.stubGlobal("fetch", fetch);
  const view = render(
    <GitHubPanel
      target="https://github.com/sample/project/pull/1"
      close={() => {}}
    />,
  );
  await screen.findByRole("region", { name: "Pull request conversation" });
  await waitFor(() =>
    expect(
      screen.queryByText(/some sources are incomplete/),
    ).not.toBeInTheDocument(),
  );
  fireEvent.click(screen.getByRole("tab", { name: "Checks" }));
  await waitFor(() => expect(signals).toHaveLength(2));
  view.rerender(
    <GitHubPanel
      target="https://github.com/sample/project/pull/2"
      close={() => {}}
    />,
  );
  await screen.findByRole("heading", { name: "Second PR #2" });
  await screen.findByRole("region", { name: "Pull request conversation" });
  await waitFor(() =>
    expect(
      screen.queryByText(/some sources are incomplete/),
    ).not.toBeInTheDocument(),
  );
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  expect(screen.getByRole("tab", { name: "Discussion" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(signals).toHaveLength(2);
});
