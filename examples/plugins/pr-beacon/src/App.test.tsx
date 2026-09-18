// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./App";
import { createPreferencesStore } from "./preferences";
import { createFakeRelay } from "./testRelayFixtures";
import { createTokenStore } from "./tokenStore";

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
