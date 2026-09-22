// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./App";
import { createPreferencesStore } from "./preferences";
import { createQueueCache } from "./queueCache";
import { createFakeRelay } from "./testRelayFixtures";
import { createTokenStore } from "./tokenStore";
import type { OwnPullRequest, SearchResult } from "./types";

const disposals: (() => void)[] = [];

function pullRequest(
  number: number,
  title: string,
  overrides: Partial<OwnPullRequest>,
): OwnPullRequest {
  return {
    url: `https://github.com/example/repo/pull/${number}`,
    number,
    repository: "example/repo",
    title,
    author: "octocat",
    isDraft: false,
    labels: [],
    updatedAt: "2026-01-01T00:00:00Z",
    reviewDecision: null,
    mergeStateStatus: "CLEAN",
    checkState: "SUCCESS",
    ...overrides,
  };
}

const everyStatus = [
  pullRequest(1, "Ready item", { reviewDecision: "APPROVED" }),
  pullRequest(2, "Failing item", {
    reviewDecision: "APPROVED",
    checkState: "FAILURE",
  }),
  pullRequest(3, "Feedback item", {
    reviewDecision: "CHANGES_REQUESTED",
  }),
  pullRequest(4, "Waiting item", { reviewDecision: "REVIEW_REQUIRED" }),
  pullRequest(5, "Draft item", { isDraft: true }),
  pullRequest(6, "Unknown item", {
    reviewDecision: "APPROVED",
    checkState: "PENDING",
  }),
];

async function renderOwnPullRequests(
  fetchOwnPullRequests: () => Promise<SearchResult<OwnPullRequest>>,
) {
  const tokenStore = createTokenStore();
  tokenStore.setToken("test-token");
  const preferencesStore = createPreferencesStore();
  preferencesStore.setPreferences({
    vipLogins: [],
    watchedLabels: [],
    hiddenReviewRequestUrls: [],
    pollingEnabled: false,
  });
  const queues = {
    reviewRequests: createQueueCache(
      tokenStore,
      async () => ({ items: [], truncated: false }),
      "Could not load review requests.",
    ),
    ownPullRequests: createQueueCache(
      tokenStore,
      fetchOwnPullRequests,
      "Could not load your pull requests.",
    ),
  };
  disposals.push(queues.reviewRequests.dispose, queues.ownPullRequests.dispose);
  const App = createApp(
    React as never,
    tokenStore,
    preferencesStore,
    createFakeRelay(),
    queues,
  );
  render(<App />);
  await userEvent.click(
    screen.getByRole("button", { name: "Your pull requests" }),
  );
  return tokenStore;
}

afterEach(() => {
  cleanup();
  for (const dispose of disposals.splice(0)) dispose();
  localStorage.clear();
});

describe("own pull request status filters", () => {
  it("shows a count for every classification", async () => {
    await renderOwnPullRequests(
      vi.fn(async () => ({ items: everyStatus, truncated: false })),
    );

    const filters = await screen.findByRole("group", {
      name: "Filter pull requests by status",
    });
    const expectedCounts = [
      ["All", 6],
      ["Ready to merge", 1],
      ["Approved, checks failing", 1],
      ["Reviewed with feedback", 1],
      ["Awaiting review", 1],
      ["Draft", 1],
      ["Unresolved", 1],
    ] as const;
    for (const [name, count] of expectedCounts) {
      expect(
        within(filters).getByRole("button", {
          name: `${name}: ${count} pull request${count === 1 ? "" : "s"}`,
        }),
      ).toBeInTheDocument();
    }
  });

  it("filters rows and retains the selection across tabs without fetching", async () => {
    const fetchOwnPullRequests = vi.fn(async () => ({
      items: everyStatus,
      truncated: false,
    }));
    await renderOwnPullRequests(fetchOwnPullRequests);
    let filters = await screen.findByRole("group", {
      name: "Filter pull requests by status",
    });

    const feedback = within(filters).getByRole("button", {
      name: "Reviewed with feedback: 1 pull request",
    });
    await userEvent.click(feedback);
    expect(feedback).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Feedback item")).toBeInTheDocument();
    expect(screen.queryByText("Ready item")).not.toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: "Review requests" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Your pull requests" }),
    );
    filters = await screen.findByRole("group", {
      name: "Filter pull requests by status",
    });
    expect(
      within(filters).getByRole("button", {
        name: "Reviewed with feedback: 1 pull request",
      }),
    ).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(
      within(filters).getByRole("button", { name: "All: 6 pull requests" }),
    );
    expect(screen.getByText("Ready item")).toBeInTheDocument();
    expect(fetchOwnPullRequests).toHaveBeenCalledTimes(1);
  });

  it("resets the filter when credentials change", async () => {
    const tokenStore = await renderOwnPullRequests(
      vi.fn(async () => ({ items: everyStatus, truncated: false })),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Draft: 1 pull request" }),
    );
    expect(screen.queryByText("Ready item")).not.toBeInTheDocument();
    await act(async () => {
      tokenStore.setToken("new-account-token");
    });
    expect(
      await screen.findByRole("button", { name: "All: 6 pull requests" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Ready item")).toBeInTheDocument();
  });

  it("allows selecting an empty category", async () => {
    await renderOwnPullRequests(
      vi.fn(async () => ({ items: [everyStatus[0]], truncated: false })),
    );
    const filters = await screen.findByRole("group", {
      name: "Filter pull requests by status",
    });

    const unresolved = within(filters).getByRole("button", {
      name: "Unresolved: 0 pull requests",
    });
    await userEvent.click(unresolved);

    expect(unresolved).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByText("No pull requests match this status."),
    ).toBeInTheDocument();
  });

  it("updates counts after refresh and retains the selected filter", async () => {
    const fetchOwnPullRequests = vi
      .fn<() => Promise<SearchResult<OwnPullRequest>>>()
      .mockResolvedValueOnce({ items: [everyStatus[2]], truncated: false })
      .mockResolvedValueOnce({
        items: [
          everyStatus[2],
          pullRequest(7, "Second feedback item", {
            reviewDecision: "CHANGES_REQUESTED",
          }),
        ],
        truncated: false,
      });
    await renderOwnPullRequests(fetchOwnPullRequests);
    const filters = await screen.findByRole("group", {
      name: "Filter pull requests by status",
    });
    await userEvent.click(
      within(filters).getByRole("button", {
        name: "Reviewed with feedback: 1 pull request",
      }),
    );

    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect(
        within(filters).getByRole("button", {
          name: "Reviewed with feedback: 2 pull requests",
        }),
      ).toHaveAttribute("aria-pressed", "true"),
    );
    expect(screen.getByText("Second feedback item")).toBeInTheDocument();
    expect(fetchOwnPullRequests).toHaveBeenCalledTimes(2);
  });
});
