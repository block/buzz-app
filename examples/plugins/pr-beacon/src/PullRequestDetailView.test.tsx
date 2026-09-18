// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPullRequestDetailView } from "./PullRequestDetailView";
import { createFakeRelay } from "./testRelayFixtures";
import type { PullRequestSummary } from "./types";

const relay = createFakeRelay();
const relaySnapshot = relay.snapshot();

const pullRequest: PullRequestSummary = {
  url: "https://github.com/example/repo/pull/1",
  number: 1,
  repository: "example/repo",
  title: "Fix bug",
  author: "octocat",
  isDraft: false,
  labels: [],
  updatedAt: "2026-01-01T00:00:00Z",
  reviewDecision: null,
};

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body));
}

function detailResponse(summary: PullRequestSummary, headSha: string) {
  return jsonResponse({
    html_url: summary.url,
    number: summary.number,
    title: summary.title,
    body: "",
    user: { login: summary.author },
    head: { sha: headSha, ref: "feature" },
    base: { ref: "main", sha: "base-sha" },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function flushMicrotasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const PullRequestDetailView = createPullRequestDetailView(React as never);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PullRequestDetailView load lifecycle", () => {
  it("does not let a stale pull request's late response overwrite the currently selected one", async () => {
    const first: PullRequestSummary = {
      ...pullRequest,
      number: 1,
      title: "PR One",
    };
    const second: PullRequestSummary = {
      ...pullRequest,
      number: 2,
      title: "PR Two",
    };
    const firstDetail = deferred<Response>();

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.includes("/compare/"))
          return Promise.resolve(jsonResponse({ files: [] }));
        if (url.endsWith("/pulls/1")) return firstDetail.promise;
        if (url.endsWith("/pulls/2"))
          return Promise.resolve(detailResponse(second, "sha-2"));
        return Promise.reject(new Error("unexpected request"));
      }),
    );

    const { rerender } = render(
      <PullRequestDetailView
        token="test-token"
        pullRequest={first}
        relay={relay}
        relaySnapshot={relaySnapshot}
        summarySelection={null}
      />,
    );
    // Switch to a different pull request before the first one's detail
    // request has resolved.
    rerender(
      <PullRequestDetailView
        token="test-token"
        pullRequest={second}
        relay={relay}
        relaySnapshot={relaySnapshot}
        summarySelection={null}
      />,
    );
    expect(await screen.findByText("PR Two")).toBeInTheDocument();

    // The stale first request finally resolves after the switch.
    firstDetail.resolve(detailResponse(first, "sha-1"));
    await flushMicrotasks();

    expect(screen.getByText("PR Two")).toBeInTheDocument();
    expect(screen.queryByText("PR One")).not.toBeInTheDocument();
  });
});

describe("PullRequestDetailView approve flow", () => {
  it("does not fabricate an AI summary and prompts to pick an agent instead", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation((url: string) =>
          Promise.resolve(
            url.includes("/compare/")
              ? jsonResponse({ files: [] })
              : detailResponse(pullRequest, "sha-1"),
          ),
        ),
    );
    render(
      <PullRequestDetailView
        token="test-token"
        pullRequest={pullRequest}
        relay={relay}
        relaySnapshot={relaySnapshot}
        summarySelection={null}
      />,
    );
    expect(
      await screen.findByText(/Pick a summary agent and channel in Settings/i),
    ).toBeInTheDocument();
  });

  it("blocks approval and surfaces a stale error when the head SHA moved", async () => {
    let requestCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.includes("/compare/"))
          return Promise.resolve(jsonResponse({ files: [] }));
        requestCount += 1;
        // Call 1: initial detail load reviews "reviewed-sha".
        // Call 2: approve flow's own head-SHA refetch finds it moved.
        return Promise.resolve(
          requestCount === 1
            ? detailResponse(pullRequest, "reviewed-sha")
            : detailResponse(pullRequest, "new-sha"),
        );
      }),
    );

    render(
      <PullRequestDetailView
        token="test-token"
        pullRequest={pullRequest}
        relay={relay}
        relaySnapshot={relaySnapshot}
        summarySelection={null}
      />,
    );
    const approveButton = await screen.findByRole("button", {
      name: /approve reviewe/i,
    });
    await userEvent.click(approveButton);

    expect(
      await screen.findByText(/changed since you viewed this diff/i),
    ).toBeInTheDocument();
  });

  it("offers a manual status check instead of auto-retrying on an uncertain POST outcome", async () => {
    let requestCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.includes("/compare/"))
          return Promise.resolve(jsonResponse({ files: [] }));
        requestCount += 1;
        // Call 1: initial detail load. Call 2: approve's head-SHA refetch
        // (unchanged). Call 3: the approve POST itself fails as a network error.
        if (requestCount <= 2)
          return Promise.resolve(detailResponse(pullRequest, "sha-1"));
        return Promise.reject(new TypeError("network error"));
      }),
    );

    render(
      <PullRequestDetailView
        token="test-token"
        pullRequest={pullRequest}
        relay={relay}
        relaySnapshot={relaySnapshot}
        summarySelection={null}
      />,
    );
    const approveButton = await screen.findByRole("button", {
      name: /approve sha-1/i,
    });
    await userEvent.click(approveButton);

    await waitFor(() =>
      expect(
        screen.getByText(/didn't confirm whether the approval went through/i),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText(/^Approved\.$/)).not.toBeInTheDocument();
  });

  it("cancels an in-flight approve preflight on unmount and never fires the approval POST", async () => {
    const preflight = deferred<Response>();
    let detailLoadDone = false;
    let reviewPostCalled = false;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        if (url.includes("/compare/"))
          return Promise.resolve(jsonResponse({ files: [] }));
        if (url.includes("/reviews") && init?.method === "POST") {
          reviewPostCalled = true;
          return Promise.resolve(jsonResponse({ id: 1 }));
        }
        if (url.endsWith("/pulls/1")) {
          if (!detailLoadDone) {
            detailLoadDone = true;
            return Promise.resolve(detailResponse(pullRequest, "sha-1"));
          }
          // The approve flow's own head-SHA preflight: left pending.
          return preflight.promise;
        }
        return Promise.reject(new Error("unexpected request"));
      }),
    );

    const { unmount } = render(
      <PullRequestDetailView
        token="test-token"
        pullRequest={pullRequest}
        relay={relay}
        relaySnapshot={relaySnapshot}
        summarySelection={null}
      />,
    );
    const approveButton = await screen.findByRole("button", {
      name: /approve sha-1/i,
    });
    await userEvent.click(approveButton);
    unmount();

    // The preflight resolves only after the component is gone.
    preflight.resolve(jsonResponse({ head: { sha: "sha-1" } }));
    await flushMicrotasks();

    expect(reviewPostCalled).toBe(false);
  });

  it("does not expose Retry approve after a failed status check", async () => {
    let requestCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.includes("/compare/"))
          return Promise.resolve(jsonResponse({ files: [] }));
        requestCount += 1;
        // 1: detail load. 2: approve's own head-SHA preflight (unchanged).
        if (requestCount <= 2)
          return Promise.resolve(detailResponse(pullRequest, "sha-1"));
        // 3: the approve POST itself fails -> uncertain.
        // 4 (fetchViewerLogin) and beyond: the status check itself fails.
        return Promise.reject(new TypeError("network error"));
      }),
    );

    render(
      <PullRequestDetailView
        token="test-token"
        pullRequest={pullRequest}
        relay={relay}
        relaySnapshot={relaySnapshot}
        summarySelection={null}
      />,
    );
    await userEvent.click(
      await screen.findByRole("button", { name: /approve sha-1/i }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: /check status/i }),
    );

    await waitFor(() =>
      expect(
        screen.getByText(/could not confirm the approval/i),
      ).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("button", { name: /retry approve/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /check status/i }),
    ).toBeInTheDocument();
  });

  it("only offers Retry approve once a status check confirms no approval exists", async () => {
    let requestCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        if (url.includes("/compare/"))
          return Promise.resolve(jsonResponse({ files: [] }));
        if (url.includes("/graphql"))
          return Promise.resolve(
            jsonResponse({ data: { viewer: { login: "octocat" } } }),
          );
        // The GET reviews list (used to confirm the approval) always carries
        // a query string; distinguish it from the POST .../reviews call,
        // which has none, so this mock doesn't accidentally short-circuit
        // the approve POST into a fake success.
        if (url.includes("/reviews?")) return Promise.resolve(jsonResponse([]));
        if (url.includes("/reviews") && init?.method === "POST")
          return Promise.reject(new TypeError("network error"));
        requestCount += 1;
        if (requestCount <= 2)
          return Promise.resolve(detailResponse(pullRequest, "sha-1"));
        return Promise.reject(new TypeError("network error"));
      }),
    );

    render(
      <PullRequestDetailView
        token="test-token"
        pullRequest={pullRequest}
        relay={relay}
        relaySnapshot={relaySnapshot}
        summarySelection={null}
      />,
    );
    await userEvent.click(
      await screen.findByRole("button", { name: /approve sha-1/i }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: /check status/i }),
    );

    expect(
      await screen.findByRole("button", { name: /retry approve/i }),
    ).toBeInTheDocument();
  });
});
