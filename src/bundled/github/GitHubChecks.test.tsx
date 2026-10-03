// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { GitHubPanel } from "./index";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const target = "https://github.com/sample/project/pull/1";
const pull = {
  title: "A small change",
  head: { label: "sample:feature", sha: "head-sha" },
};
const response = (data: unknown) => new Response(JSON.stringify(data));

it("renders PR details while checks load, then exposes counts by pointer and keyboard", async () => {
  let finish!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  const fetch = vi.fn((url: string) => {
    if (/\/pulls\/\d+$/.test(url)) return Promise.resolve(response(pull));
    if (url.includes("/check-runs?")) return pending;
    return Promise.resolve(
      response({ total_count: 0, state: "pending", statuses: [] }),
    );
  });
  vi.stubGlobal("fetch", fetch);
  render(<GitHubPanel target={target} close={() => {}} />);
  await screen.findByRole("heading", { name: "A small change" });
  await userEvent.setup().click(screen.getByRole("tab", { name: "Checks" }));
  expect(screen.getByText("Loading…")).toBeVisible();
  await act(async () =>
    finish(
      response({
        total_count: 4,
        check_runs: [
          { status: "completed", conclusion: "failure" },
          { status: "completed", conclusion: "cancelled" },
          { status: "completed", conclusion: "skipped" },
          { status: "completed", conclusion: "success" },
        ],
      }),
    ),
  );
  const summary = (await screen.findByText("Some checks were not successful"))
    .parentElement;
  if (!summary) throw new Error("Missing check summary");
  expect(summary).toHaveAttribute("data-check-state", "failure");
  expect(summary.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  expect(fetch.mock.calls.map(([url]) => url).sort()).toEqual([
    "https://api.github.com/repos/sample/project/commits/head-sha/check-runs?per_page=100&page=1&filter=latest",
    "https://api.github.com/repos/sample/project/commits/head-sha/status?per_page=100&page=1",
    "https://api.github.com/repos/sample/project/pulls/1",
  ]);
  const user = userEvent.setup();
  await user.hover(summary);
  const tooltip = await screen.findByRole("tooltip");
  expect(tooltip).toHaveTextContent(
    "PR head commit · 1 failing, 1 cancelled, 1 skipped, 1 successful checks.",
  );
  expect(summary).toHaveAccessibleDescription(tooltip.textContent ?? "");
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument(),
  );
  await user.unhover(summary);
  await act(async () => summary.focus());
  expect(await screen.findByRole("tooltip")).toBeVisible();
});
it("keeps PR details after a checks failure and allows a read-only retry", async () => {
  let fail = true;
  const fetch = vi.fn(async (url: string) => {
    if (/\/pulls\/\d+$/.test(url)) return response(pull);
    if (url.includes("/check-runs?"))
      return fail
        ? new Response(null, { status: 403 })
        : response({
            total_count: 1,
            check_runs: [{ status: "completed", conclusion: "success" }],
          });
    return response({ total_count: 0, statuses: [] });
  });
  vi.stubGlobal("fetch", fetch);
  render(<GitHubPanel target={target} close={() => {}} />);
  await screen.findByRole("tab", { name: "Checks" });
  await userEvent.setup().click(screen.getByRole("tab", { name: "Checks" }));
  const retry = await screen.findByRole("button", { name: "Retry checks" });
  expect(screen.getByRole("heading", { name: "A small change" })).toBeVisible();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  fail = false;
  await userEvent.setup().click(retry);
  expect((await screen.findByText("Successful")).parentElement).toHaveAttribute(
    "data-check-state",
    "success",
  );
  expect(
    fetch.mock.calls.filter(([url]) => /\/pulls\/\d+$/.test(url)),
  ).toHaveLength(1);
});
it("aborts checks when the panel target changes and ignores the late old result", async () => {
  let finish!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  const signals: AbortSignal[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, options: RequestInit) => {
      if (/\/pulls\/\d+$/.test(url)) return Promise.resolve(response(pull));
      if (url.includes("/issues/"))
        return Promise.resolve(response({ title: "An issue" }));
      signals.push(options.signal as AbortSignal);
      return url.includes("/check-runs?")
        ? pending
        : Promise.resolve(response({ total_count: 0, statuses: [] }));
    }),
  );
  const view = render(<GitHubPanel target={target} close={() => {}} />);
  await userEvent
    .setup()
    .click(await screen.findByRole("tab", { name: "Checks" }));
  await screen.findByText("Loading…");
  view.rerender(
    <GitHubPanel
      target="https://github.com/sample/project/issues/2"
      close={() => {}}
    />,
  );
  await screen.findByRole("heading", { name: "An issue" });
  expect(signals).toHaveLength(2);
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  await act(async () =>
    finish(
      response({
        total_count: 1,
        check_runs: [{ status: "completed", conclusion: "failure" }],
      }),
    ),
  );
  expect(
    screen.queryByText("Some checks were not successful"),
  ).not.toBeInTheDocument();
  expect(screen.queryByText("Checks")).not.toBeInTheDocument();
});
it("shows honest missing-head state without inventing a head check request", async () => {
  const fetch = vi.fn(async () => response({ title: "Old PR" }));
  vi.stubGlobal("fetch", fetch);
  render(<GitHubPanel target={target} close={() => {}} />);
  await screen.findByRole("heading", { name: "Old PR" });
  await screen.findByRole("tab", { name: "Discussion" });
  await userEvent.setup().click(screen.getByRole("tab", { name: "Checks" }));
  expect(screen.getAllByText("Unavailable")).toHaveLength(1);
  expect(
    screen.queryByRole("button", { name: "Retry checks" }),
  ).not.toBeInTheDocument();
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("shows named rows with honest outcomes, descriptions and links without extra requests", async () => {
  const fetch = vi.fn(async (url: string) => {
    if (/\/pulls\/\d+$/.test(url)) return response(pull);
    if (url.includes("/check-runs?"))
      return response({
        total_count: 4,
        check_runs: [
          {
            name: "Unit tests",
            status: "completed",
            conclusion: "success",
            details_url: "https://github.com/sample/project/actions/runs/1",
            output: { title: "All tests passed" },
          },
          { name: "Browser tests", status: "in_progress", conclusion: null },
          {
            name: "Optional deployment",
            status: "completed",
            conclusion: "skipped",
            details_url: "javascript:alert(1)",
          },
          { name: "Advisory", status: "completed", conclusion: "neutral" },
        ],
      });
    return response({
      total_count: 1,
      statuses: [
        {
          context: "Build",
          state: "failure",
          description: "Compilation failed",
          target_url: "https://ci.example.test/build/1",
        },
      ],
    });
  });
  vi.stubGlobal("fetch", fetch);
  render(<GitHubPanel target={target} close={() => {}} />);
  await screen.findByRole("tab", { name: "Discussion" });
  expect(fetch).toHaveBeenCalledTimes(1);
  const user = userEvent.setup();
  await user.click(screen.getByRole("tab", { name: "Checks" }));
  const checks = screen.getByRole("tabpanel", { name: "Checks" });
  const list = await within(checks).findByRole("list", {
    name: "successful checks on the PR head commit",
  });
  const skipped = within(checks).getByRole("button", {
    name: "1 skipped check",
  });
  expect(skipped).toHaveAttribute("aria-expanded", "false");
  const skippedList = within(checks).getByRole("list", {
    name: "skipped checks on the PR head commit",
    hidden: true,
  });
  expect(skippedList).not.toBeVisible();
  await user.click(skipped);
  expect(skipped).toHaveAttribute("aria-expanded", "true");
  expect(skippedList).toBeVisible();
  const rows = within(checks).getAllByRole("listitem");
  expect(rows.map((row) => row.getAttribute("data-check-category"))).toEqual([
    "failing",
    "pending",
    "skipped",
    "neutral",
    "successful",
  ]);
  expect(rows[0]).toHaveTextContent("BuildFailedCompilation failed");
  expect(rows[4]).toHaveTextContent("Unit testsPassedAll tests passed");
  expect(rows[2]).toHaveTextContent("Skipped");
  expect(rows[3]).toHaveTextContent("Neutral");
  const link = within(list).getByRole("link", { name: "Unit tests" });
  expect(link).toHaveAttribute(
    "href",
    "https://github.com/sample/project/actions/runs/1",
  );
  expect(link).toHaveAttribute("target", "_blank");
  expect(link).toHaveAttribute("rel", "noreferrer");
  expect(
    within(checks).queryByRole("link", { name: "Optional deployment" }),
  ).not.toBeInTheDocument();
  for (const row of rows)
    expect(row.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  expect(
    within(checks)
      .getAllByRole("button")
      .map((button) => button.textContent),
  ).toEqual([
    "1 failing check",
    "1 pending check",
    "1 skipped check",
    "1 neutral check",
    "1 successful check",
  ]);
  const successful = within(checks).getByRole("button", {
    name: "1 successful check",
  });
  await user.click(successful);
  expect(successful).toHaveAttribute("aria-expanded", "false");
  expect(list).not.toBeVisible();
  await user.click(screen.getByRole("tab", { name: "Discussion" }));
  await user.click(screen.getByRole("tab", { name: "Checks" }));
  expect(successful).toHaveAttribute("aria-expanded", "false");
  expect(skipped).toHaveAttribute("aria-expanded", "true");
  expect(skippedList).toBeVisible();
  await user.click(successful);
  expect(
    screen.getByRole("list", {
      name: "successful checks on the PR head commit",
    }),
  ).toBe(list);
  expect(list).toBeVisible();
  expect(fetch).toHaveBeenCalledTimes(3);
});

it("keeps unknown checks distinct from success instead of drawing a reassuring ring", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (/\/pulls\/\d+$/.test(url)) return response(pull);
      return response(
        url.includes("/check-runs?")
          ? {
              total_count: 2,
              check_runs: [
                {
                  name: "Unit tests",
                  status: "completed",
                  conclusion: "success",
                },
                {
                  name: "Unrecognized check",
                  status: "completed",
                  conclusion: "future-result",
                },
              ],
            }
          : { total_count: 0, statuses: [] },
      );
    }),
  );
  render(<GitHubPanel target={target} close={() => {}} />);
  await userEvent
    .setup()
    .click(await screen.findByRole("tab", { name: "Checks" }));
  const checks = screen.getByRole("tabpanel", { name: "Checks" });
  const summary = (
    await within(checks).findByText("Unknown", {
      selector: "[class*=checkSummaryLabel]",
    })
  ).closest("[data-check-state]");
  expect(summary).toHaveAttribute("data-check-state", "unavailable");
  expect(summary?.querySelector("circle[data-check-category]")).toBeNull();
  expect(
    within(checks).getByRole("button", { name: "1 unknown check" }),
  ).toHaveAttribute("aria-expanded", "true");
  expect(
    within(checks).getByRole("button", { name: "Retry checks" }),
  ).toBeVisible();
});

it("retains main's description DOM and pending checks across tab switches without eager requests", async () => {
  const pending: ((response: Response) => void)[] = [];
  const fetch = vi.fn((url: string) =>
    url.includes("/commits/")
      ? new Promise<Response>((resolve) => pending.push(resolve))
      : Promise.resolve(
          response({
            ...pull,
            body: "Main description\n\n## Details",
            body_html: "<p>Main description</p><h2>Details</h2>",
          }),
        ),
  );
  vi.stubGlobal("fetch", fetch);
  render(<GitHubPanel target={target} close={() => {}} />);
  const description = await screen.findByRole("heading", { name: "Details" });
  const user = userEvent.setup();
  expect(screen.getByRole("tab", { name: "Discussion" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(fetch).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole("tab", { name: "Checks" }));
  await waitFor(() => expect(pending).toHaveLength(2));
  await user.click(screen.getByRole("tab", { name: "Discussion" }));
  expect(screen.getByRole("heading", { name: "Details" })).toBe(description);
  expect(description).toBeVisible();
  await act(async () => {
    pending[0]?.(response({ total_count: 0, check_runs: [] }));
    pending[1]?.(response({ total_count: 0, statuses: [] }));
  });
  await user.click(screen.getByRole("tab", { name: "Checks" }));
  expect(screen.getByRole("tabpanel", { name: "Checks" })).toHaveTextContent(
    "No checks",
  );
  expect(fetch).toHaveBeenCalledTimes(3);
});

it("resets lazy tabs on a new PR and aborts both old reads before ignoring late completion", async () => {
  const pending: ((response: Response) => void)[] = [];
  const signals: AbortSignal[] = [];
  const fetch = vi.fn((url: string, options: RequestInit) => {
    if (url.includes("/commits/")) {
      signals.push(options.signal as AbortSignal);
      return new Promise<Response>((resolve) => pending.push(resolve));
    }
    return Promise.resolve(
      response({
        ...pull,
        title: url.endsWith("/1") ? "First PR" : "Second PR",
      }),
    );
  });
  vi.stubGlobal("fetch", fetch);
  const view = render(<GitHubPanel target={target} close={() => {}} />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("tab", { name: "Checks" }));
  await waitFor(() => expect(pending).toHaveLength(2));
  view.rerender(
    <GitHubPanel
      target="https://github.com/sample/project/pull/2"
      close={() => {}}
    />,
  );
  await screen.findByRole("heading", { name: "Second PR" });
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  expect(screen.getByRole("tab", { name: "Discussion" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await act(async () => {
    pending[0]?.(
      response({
        total_count: 1,
        check_runs: [{ status: "completed", conclusion: "failure" }],
      }),
    );
    pending[1]?.(response({ total_count: 0, statuses: [] }));
  });
  expect(
    screen.queryByText("Some checks were not successful"),
  ).not.toBeInTheDocument();
  expect(fetch).toHaveBeenCalledTimes(4);
  await user.click(screen.getByRole("tab", { name: "Checks" }));
  await waitFor(() => expect(pending).toHaveLength(4));
  await act(async () => {
    pending[2]?.(response({ total_count: 0, check_runs: [] }));
    pending[3]?.(response({ total_count: 0, statuses: [] }));
  });
  await screen.findByText("No checks");
});

it.each([
  ["https://github.com/sample/project", "Repository"],
  ["https://github.com/sample/project/issues/2", "Issue"],
  ["https://github.com/sample/project/commit/abcdef1", "Commit"],
])(
  "preserves non-PR body/facts without tabs or check reads: %s",
  async (url) => {
    const fetch = vi.fn(async () =>
      response({
        title: "Existing object",
        body: "Unchanged body",
        comments: 2,
        head: { sha: "not-a-pr" },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    render(<GitHubPanel target={url} close={() => {}} />);
    await screen.findByText("Unchanged body");
    expect(screen.getByText("Comments")).toBeVisible();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);
