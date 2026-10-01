import { assert, afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { GitHubPanel } from "./index";
import { GitHubIssueIcon } from "../../shared/design-system/icons/index";
import { loadGitHubDetails } from "./data";
import { parseGitHubReference } from "./references";

afterEach(() => vi.unstubAllGlobals());
const reference = parseGitHubReference(
  "https://github.com/block/buzz/pull/23#discussion_r1",
);
assert.exists(reference);
it("keeps gateway icons decorative by default with an explicit named opt-in", () => {
  const decorative = renderToStaticMarkup(<GitHubIssueIcon />);
  expect(decorative).toContain('aria-hidden="true"');
  expect(decorative).not.toContain("role=");

  const meaningful = renderToStaticMarkup(
    <GitHubIssueIcon aria-hidden={false} role="img" aria-label="Open issue" />,
  );
  expect(meaningful).toContain('aria-hidden="false"');
  expect(meaningful).toContain('role="img"');
  expect(meaningful).toContain('aria-label="Open issue"');
});

it("opens a target without a channel, even when no message window contains it", () => {
  const html = renderToStaticMarkup(
    <GitHubPanel target={reference.url} close={() => {}} />,
  );
  expect(html).toContain("Pull request");
  expect(html).toContain(
    'href="https://github.com/block/buzz/pull/23#discussion_r1"',
  );
  expect(html).toContain("Loading from GitHub");
});
it("loads PR details and preserves merged state, branches, and change counts", async () => {
  const fetch = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        title: "Simplify panels",
        body: "An independent panel contract.",
        body_html: "<p>An independent panel contract.</p>",
        state: "closed",
        merged: true,
        user: { login: "author" },
        head: { label: "block:panels" },
        base: { label: "block:main" },
        changed_files: 3,
        additions: 10,
        deletions: 80,
      }),
    ),
  );
  vi.stubGlobal("fetch", fetch);
  const signal = new AbortController().signal;
  const data = await loadGitHubDetails(reference, signal);
  expect(fetch).toHaveBeenCalledWith(
    "https://api.github.com/repos/block/buzz/pulls/23",
    expect.objectContaining({
      signal,
      credentials: "omit",
      headers: { Accept: "application/vnd.github.full+json" },
    }),
  );
  expect(data).toMatchObject({
    title: "Simplify panels",
    state: "Merged",
    author: "author",
    body: "An independent panel contract.",
    bodyHtml: "<p>An independent panel contract.</p>",
  });
  expect(data.facts).toContainEqual([
    "Changes",
    { additions: 10, deletions: 80 },
  ]);
});
it.each([
  [404, "private or unavailable"],
  [403, "limit"],
  [429, "limit"],
  [500, "500"],
])("explains API failure %s", async (status, message) => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(null, { status: Number(status) })),
  );
  await expect(
    loadGitHubDetails(reference, new AbortController().signal),
  ).rejects.toThrow(String(message));
});

it.each([
  ["block/buzz", "tho/small-improvement", "tho/small-improvement"],
  ["BLOCK/Buzz", "tho/small-improvement", "tho/small-improvement"],
  ["contributor/buzz", "tho/small-improvement", "block:tho/small-improvement"],
  [
    "block/another-repo",
    "tho/small-improvement",
    "block:tho/small-improvement",
  ],
  [null, "tho/small-improvement", "block:tho/small-improvement"],
  ["block/buzz", undefined, "block:tho/small-improvement"],
])(
  "shortens branches only for a known matching repository: %s, %s",
  async (repository, ref, label) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            head: {
              label: "block:tho/small-improvement",
              ref,
              repo: repository ? { full_name: repository } : null,
            },
            base: {
              label: "block:main",
              ref: "main",
              repo: { full_name: "block/buzz" },
            },
          }),
        ),
      ),
    );
    const data = await loadGitHubDetails(
      reference,
      new AbortController().signal,
    );
    expect(data.facts).toContainEqual([
      "Branch",
      {
        head: {
          label,
          url:
            repository && ref
              ? `https://github.com/${repository}/tree/${ref}`
              : undefined,
        },
        base: { label: "main", url: "https://github.com/block/buzz/tree/main" },
      },
    ]);
  },
);
