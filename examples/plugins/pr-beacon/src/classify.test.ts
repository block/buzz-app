import { describe, expect, it } from "vitest";
import {
  classifyOwnPullRequest,
  isHighlighted,
  isVIP,
  matchesWatchedLabel,
} from "./classify";
import type { OwnPullRequest } from "./types";

function ownPullRequest(overrides: Partial<OwnPullRequest>): OwnPullRequest {
  return {
    url: "https://github.com/example/repo/pull/1",
    number: 1,
    repository: "example/repo",
    title: "Example",
    author: "octocat",
    isDraft: false,
    labels: [],
    updatedAt: "2026-01-01T00:00:00Z",
    reviewDecision: null,
    mergeStateStatus: null,
    checkState: null,
    ...overrides,
  };
}

describe("isVIP", () => {
  it("matches case-insensitively", () => {
    expect(isVIP("Octocat", ["octocat"])).toBe(true);
  });
  it("does not match an unrelated login", () => {
    expect(isVIP("someone-else", ["octocat"])).toBe(false);
  });
});

describe("matchesWatchedLabel", () => {
  it("is false when no labels are watched", () => {
    expect(matchesWatchedLabel(["bug"], [])).toBe(false);
  });
  it("matches case-insensitively", () => {
    expect(matchesWatchedLabel(["Payments-SDK"], ["payments-sdk"])).toBe(true);
  });
});

describe("isHighlighted", () => {
  const base = {
    url: "u",
    number: 1,
    repository: "r",
    title: "t",
    author: "someone",
    isDraft: false,
    labels: ["merbro"],
    updatedAt: "",
    reviewDecision: null,
  };
  it("highlights a VIP author", () => {
    expect(isHighlighted({ ...base, author: "vip" }, ["vip"], [])).toBe(true);
  });
  it("highlights a watched label", () => {
    expect(isHighlighted(base, [], ["merbro"])).toBe(true);
  });
  it("does not highlight an ordinary request", () => {
    expect(isHighlighted(base, ["someone-else"], ["other-label"])).toBe(false);
  });
});

describe("classifyOwnPullRequest", () => {
  it("classifies a draft regardless of review state", () => {
    expect(
      classifyOwnPullRequest(
        ownPullRequest({ isDraft: true, reviewDecision: "APPROVED" }),
      ),
    ).toBe("draft");
  });
  it("classifies changes requested as needs-response", () => {
    expect(
      classifyOwnPullRequest(
        ownPullRequest({ reviewDecision: "CHANGES_REQUESTED" }),
      ),
    ).toBe("needs-response");
  });
  it("classifies approved with failing checks as failing-checks", () => {
    expect(
      classifyOwnPullRequest(
        ownPullRequest({ reviewDecision: "APPROVED", checkState: "FAILURE" }),
      ),
    ).toBe("failing-checks");
  });
  it("classifies approved, passing, and clean as ready-to-merge", () => {
    expect(
      classifyOwnPullRequest(
        ownPullRequest({
          reviewDecision: "APPROVED",
          checkState: "SUCCESS",
          mergeStateStatus: "CLEAN",
        }),
      ),
    ).toBe("ready-to-merge");
  });
  it("does not guess ready-to-merge when mergeStateStatus is unresolved", () => {
    expect(
      classifyOwnPullRequest(
        ownPullRequest({
          reviewDecision: "APPROVED",
          checkState: "SUCCESS",
          mergeStateStatus: "UNKNOWN",
        }),
      ),
    ).toBe("unknown");
  });
  it("does not guess ready-to-merge when checks are still pending", () => {
    expect(
      classifyOwnPullRequest(
        ownPullRequest({
          reviewDecision: "APPROVED",
          checkState: "PENDING",
          mergeStateStatus: "CLEAN",
        }),
      ),
    ).toBe("unknown");
  });
  it("classifies review-required as awaiting-review", () => {
    expect(
      classifyOwnPullRequest(
        ownPullRequest({ reviewDecision: "REVIEW_REQUIRED" }),
      ),
    ).toBe("awaiting-review");
  });
});
