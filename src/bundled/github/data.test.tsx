import { assert, afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { GitHubPanel } from "./index";
import { loadGitHubDetails } from "./data";
import { parseGitHubReference } from "./references";

afterEach(() => vi.unstubAllGlobals());
const reference = parseGitHubReference(
  "https://github.com/block/buzz/pull/23#discussion_r1",
);
assert.exists(reference);
it("opens a target without a channel, even when no message window contains it", () => {
  const html = renderToStaticMarkup(
    <GitHubPanel target={reference.url} close={() => {}} />,
  );
  expect(html).toContain("#23");
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
    expect.objectContaining({ signal, credentials: "omit" }),
  );
  expect(data).toMatchObject({
    title: "Simplify panels",
    state: "Merged",
    author: "author",
  });
  expect(data.facts).toContainEqual(["Changes", "+10 / −80"]);
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
