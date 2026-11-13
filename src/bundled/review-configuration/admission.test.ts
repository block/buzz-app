import { afterEach, expect, it, vi } from "vitest";
import { admissionFailure, createAdmissionReader } from "./admission";
import { DEFAULT_ADMISSION } from "./configuration";
import type { GitHubCli } from "../github/gh";
const checks = { ...DEFAULT_ADMISSION, ready: true, ci: true, conflicts: true };
const facts = {
  head: "a".repeat(40),
  open: true,
  draft: false,
  mergeable: true,
  ci: "pass" as const,
};
const signal = () => new AbortController().signal;
afterEach(() => vi.unstubAllGlobals());
it("only enforces selected gates and blocks unknown results", () => {
  expect(admissionFailure(checks, facts)).toBeUndefined();
  for (const [value, message] of [
    [{ draft: true }, "draft"],
    [{ ci: "fail" }, "failing"],
    [{ ci: "pending" }, "pending"],
    [{ ci: "none" }, "No CI"],
    [{ mergeable: false }, "conflicts"],
    [{ mergeable: null }, "calculating"],
    [{ open: false }, "closed"],
  ] as const)
    expect(admissionFailure(checks, { ...facts, ...value })).toContain(message);
  expect(
    admissionFailure(DEFAULT_ADMISSION, {
      ...facts,
      draft: true,
      ci: "fail",
      mergeable: false,
    }),
  ).toBeUndefined();
});
it("reads the authenticated GitHub rollup and refuses a mismatched commit", async () => {
  const pull = {
    state: "OPEN",
    isDraft: false,
    mergeable: "MERGEABLE",
    headRefOid: facts.head,
    commits: {
      nodes: [
        {
          commit: { oid: facts.head, statusCheckRollup: { state: "SUCCESS" } },
        },
      ],
    },
  };
  const gh = vi.fn(async () => ({ repository: { pullRequest: pull } }));
  expect(
    await createAdmissionReader(gh as GitHubCli)(
      "example-org/project",
      1,
      checks,
      signal(),
    ),
  ).toEqual(facts);
  pull.headRefOid = "b".repeat(40);
  await expect(
    createAdmissionReader(gh as GitHubCli)(
      "example-org/project",
      1,
      checks,
      signal(),
    ),
  ).rejects.toThrow("changed");
});
it("combines public commit statuses and check runs, including skipped checks", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        state: "open",
        draft: false,
        mergeable: true,
        head: { sha: facts.head },
      }),
    )
    .mockResolvedValueOnce(
      Response.json({ total_count: 1, statuses: [{ state: "success" }] }),
    )
    .mockResolvedValueOnce(
      Response.json({
        total_count: 1,
        check_runs: [{ status: "completed", conclusion: "skipped" }],
      }),
    );
  vi.stubGlobal("fetch", fetcher);
  expect(
    await createAdmissionReader()("example-org/project", 1, checks, signal()),
  ).toEqual(facts);
  expect(fetcher.mock.calls[1]?.[0]).toContain(facts.head);
});
it("refuses partial public CI pages", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          state: "open",
          draft: false,
          mergeable: true,
          head: { sha: facts.head },
        }),
      )
      .mockResolvedValueOnce(Response.json({ total_count: 101, statuses: [] }))
      .mockResolvedValueOnce(Response.json({ total_count: 0, check_runs: [] })),
  );
  await expect(
    createAdmissionReader()("example-org/project", 1, checks, signal()),
  ).rejects.toThrow("incomplete");
});
