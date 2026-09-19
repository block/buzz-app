import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApprovalAborted,
  GitHubError,
  approvePullRequest,
  fetchPullRequestDetail,
  fetchPullRequestFiles,
  fetchReviewRequests,
  hasApprovalForSha,
} from "./github";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchReviewRequests", () => {
  it("sends the token as a bearer header and stops when there is no next page", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        data: {
          search: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                url: "https://github.com/example/repo/pull/1",
                number: 1,
                title: "Fix bug",
                isDraft: false,
                reviewDecision: null,
                updatedAt: "2026-01-01T00:00:00Z",
                repository: { nameWithOwner: "example/repo" },
                author: { login: "octocat" },
                labels: { nodes: [{ name: "bug" }] },
              },
            ],
          },
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchReviewRequests("test-token");

    expect(result.truncated).toBe(false);
    expect(result.items).toEqual([
      {
        url: "https://github.com/example/repo/pull/1",
        number: 1,
        repository: "example/repo",
        title: "Fix bug",
        author: "octocat",
        isDraft: false,
        labels: ["bug"],
        updatedAt: "2026-01-01T00:00:00Z",
        reviewDecision: null,
      },
    ]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.github.com/graphql");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer test-token",
    );
    expect(init.credentials).toBe("omit");
  });

  it("marks results truncated after exhausting the page cap without silently dropping them", async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          data: {
            search: {
              pageInfo: { hasNextPage: true, endCursor: "cursor" },
              nodes: [],
            },
          },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchReviewRequests("test-token");

    expect(result.truncated).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("throws a readable error on 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("", { status: 401 })),
    );
    await expect(fetchReviewRequests("bad-token")).rejects.toThrow(GitHubError);
  });
});

describe("fetchPullRequestDetail", () => {
  it("parses the REST response into a detail object", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          html_url: "https://github.com/example/repo/pull/1",
          number: 1,
          title: "Fix bug",
          body: "Body",
          user: { login: "octocat" },
          head: { sha: "abc123", ref: "feature" },
          base: { ref: "main", sha: "base-sha" },
        }),
      ),
    );
    const detail = await fetchPullRequestDetail("token", "example/repo", 1);
    expect(detail.headSha).toBe("abc123");
    expect(detail.baseSha).toBe("base-sha");
    expect(detail.baseRefName).toBe("main");
  });
});

describe("fetchPullRequestFiles", () => {
  it("diffs the exact base commit SHA against the exact head SHA, not the PR's current state or a mutable branch name", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        files: [
          {
            filename: "a.ts",
            status: "modified",
            additions: 1,
            deletions: 0,
            patch: "@@ -1 +1 @@",
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchPullRequestFiles(
      "token",
      "example/repo",
      "base-sha",
      "pinned-sha",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/example/repo/compare/base-sha...pinned-sha",
      expect.anything(),
    );
    expect(result.truncated).toBe(false);
    expect(result.items).toEqual([
      {
        filename: "a.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        patch: "@@ -1 +1 @@",
      },
    ]);
  });

  it("flags truncation instead of presenting a capped file list as complete", async () => {
    const files = Array.from({ length: 300 }, (_, index) => ({
      filename: `file-${index}.ts`,
      status: "modified",
      additions: 1,
      deletions: 0,
    }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ files })));

    const result = await fetchPullRequestFiles(
      "token",
      "example/repo",
      "main",
      "sha",
    );

    expect(result.truncated).toBe(true);
  });
});

describe("approvePullRequest", () => {
  it("refuses to approve when the head SHA moved since the diff was viewed", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ head: { sha: "new-sha" } }));
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await approvePullRequest(
      "token",
      "example/repo",
      1,
      "old-sha",
    );

    expect(outcome).toBe("stale");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("posts an APPROVE review pinned to the current head SHA", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ head: { sha: "current-sha" } }))
      .mockResolvedValueOnce(jsonResponse({ id: 99 }));
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await approvePullRequest(
      "token",
      "example/repo",
      1,
      "current-sha",
    );

    expect(outcome).toBe("approved");
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe(
      "https://api.github.com/repos/example/repo/pulls/1/reviews",
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      commit_id: "current-sha",
      event: "APPROVE",
    });
  });

  it("never fires the POST when the caller's signal was aborted while the preflight was in flight", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockImplementation(() => {
      // The environment's fetch doesn't actually reject on abort here (the
      // mock ignores the signal, like some real-world races where the
      // request already completed on the wire before abort() was called).
      controller.abort();
      return Promise.resolve(jsonResponse({ head: { sha: "current-sha" } }));
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      approvePullRequest(
        "token",
        "example/repo",
        1,
        "current-sha",
        controller.signal,
      ),
    ).rejects.toThrow(ApprovalAborted);

    expect(fetchMock).toHaveBeenCalledTimes(1); // only the preflight, never the POST
  });
});

describe("hasApprovalForSha", () => {
  it("finds a matching approval from the given login and commit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse([
          { user: { login: "octocat" }, state: "APPROVED", commit_id: "sha-1" },
          {
            user: { login: "someone-else" },
            state: "APPROVED",
            commit_id: "sha-2",
          },
        ]),
      ),
    );
    const result = await hasApprovalForSha(
      "token",
      "example/repo",
      1,
      "octocat",
      "sha-1",
    );
    expect(result).toEqual({ found: true, truncated: false });
  });

  it("confirms absence (not truncated) when the last page is short", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse([
          {
            user: { login: "octocat" },
            state: "APPROVED",
            commit_id: "sha-2",
          },
        ]),
      ),
    );
    const result = await hasApprovalForSha(
      "token",
      "example/repo",
      1,
      "octocat",
      "sha-1",
    );
    expect(result).toEqual({ found: false, truncated: false });
  });

  it("paginates through more than 100 reviews to find a later match", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      user: { login: "someone-else" },
      state: "APPROVED",
      commit_id: `sha-${index}`,
    }));
    const secondPage = [
      { user: { login: "octocat" }, state: "APPROVED", commit_id: "sha-1" },
    ];
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => Promise.resolve(jsonResponse(firstPage)))
      .mockImplementationOnce(() => Promise.resolve(jsonResponse(secondPage)));
    vi.stubGlobal("fetch", fetchMock);

    const result = await hasApprovalForSha(
      "token",
      "example/repo",
      1,
      "octocat",
      "sha-1",
    );
    expect(result).toEqual({ found: true, truncated: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports truncated (not a confirmed absence) when the review-page cap is hit without a match", async () => {
    const fullPage = Array.from({ length: 100 }, (_, index) => ({
      user: { login: "someone-else" },
      state: "APPROVED",
      commit_id: `sha-${index}`,
    }));
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(jsonResponse(fullPage)));
    vi.stubGlobal("fetch", fetchMock);

    const result = await hasApprovalForSha(
      "token",
      "example/repo",
      1,
      "octocat",
      "sha-1",
    );
    expect(result).toEqual({ found: false, truncated: true });
  });
});
