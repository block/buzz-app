// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp as createAppWithQueues } from "./App";
import { createQueueCache } from "./queueCache";
import { fetchReviewRequests, fetchOwnPullRequests } from "./github";
import { createPreferencesStore } from "./preferences";
import {
  createFakeAgentLibrary,
  createFakeRelay,
  createFakeSession,
} from "./testRelayFixtures";
import { createTokenStore } from "./tokenStore";

const disposeQueues: (() => void)[] = [];

type AppArguments = Parameters<typeof createAppWithQueues>;

function createApp(
  runtime: AppArguments[0],
  tokenStore: AppArguments[1],
  preferencesStore: AppArguments[2],
  relay: AppArguments[3],
) {
  const queues = {
    reviewRequests: createQueueCache(
      tokenStore,
      fetchReviewRequests,
      "Could not load review requests.",
    ),
    ownPullRequests: createQueueCache(
      tokenStore,
      fetchOwnPullRequests,
      "Could not load your pull requests.",
    ),
  };
  disposeQueues.push(
    queues.reviewRequests.dispose,
    queues.ownPullRequests.dispose,
  );
  return createAppWithQueues(
    runtime,
    tokenStore,
    preferencesStore,
    relay,
    queues,
  );
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body));
}

function reviewRequestNode(number: number, title: string) {
  return {
    url: `https://github.com/example/repo/pull/${number}`,
    number,
    title,
    isDraft: false,
    reviewDecision: null,
    updatedAt: "2026-01-01T00:00:00Z",
    repository: { nameWithOwner: "example/repo" },
    author: { login: "octocat" },
    labels: { nodes: [] },
  };
}

function searchResponse(nodes: unknown[]) {
  return jsonResponse({
    data: {
      search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes },
    },
  });
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  for (const dispose of disposeQueues.splice(0)) dispose();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("App review-request hide/unhide", () => {
  it("hides a review request into the Hidden disclosure and persists the preference", async () => {
    const tokenStore = createTokenStore();
    tokenStore.setToken("test-token");
    const preferencesStore = createPreferencesStore();
    const App = createApp(
      React as never,
      tokenStore,
      preferencesStore,
      createFakeRelay(),
    );

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(searchResponse([reviewRequestNode(1, "Fix bug")])),
    );

    render(<App />);
    const hideButton = await screen.findByRole("button", { name: "Hide" });
    await userEvent.click(hideButton);

    expect(
      await screen.findByRole("group", {
        name: /hidden review requests \(1\)/i,
      }),
    ).toBeInTheDocument();
    expect(preferencesStore.getPreferences().hiddenReviewRequestUrls).toEqual([
      "https://github.com/example/repo/pull/1",
    ]);
  });

  it("unhides a review request back into its normal section", async () => {
    const tokenStore = createTokenStore();
    tokenStore.setToken("test-token");
    const preferencesStore = createPreferencesStore();
    preferencesStore.setPreferences({
      vipLogins: [],
      watchedLabels: [],
      hiddenReviewRequestUrls: ["https://github.com/example/repo/pull/1"],
      pollingEnabled: false,
    });
    const App = createApp(
      React as never,
      tokenStore,
      preferencesStore,
      createFakeRelay(),
    );

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(searchResponse([reviewRequestNode(1, "Fix bug")])),
    );

    render(<App />);
    const unhideButton = await screen.findByRole("button", { name: "Unhide" });
    await userEvent.click(unhideButton);

    expect(
      await screen.findByRole("button", { name: "Hide" }),
    ).toBeInTheDocument();
    expect(preferencesStore.getPreferences().hiddenReviewRequestUrls).toEqual(
      [],
    );
  });

  it("keeps a hidden URL across a refresh even when that pull request is absent from the (capped/filtered) results", async () => {
    // Hiding is not pruned against the fetched list: a capped search result,
    // a transient GitHub filter, or a race with the real state should never
    // silently erase a user's hidden preference. Only explicit Unhide does.
    const tokenStore = createTokenStore();
    tokenStore.setToken("test-token");
    const preferencesStore = createPreferencesStore();
    preferencesStore.setPreferences({
      vipLogins: [],
      watchedLabels: [],
      hiddenReviewRequestUrls: ["https://github.com/example/repo/pull/999"],
      pollingEnabled: false,
    });
    const App = createApp(
      React as never,
      tokenStore,
      preferencesStore,
      createFakeRelay(),
    );

    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(searchResponse([reviewRequestNode(1, "Fix bug")])),
      );
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await screen.findByRole("button", { name: "Hide" });
    await userEvent.click(
      await screen.findByRole("button", { name: "Refresh" }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    expect(preferencesStore.getPreferences().hiddenReviewRequestUrls).toEqual([
      "https://github.com/example/repo/pull/999",
    ]);
  });
});

describe("App error recovery", () => {
  it("keeps Refresh available and disabled only while loading, and a retry after an error succeeds", async () => {
    const tokenStore = createTokenStore();
    tokenStore.setToken("test-token");
    const preferencesStore = createPreferencesStore();
    const App = createApp(
      React as never,
      tokenStore,
      preferencesStore,
      createFakeRelay(),
    );

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("boom", { status: 500 }))
      .mockResolvedValueOnce(searchResponse([reviewRequestNode(1, "Fix bug")]));
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    const errorMessage = await screen.findByRole("alert");
    expect(errorMessage).toBeInTheDocument();

    const refreshButton = screen.getByRole("button", { name: "Refresh" });
    expect(refreshButton).toBeEnabled();

    await userEvent.click(refreshButton);
    expect(
      await screen.findByRole("button", { name: "Hide" }),
    ).toBeInTheDocument();
  });
});

describe("App overlap protection", () => {
  it("does not let a stale request from a superseded token clear the busy flag for the current request", async () => {
    vi.useFakeTimers();
    const tokenStore = createTokenStore();
    tokenStore.setToken("token-1");
    const preferencesStore = createPreferencesStore();
    preferencesStore.setPreferences({
      vipLogins: [],
      watchedLabels: [],
      hiddenReviewRequestUrls: [],
      pollingEnabled: true,
    });
    const App = createApp(
      React as never,
      tokenStore,
      preferencesStore,
      createFakeRelay(),
    );

    const resolvers: Record<string, () => void> = {};
    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        callCount += 1;
        const headers = init?.headers as Record<string, string> | undefined;
        const authorization = headers?.Authorization ?? "unknown";
        return new Promise((resolve) => {
          resolvers[authorization] = () =>
            resolve(searchResponse([reviewRequestNode(1, "Fix bug")]));
        });
      }),
    );

    await act(async () => {
      render(<App />);
    });
    expect(callCount).toBe(1);

    // Switching tokens aborts the token-1 request and starts a token-2
    // request; the mock fetch (unlike a real one) keeps running regardless.
    await act(async () => {
      tokenStore.setToken("token-2");
    });
    expect(callCount).toBe(2);

    // The stale token-1 request resolves AFTER token-2's request has already
    // started. Its completion must not clear the busy flag token-2's
    // in-flight request owns.
    await act(async () => {
      resolvers["Bearer token-1"]?.();
      await Promise.resolve();
    });

    // A poll tick while token-2's request is still pending must not start a
    // third, overlapping request.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(callCount).toBe(2);
  });
});

describe("App manual refresh", () => {
  it("re-fetches the review-request list when Refresh is clicked", async () => {
    const tokenStore = createTokenStore();
    tokenStore.setToken("test-token");
    const preferencesStore = createPreferencesStore();
    const App = createApp(
      React as never,
      tokenStore,
      preferencesStore,
      createFakeRelay(),
    );

    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(searchResponse([reviewRequestNode(1, "Fix bug")])),
      );
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    await screen.findByRole("button", { name: "Hide" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await userEvent.click(
      await screen.findByRole("button", { name: "Refresh" }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});

describe("App background polling", () => {
  it("does not start an overlapping poll while a request is still in flight, and polls again once it resolves", async () => {
    vi.useFakeTimers();
    const tokenStore = createTokenStore();
    tokenStore.setToken("test-token");
    const preferencesStore = createPreferencesStore();
    preferencesStore.setPreferences({
      vipLogins: [],
      watchedLabels: [],
      hiddenReviewRequestUrls: [],
      pollingEnabled: true,
    });
    const App = createApp(
      React as never,
      tokenStore,
      preferencesStore,
      createFakeRelay(),
    );

    const resolveSecondHolder: { resolve: (() => void) | null } = {
      resolve: null,
    };
    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        callCount += 1;
        if (callCount === 1) {
          return Promise.resolve(
            searchResponse([reviewRequestNode(1, "Fix bug")]),
          );
        }
        return new Promise((resolve) => {
          resolveSecondHolder.resolve = () =>
            resolve(searchResponse([reviewRequestNode(1, "Fix bug")]));
        });
      }),
    );

    await act(async () => {
      render(<App />);
    });
    expect(callCount).toBe(1);

    // First interval tick starts the second (slow) fetch.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(callCount).toBe(2);

    // A second interval tick fires while the slow fetch is still pending:
    // must not start a third, overlapping request.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(callCount).toBe(2);

    // Once the slow fetch resolves, the next tick is free to poll again.
    await act(async () => {
      resolveSecondHolder.resolve?.();
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(callCount).toBe(3);
  });
});

describe("App agent summary settings", () => {
  it("loads agent identities on cold start instead of leaving the picker permanently empty", async () => {
    const tokenStore = createTokenStore();
    tokenStore.setToken("test-token");
    const preferencesStore = createPreferencesStore();
    const agentLibrary = createFakeAgentLibrary();
    const session = createFakeSession({
      agentLibrary: agentLibrary.api,
      channels: [{ id: "channel-1", name: "eng-reviews" }],
    });
    const relay = createFakeRelay({ session });
    const App = createApp(React as never, tokenStore, preferencesStore, relay);

    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));

    // Cold start: the library begins idle, so a load must be kicked off
    // rather than leaving the picker at "None selected" forever.
    expect(screen.getByText(/Loading agents/i)).toBeInTheDocument();
    expect(agentLibrary.getStatus()).toBe("loading");

    await act(async () => {
      agentLibrary.deliver([{ pubkey: "agent-pubkey", name: "Review Bot" }]);
    });

    expect(
      screen.getByRole("option", { name: "Review Bot" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Loading agents/i)).not.toBeInTheDocument();
  });

  it("shows a retryable error instead of silently staying empty when the load fails", async () => {
    const tokenStore = createTokenStore();
    tokenStore.setToken("test-token");
    const preferencesStore = createPreferencesStore();
    const agentLibrary = createFakeAgentLibrary();
    const session = createFakeSession({ agentLibrary: agentLibrary.api });
    const relay = createFakeRelay({ session });
    const App = createApp(React as never, tokenStore, preferencesStore, relay);

    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));

    await act(async () => {
      agentLibrary.fail("network unreachable");
    });
    expect(
      screen.getByText(/Could not load agents: network unreachable/i),
    ).toBeInTheDocument();

    // Retrying calls refresh() directly; it does not loop on its own.
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(agentLibrary.getStatus()).toBe("loading");
  });

  it("unsubscribes from the agent library on unmount", async () => {
    const tokenStore = createTokenStore();
    tokenStore.setToken("test-token");
    const preferencesStore = createPreferencesStore();
    const agentLibrary = createFakeAgentLibrary();
    const session = createFakeSession({ agentLibrary: agentLibrary.api });
    const relay = createFakeRelay({ session });
    const App = createApp(React as never, tokenStore, preferencesStore, relay);

    const { unmount } = render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(agentLibrary.subscriberCount()).toBeGreaterThan(0);

    unmount();
    expect(agentLibrary.subscriberCount()).toBe(0);

    // A late delivery after unmount must not throw.
    expect(() =>
      agentLibrary.deliver([{ pubkey: "agent-pubkey", name: "Review Bot" }]),
    ).not.toThrow();
  });

  it("shows an explicit empty state when no Buzz agents exist yet", async () => {
    const tokenStore = createTokenStore();
    tokenStore.setToken("test-token");
    const preferencesStore = createPreferencesStore();
    const agentLibrary = createFakeAgentLibrary();
    const session = createFakeSession({ agentLibrary: agentLibrary.api });
    const relay = createFakeRelay({ session });
    const App = createApp(React as never, tokenStore, preferencesStore, relay);

    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));

    await act(async () => {
      agentLibrary.deliver([]);
    });

    expect(
      screen.getByText(/No Buzz agents are available yet/i),
    ).toBeInTheDocument();
  });

  it("explains how to continue when no summary channels are available", async () => {
    const App = createApp(
      React as never,
      createTokenStore(),
      createPreferencesStore(),
      createFakeRelay({ session: createFakeSession({ channels: [] }) }),
    );
    render(<App />);
    expect(screen.getByText(/No channels are available/)).toBeInTheDocument();
    expect(screen.getByLabelText("Summary channel")).toBeDisabled();
  });
});

describe("App cached queues", () => {
  it("reuses both queues across tab changes, a PR visit, and page remounts", async () => {
    const tokenStore = createTokenStore();
    tokenStore.setToken("test-token");
    const App = createApp(
      React as never,
      tokenStore,
      createPreferencesStore(),
      createFakeRelay(),
    );
    const searchQueries: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string, options: RequestInit) => {
        if (url.endsWith("/graphql")) {
          const query = JSON.parse(options.body as string).variables
            .queryString as string;
          searchQueries.push(query);
          return Promise.resolve(
            searchResponse([
              reviewRequestNode(
                query.includes("author:") ? 2 : 1,
                query.includes("author:") ? "My change" : "Requested change",
              ),
            ]),
          );
        }
        if (url.includes("/compare/"))
          return Promise.resolve(jsonResponse({ files: [] }));
        return Promise.resolve(
          jsonResponse({
            html_url: "https://github.com/example/repo/pull/1",
            number: 1,
            title: "Requested change",
            body: "",
            user: { login: "octocat" },
            head: { sha: "head-sha", ref: "feature" },
            base: { ref: "main", sha: "base-sha" },
          }),
        );
      }),
    );
    const firstMount = render(<App />);
    await userEvent.click(
      await screen.findByRole("button", { name: /#1 — Requested change/ }),
    );
    expect(
      await screen.findByRole("link", { name: "Open on GitHub" }),
    ).toHaveAttribute("href", "https://github.com/example/repo/pull/1");
    await userEvent.click(screen.getByRole("button", { name: /Back/ }));
    await screen.findByRole("button", { name: /#1 — Requested change/ });
    await userEvent.click(
      screen.getByRole("button", { name: "Your pull requests" }),
    );
    await screen.findByRole("button", { name: /#2 — My change/ });
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Review requests" }),
    );
    await screen.findByRole("button", { name: /#1 — Requested change/ });
    await userEvent.click(
      screen.getByRole("button", { name: "Your pull requests" }),
    );
    await screen.findByRole("button", { name: /#2 — My change/ });
    firstMount.unmount();
    render(<App />);
    expect(
      screen.getByRole("button", { name: /#1 — Requested change/ }),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Your pull requests" }),
    );
    expect(
      screen.getByRole("button", { name: /#2 — My change/ }),
    ).toBeInTheDocument();
    expect(searchQueries).toHaveLength(2);
  });

  it("keeps cached rows and last-success time during a failed refresh, then replaces both on success", async () => {
    vi.useFakeTimers();
    const firstFetchTime = new Date("2026-09-22T17:00:00Z");
    vi.setSystemTime(firstFetchTime);
    const tokenStore = createTokenStore();
    tokenStore.setToken("test-token");
    const App = createApp(
      React as never,
      tokenStore,
      createPreferencesStore(),
      createFakeRelay(),
    );
    let finishRefresh: ((response: Response) => void) | undefined;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        searchResponse([reviewRequestNode(1, "Cached change")]),
      )
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finishRefresh = resolve;
          }),
      )
      .mockResolvedValueOnce(
        searchResponse([reviewRequestNode(2, "Fresh change")]),
      );
    vi.stubGlobal("fetch", fetchMock);
    await act(async () => {
      render(<App />);
    });
    const timestamp = screen.getByText(/Last fetched:/);
    expect(timestamp).toHaveAttribute("datetime", firstFetchTime.toISOString());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(180_000);
    });
    expect(timestamp).toHaveTextContent("Last fetched: 3 minutes ago");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    });
    expect(
      screen.getByRole("button", { name: /#1 — Cached change/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled();
    expect(timestamp).toHaveAttribute("datetime", firstFetchTime.toISOString());
    await act(async () => {
      finishRefresh?.(
        new Response(JSON.stringify({ message: "Unavailable" }), {
          status: 503,
        }),
      );
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Showing previously fetched data.",
    );
    expect(
      screen.getByRole("button", { name: /#1 — Cached change/ }),
    ).toBeInTheDocument();
    expect(timestamp).toHaveAttribute("datetime", firstFetchTime.toISOString());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /#2 — Fresh change/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /#1 — Cached change/ }),
    ).not.toBeInTheDocument();
    expect(timestamp).toHaveAttribute("datetime", "2026-09-22T17:03:00.000Z");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("reuses an empty result and clears both queues when credentials change", async () => {
    const tokenStore = createTokenStore();
    tokenStore.setToken("first-token");
    const App = createApp(
      React as never,
      tokenStore,
      createPreferencesStore(),
      createFakeRelay(),
    );
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(searchResponse([])));
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    await screen.findByText("No open review requests.");
    await userEvent.click(
      screen.getByRole("button", { name: "Your pull requests" }),
    );
    await screen.findByText("You have no open pull requests.");
    await userEvent.click(
      screen.getByRole("button", { name: "Review requests" }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => {
      tokenStore.setToken("second-token");
    });
    await screen.findByText("No open review requests.");
    await userEvent.click(
      screen.getByRole("button", { name: "Your pull requests" }),
    );
    await screen.findByText("You have no open pull requests.");
    expect(fetchMock).toHaveBeenCalledTimes(4);
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(screen.queryByText(/Last fetched:/)).not.toBeInTheDocument();
    await act(async () => {
      tokenStore.setToken("second-token");
    });
    await userEvent.click(
      screen.getByRole("button", { name: "Review requests" }),
    );
    await screen.findByText("No open review requests.");
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});
