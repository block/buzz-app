import { describe, expect, it } from "vitest";
import {
  buildAgentSummaryRequest,
  channelMembership,
  repliesFromAgent,
} from "./relaySummary";
import type { ChannelMessage, ChannelSummary } from "./relayTypes";
import type { PullRequestDetail, PullRequestFile } from "./types";

const PULL_REQUEST: PullRequestDetail = {
  url: "https://github.com/example/repo/pull/1",
  number: 1,
  repository: "example/repo",
  title: "Fix bug",
  body: "",
  author: "octocat",
  headSha: "head1234567890",
  baseSha: "base1234567890",
  baseRefName: "main",
  headRefName: "fix",
};

const EVENT_HARD_CAP_BYTES = 32 * 1024;

function file(overrides: Partial<PullRequestFile>): PullRequestFile {
  return {
    filename: "a.ts",
    status: "modified",
    additions: 1,
    deletions: 1,
    patch: "@@ -1 +1 @@\n-a\n+b",
    ...overrides,
  };
}

describe("buildAgentSummaryRequest", () => {
  it("includes every file's patch when comfortably under the size budget", () => {
    const result = buildAgentSummaryRequest(PULL_REQUEST, [
      file({ filename: "a.ts" }),
      file({ filename: "b.ts" }),
    ]);
    expect(result.hasUsableDiff).toBe(true);
    if (!result.hasUsableDiff) throw new Error("expected a usable diff");
    expect(result.includedFiles).toEqual(["a.ts", "b.ts"]);
    expect(result.omittedFiles).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(result.prompt).toContain("a.ts");
    expect(result.prompt).toContain("b.ts");
  });

  it("discloses files with no patch as omitted, not silently dropped", () => {
    const result = buildAgentSummaryRequest(PULL_REQUEST, [
      file({ filename: "a.ts" }),
      file({ filename: "big.bin", patch: null }),
    ]);
    expect(result.hasUsableDiff).toBe(true);
    if (!result.hasUsableDiff) throw new Error("expected a usable diff");
    expect(result.omittedFiles).toEqual([
      "big.bin (no patch available from GitHub)",
    ]);
    expect(result.truncated).toBe(true);
  });

  it("reports no usable diff when every file lacks a patch, and does not build a prompt", () => {
    const result = buildAgentSummaryRequest(PULL_REQUEST, [
      file({ filename: "big.bin", patch: null }),
    ]);
    expect(result.hasUsableDiff).toBe(false);
    expect(result.includedFiles).toEqual([]);
    expect(result.omittedFiles).toEqual([
      "big.bin (no patch available from GitHub)",
    ]);
  });

  it("reports no usable diff when there are no changed files at all", () => {
    const result = buildAgentSummaryRequest(PULL_REQUEST, []);
    expect(result.hasUsableDiff).toBe(false);
    expect(result.includedFiles).toEqual([]);
    expect(result.omittedFiles).toEqual([]);
  });

  it("stops including files once the byte budget is exceeded and discloses the rest as omitted", () => {
    const hugePatch = "x".repeat(20_000);
    const files = [
      file({ filename: "first.ts", patch: hugePatch }),
      file({ filename: "second.ts", patch: hugePatch }),
      file({ filename: "third.ts", patch: hugePatch }),
    ];
    const result = buildAgentSummaryRequest(PULL_REQUEST, files);
    expect(result.hasUsableDiff).toBe(true);
    if (!result.hasUsableDiff) throw new Error("expected a usable diff");
    expect(result.includedFiles).toEqual(["first.ts"]);
    expect(result.omittedFiles).toEqual([
      "second.ts (message size limit)",
      "third.ts (message size limit)",
    ]);
    expect(result.truncated).toBe(true);
    expect(
      new TextEncoder().encode(JSON.stringify(result.prompt)).length,
    ).toBeLessThan(EVENT_HARD_CAP_BYTES);
  });

  it("stays under the event hard cap for an escape-heavy, multi-byte-unicode diff that fits the budget", () => {
    const nastyPatch =
      `"quoted"\\backslash\nline\tbreak 🚀🚀🚀 “curly” ‘quotes’ — em-dash`.repeat(
        50,
      );
    const result = buildAgentSummaryRequest(PULL_REQUEST, [
      file({ filename: "unicode.ts", patch: nastyPatch }),
    ]);
    expect(result.hasUsableDiff).toBe(true);
    if (!result.hasUsableDiff) throw new Error("expected a usable diff");
    expect(result.includedFiles).toEqual(["unicode.ts"]);
    expect(
      new TextEncoder().encode(JSON.stringify(result.prompt)).length,
    ).toBeLessThan(EVENT_HARD_CAP_BYTES);
  });

  it("omits a single file whose escaped, unicode-expanded size alone exceeds the budget, rather than sending a partial event", () => {
    const nastyPatch =
      `"quoted"\\backslash\nline\tbreak 🚀🚀🚀 “curly” ‘quotes’ — em-dash`.repeat(
        500,
      );
    const result = buildAgentSummaryRequest(PULL_REQUEST, [
      file({ filename: "unicode.ts", patch: nastyPatch }),
    ]);
    expect(result.hasUsableDiff).toBe(false);
    expect(result.omittedFiles).toEqual(["unicode.ts (message size limit)"]);
  });

  it("truncates a giant pull request title rather than letting it blow the budget", () => {
    const result = buildAgentSummaryRequest(
      { ...PULL_REQUEST, title: "T".repeat(10_000) },
      [file({ filename: "a.ts" })],
    );
    expect(result.hasUsableDiff).toBe(true);
    if (!result.hasUsableDiff) throw new Error("expected a usable diff");
    expect(result.prompt).not.toContain("T".repeat(10_000));
    expect(
      new TextEncoder().encode(JSON.stringify(result.prompt)).length,
    ).toBeLessThan(EVENT_HARD_CAP_BYTES);
  });

  it("caps a very long list of omitted filenames in the sent prompt while staying under budget", () => {
    const hugePatch = "x".repeat(20_000);
    const files = [
      file({ filename: "included.ts", patch: hugePatch }),
      ...Array.from({ length: 200 }, (_, index) =>
        file({
          filename: `very/long/nested/path/to/omitted-file-number-${index}-with-a-long-name.ts`,
          patch: hugePatch,
        }),
      ),
    ];
    const result = buildAgentSummaryRequest(PULL_REQUEST, files);
    expect(result.hasUsableDiff).toBe(true);
    if (!result.hasUsableDiff) throw new Error("expected a usable diff");
    expect(result.includedFiles).toEqual(["included.ts"]);
    expect(result.omittedFiles).toHaveLength(200);
    expect(result.prompt).toContain("Partial diff: 200 file(s) omitted");
    expect(
      new TextEncoder().encode(JSON.stringify(result.prompt)).length,
    ).toBeLessThan(EVENT_HARD_CAP_BYTES);
  });

  it("keeps the final prompt bounded even with 20 escaped, multi-byte-unicode, near-max-length omitted filenames and a near-budget included diff", () => {
    // Filenames engineered to maximize JSON-escaping and encoded byte cost:
    // quotes, backslashes, and emoji, each padded out near a plausible max
    // filename length. The count-only footer must stay a fixed, small size
    // regardless of what these names look like.
    const nastyFilenameFor = (index: number) =>
      `very/"nasty"\\path/🚀${"a".repeat(60)}-${index}.ts`;
    // A single included diff sized to land close to CONTENT_BYTE_BUDGET
    // (24 KiB) on its own, leaving very little headroom before the footer
    // is appended.
    const nearBudgetPatch = "x".repeat(23_000);
    const files = [
      file({ filename: "included.ts", patch: nearBudgetPatch }),
      ...Array.from({ length: 20 }, (_, index) =>
        file({ filename: nastyFilenameFor(index), patch: null }),
      ),
    ];
    const result = buildAgentSummaryRequest(PULL_REQUEST, files);
    expect(result.hasUsableDiff).toBe(true);
    if (!result.hasUsableDiff) throw new Error("expected a usable diff");
    expect(result.omittedFiles).toHaveLength(20);
    expect(
      new TextEncoder().encode(JSON.stringify(result.prompt)).length,
    ).toBeLessThan(EVENT_HARD_CAP_BYTES);
  });
  it("marks the summary as partial when the compare API itself hit its file cap, even if everything fetched fit", () => {
    const result = buildAgentSummaryRequest(
      PULL_REQUEST,
      [file({ filename: "a.ts" })],
      { moreFilesBeyondFetchCap: true },
    );
    expect(result.hasUsableDiff).toBe(true);
    if (!result.hasUsableDiff) throw new Error("expected a usable diff");
    expect(result.truncated).toBe(true);
    expect(result.omittedFiles).toEqual([]);
    expect(result.prompt).toContain("more files than GitHub's diff view");
  });
});

function channel(overrides: Partial<ChannelSummary>): ChannelSummary {
  return {
    id: "channel-1",
    name: "general",
    ...overrides,
  } as ChannelSummary;
}

describe("channelMembership", () => {
  it("reports member when the agent pubkey is in the exact roster", () => {
    expect(
      channelMembership(channel({ members: ["agent-pubkey"] }), "agent-pubkey"),
    ).toBe("member");
  });

  it("reports not-member when the roster is known and excludes the pubkey", () => {
    expect(
      channelMembership(channel({ members: ["someone-else"] }), "agent-pubkey"),
    ).toBe("not-member");
  });

  it("reports unknown when the roster is absent, never assuming membership", () => {
    expect(
      channelMembership(channel({ members: undefined }), "agent-pubkey"),
    ).toBe("unknown");
  });

  it("reports unknown when no channel is selected", () => {
    expect(channelMembership(undefined, "agent-pubkey")).toBe("unknown");
  });
});

function message(overrides: Partial<ChannelMessage>): ChannelMessage {
  return {
    id: "event-1",
    channelId: "channel-1",
    authorId: "agent-pubkey",
    createdAt: 0,
    content: "hello",
    mentions: [],
    attachments: [],
    reactions: [],
    participants: [],
    ...overrides,
  } as ChannelMessage;
}

describe("repliesFromAgent", () => {
  it("keeps only replies authored by the selected agent pubkey", () => {
    const replies = [
      message({ id: "1", authorId: "agent-pubkey", content: "from agent" }),
      message({ id: "2", authorId: "someone-else", content: "from human" }),
    ];
    expect(repliesFromAgent(replies, "agent-pubkey")).toEqual([replies[0]]);
  });

  it("returns an empty list when no reply is from the selected agent", () => {
    const replies = [message({ authorId: "someone-else" })];
    expect(repliesFromAgent(replies, "agent-pubkey")).toEqual([]);
  });
});
