import { afterEach, expect, it, vi } from "vitest";
import { createPullReader, createPullStatusReader } from "./pull-facts";
import { GhUnavailable, type GitHubCli } from "../github/gh";
const signal = () => new AbortController().signal;
const repository = "example-org/project";
const metadata = {
  title: "Fix auth",
  head: { sha: "a".repeat(40) },
  base: { sha: "b".repeat(40) },
  changed_files: 2,
  labels: [{ name: "security" }],
};
const answer = (paths: string[], hasNextPage = false) => ({
  repository: {
    pullRequest: {
      title: metadata.title,
      headRefOid: metadata.head.sha,
      baseRefOid: metadata.base.sha,
      changedFiles: 2,
      labels: { nodes: metadata.labels, pageInfo: { hasNextPage: false } },
      files: {
        nodes: paths.map((path) => ({ path })),
        pageInfo: { hasNextPage, endCursor: hasNextPage ? "next" : null },
      },
    },
  },
});
afterEach(() => vi.unstubAllGlobals());
it("loads all file pages and labels through the existing authenticated client", async () => {
  const gh = vi
    .fn()
    .mockResolvedValueOnce(answer(["src/a.ts"], true))
    .mockResolvedValueOnce(answer(["src/b.ts"]));
  const facts = await createPullReader(gh as GitHubCli)(
    repository,
    12,
    signal(),
  );
  expect(facts.paths).toEqual(["src/a.ts", "src/b.ts"]);
  expect(facts.labels).toEqual(["security"]);
  expect(gh.mock.calls[1]?.[1]).toMatchObject({
    owner: "example-org",
    name: "project",
    pr: 12,
    cursor: "next",
  });
});
it("rejects incomplete file lists, duplicate pages, incomplete labels and changed heads", async () => {
  const incompleteLabels = answer(["a", "b"]);
  incompleteLabels.repository.pullRequest.labels.pageInfo.hasNextPage = true;
  const changed = answer(["b"]);
  changed.repository.pullRequest.headRefOid = "c".repeat(40);
  for (const replies of [
    [answer(["a"])],
    [answer(["a"], true), answer(["a"])],
    [incompleteLabels],
    [answer(["a"], true), changed],
  ]) {
    const gh = vi.fn();
    for (const reply of replies) gh.mockResolvedValueOnce(reply);
    await expect(
      createPullReader(gh as GitHubCli)(repository, 12, signal()),
    ).rejects.toThrow();
  }
});
it("uses public reads when desktop processes are unavailable and verifies metadata again", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json(metadata))
    .mockResolvedValueOnce(
      Response.json([{ filename: "a" }, { filename: "b" }]),
    )
    .mockResolvedValueOnce(Response.json(metadata));
  vi.stubGlobal("fetch", fetcher);
  const gh = vi.fn().mockRejectedValue(new GhUnavailable("browser"));
  const facts = await createPullReader(gh as GitHubCli)(
    repository,
    12,
    signal(),
  );
  expect(facts.paths).toEqual(["a", "b"]);
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
    credentials: "omit",
    signal: expect.any(AbortSignal),
  });
});
it("does not route a public snapshot changed during file pagination", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(Response.json(metadata))
      .mockResolvedValueOnce(
        Response.json([{ filename: "a" }, { filename: "b" }]),
      )
      .mockResolvedValueOnce(Response.json({ ...metadata, labels: [] })),
  );
  await expect(createPullReader()(repository, 12, signal())).rejects.toThrow(
    "PR changed",
  );
});
it("stops at API errors, cancellation and the file limit", async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response("", { status: 404 }));
  vi.stubGlobal("fetch", fetcher);
  await expect(createPullReader()(repository, 12, signal())).rejects.toThrow(
    "private or unavailable",
  );
  fetcher.mockResolvedValueOnce(
    Response.json({ ...metadata, changed_files: 3001 }),
  );
  await expect(createPullReader()(repository, 12, signal())).rejects.toThrow(
    "3,000",
  );
  const controller = new AbortController();
  controller.abort();
  await expect(
    createPullReader()(repository, 12, controller.signal),
  ).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it.each([
  ["OPEN", false, "Open"],
  ["OPEN", true, "Draft"],
  ["CLOSED", false, "Closed"],
  ["MERGED", false, "Merged"],
])(
  "reads GitHub status %s without loading file pages",
  async (state, isDraft, expected) => {
    const gh = vi
      .fn()
      .mockResolvedValue({ repository: { pullRequest: { state, isDraft } } });
    expect(
      await createPullStatusReader(gh as GitHubCli)(repository, 12, signal()),
    ).toBe(expected);
    expect(gh).toHaveBeenCalledTimes(1);
    expect(gh.mock.calls[0]?.[0]).not.toContain("files(");
  },
);

it.each([
  ["open", false, false, "Open"],
  ["open", true, false, "Draft"],
  ["closed", false, false, "Closed"],
  ["closed", false, true, "Merged"],
])(
  "reads public lifecycle status and falls back only when gh is unavailable",
  async (state, draft, merged, expected) => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(Response.json({ state, draft, merged }));
    vi.stubGlobal("fetch", fetcher);
    const gh = vi.fn().mockRejectedValue(new GhUnavailable("browser"));
    expect(
      await createPullStatusReader(gh as GitHubCli)(repository, 12, signal()),
    ).toBe(expected);
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);

it("rejects unavailable or invalid status and never falls back on authenticated failures", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      Response.json({ state: "mystery", draft: false, merged: false }),
    );
  vi.stubGlobal("fetch", fetcher);
  await expect(
    createPullStatusReader()(repository, 12, signal()),
  ).rejects.toThrow("unknown PR status");
  const gh = vi.fn().mockRejectedValue(new Error("GitHub denied access"));
  await expect(
    createPullStatusReader(gh as GitHubCli)(repository, 12, signal()),
  ).rejects.toThrow("denied access");
  expect(fetcher).toHaveBeenCalledTimes(1);
});
