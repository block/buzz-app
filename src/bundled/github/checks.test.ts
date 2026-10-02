import { afterEach, expect, it, vi } from "vitest";
import { loadGitHubChecks } from "./checks";

afterEach(() => vi.unstubAllGlobals());
const signal = () => new AbortController().signal;
const run = (conclusion: string | null, status = "completed") => ({
  status,
  conclusion,
});
function fixtures(runs: unknown[], statuses: unknown[] = []) {
  const fetch = vi.fn(
    async (url: string) =>
      new Response(
        JSON.stringify(
          url.includes("check-runs")
            ? { total_count: runs.length, check_runs: runs }
            : { total_count: statuses.length, state: "pending", statuses },
        ),
      ),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
it("combines actual runs and contexts, without treating empty combined pending as pending", async () => {
  const fetch = fixtures([run("success"), run("success"), run("skipped")]);
  const controller = new AbortController();
  const summary = await loadGitHubChecks(
    "sample/project",
    "head-sha",
    controller.signal,
  );
  expect(summary).toEqual({
    state: "success",
    label: "Successful",
    description: "PR head commit · 1 skipped, 2 successful checks.",
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch).toHaveBeenCalledWith(
    "https://api.github.com/repos/sample/project/commits/head-sha/check-runs?per_page=100&page=1&filter=latest",
    {
      signal: controller.signal,
      credentials: "omit",
      headers: { Accept: "application/vnd.github+json" },
    },
  );
});
it("keeps full categorized counts and prioritizes failure over pending", async () => {
  fixtures(
    [
      run("failure"),
      run("cancelled"),
      run("skipped"),
      run("neutral"),
      run(null, "queued"),
      run(null, "in_progress"),
      run("success"),
    ],
    [{ state: "error" }, { state: "pending" }, { state: "success" }],
  );
  expect(
    await loadGitHubChecks("sample/project", "head-sha", signal()),
  ).toEqual({
    state: "failure",
    label: "Some not successful",
    description:
      "PR head commit · 2 failing, 1 cancelled, 3 pending, 1 skipped, 1 neutral, 2 successful checks.",
  });
});
it.each([
  "failure",
  "timed_out",
  "action_required",
  "stale",
  "startup_failure",
  "cancelled",
])("does not mark %s successful", async (conclusion) => {
  fixtures([run(conclusion)]);
  expect(
    await loadGitHubChecks("sample/project", "sha", signal()),
  ).toMatchObject({ state: "failure" });
});
it.each(["queued", "in_progress", "waiting", "pending", "requested"])(
  "represents %s as pending",
  async (status) => {
    fixtures([run(null, status)]);
    expect(
      await loadGitHubChecks("sample/project", "sha", signal()),
    ).toMatchObject({
      state: "pending",
      description: "PR head commit · 1 pending check.",
    });
  },
);
it.each([
  [[], "neutral", "No checks"],
  [[run("skipped"), run("neutral")], "neutral", "No failures"],
  [[run(null), run("success")], "unavailable", "Unknown"],
  [[run("new-conclusion")], "unavailable", "Unknown"],
  [[run(null, "new-status")], "unavailable", "Unknown"],
])(
  "preserves empty, neutral and unknown results: %j",
  async (runs, state, label) => {
    fixtures(runs);
    expect(
      await loadGitHubChecks("sample/project", "sha", signal()),
    ).toMatchObject({ state, label });
  },
);
it("reads subsequent pages for both sources before claiming complete counts", async () => {
  const fetch = vi.fn(async (url: string) => {
    const page = Number(new URL(url).searchParams.get("page"));
    const runs = url.includes("check-runs");
    return new Response(
      JSON.stringify({
        total_count: 101,
        [runs ? "check_runs" : "statuses"]: Array.from(
          { length: page === 1 ? 100 : 1 },
          () => (runs ? run("success") : { state: "success" }),
        ),
      }),
    );
  });
  vi.stubGlobal("fetch", fetch);
  expect(
    await loadGitHubChecks("sample/project", "sha", signal()),
  ).toMatchObject({
    state: "success",
    description: "PR head commit · 202 successful checks.",
  });
  expect(fetch).toHaveBeenCalledTimes(4);
});
it("caps reads at three pages per source and labels counts partial", async () => {
  const fetch = vi.fn(
    async (url: string) =>
      new Response(
        JSON.stringify(
          url.includes("check-runs")
            ? {
                total_count: 301,
                check_runs: Array.from({ length: 100 }, () => run("success")),
              }
            : { total_count: 0, statuses: [] },
        ),
      ),
  );
  vi.stubGlobal("fetch", fetch);
  expect(
    await loadGitHubChecks("sample/project", "sha", signal()),
  ).toMatchObject({
    state: "unavailable",
    label: "Incomplete",
    description:
      "PR head commit · Partial counts (page limit reached): 300 successful checks.",
  });
  expect(fetch).toHaveBeenCalledTimes(4);
});
it("honors next-page evidence even when a reported total would suggest completion", async () => {
  const fetch = vi.fn(async (url: string) => {
    const page = Number(new URL(url).searchParams.get("page"));
    return new Response(
      JSON.stringify(
        url.includes("check-runs")
          ? {
              total_count: 1,
              check_runs: [run(page === 1 ? "success" : "failure")],
            }
          : { total_count: 0, statuses: [] },
      ),
      {
        headers:
          url.includes("check-runs") && page === 1
            ? { Link: '<https://api.github.com/example?page=2>; rel="next"' }
            : {},
      },
    );
  });
  vi.stubGlobal("fetch", fetch);
  expect(
    await loadGitHubChecks("sample/project", "sha", signal()),
  ).toMatchObject({ state: "failure" });
});
it.each([
  "403",
  "404",
  "429",
  "500",
  "network",
  "malformed",
  "empty-page",
  "invalid-item",
  "aborted",
])("keeps %s reads unavailable, not green", async (failure) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (!url.includes("check-runs"))
        return new Response(
          JSON.stringify({ total_count: 1, statuses: [{ state: "success" }] }),
        );
      if (failure === "network") throw new Error("offline");
      if (failure === "aborted")
        throw new DOMException("Aborted", "AbortError");
      if (failure === "malformed") return new Response("{}");
      if (failure === "empty-page")
        return new Response(JSON.stringify({ total_count: 1, check_runs: [] }));
      if (failure === "invalid-item")
        return new Response(
          JSON.stringify({ total_count: 1, check_runs: [null] }),
        );
      return new Response(null, { status: Number(failure) });
    }),
  );
  expect(
    await loadGitHubChecks("sample/project", "sha", signal()),
  ).toMatchObject({ state: "unavailable", label: "Unavailable" });
});

it("does not call successful runs a complete success when legacy statuses fail", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.includes("check-runs")
        ? new Response(
            JSON.stringify({ total_count: 1, check_runs: [run("success")] }),
          )
        : new Response(null, { status: 429 }),
    ),
  );
  expect(
    await loadGitHubChecks("sample/project", "sha", signal()),
  ).toMatchObject({ state: "unavailable", label: "Unavailable" });
});
