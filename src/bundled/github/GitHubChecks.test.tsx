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
  updated_at: new Date(Date.now() - 180_000).toISOString(),
};
const response = (data: unknown) => new Response(JSON.stringify(data));

it("renders PR details while checks load, then exposes counts by pointer and keyboard", async () => {
  let finish!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  const fetch = vi.fn((url: string) => {
    if (/\/(?:comments|reviews)\?/.test(url))
      return Promise.resolve(response([]));
    if (/\/pulls\/\d+$/.test(url)) return Promise.resolve(response(pull));
    if (url.includes("/check-runs?")) return pending;
    return Promise.resolve(
      response({ total_count: 0, state: "pending", statuses: [] }),
    );
  });
  vi.stubGlobal("fetch", fetch);
  render(<GitHubPanel target={target} close={() => {}} />);
  await screen.findByRole("heading", { name: "A small change #1" });
  await userEvent.setup().click(screen.getByRole("tab", { name: "Checks" }));
  expect(screen.getByText("Loading…")).toBeVisible();
  expect(screen.getByText("3 minutes ago")).toHaveAttribute(
    "datetime",
    pull.updated_at,
  );
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
  const summary = await screen.findByText("Some not successful");
  expect(summary).toHaveAttribute("data-check-state", "failure");
  expect(summary.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  expect(fetch.mock.calls.map(([url]) => url).sort()).toEqual([
    "https://api.github.com/repos/sample/project/commits/head-sha/check-runs?per_page=100&page=1&filter=latest",
    "https://api.github.com/repos/sample/project/commits/head-sha/status?per_page=100&page=1",
    "https://api.github.com/repos/sample/project/issues/1/comments?per_page=30&page=1",
    "https://api.github.com/repos/sample/project/pulls/1",
    "https://api.github.com/repos/sample/project/pulls/1/reviews?per_page=30&page=1",
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
    if (/\/(?:comments|reviews)\?/.test(url))
      return Promise.resolve(response([]));
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
  expect(
    screen.getByRole("heading", { name: "A small change #1" }),
  ).toBeVisible();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  fail = false;
  await userEvent.setup().click(retry);
  expect(await screen.findByText("Successful")).toHaveAttribute(
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
      if (/\/(?:comments|reviews)\?/.test(url))
        return Promise.resolve(response([]));
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
  expect(screen.queryByText("Some not successful")).not.toBeInTheDocument();
  expect(screen.queryByText("Checks")).not.toBeInTheDocument();
  expect(screen.queryByText("Last updated")).not.toBeInTheDocument();
});
it("shows honest missing-data rows without inventing a head check request", async () => {
  const fetch = vi.fn(async (url: string) =>
    response(
      /\/(?:comments|reviews)\?/.test(url)
        ? []
        : { title: "Old PR", updated_at: "not-a-date" },
    ),
  );
  vi.stubGlobal("fetch", fetch);
  render(<GitHubPanel target={target} close={() => {}} />);
  await screen.findByRole("heading", { name: "Old PR #1" });
  expect(screen.getAllByText("Unavailable")).toHaveLength(1);
  await screen.findByText("Conversation loaded · oldest first");
  await userEvent.setup().click(screen.getByRole("tab", { name: "Checks" }));
  expect(screen.getAllByText("Unavailable")).toHaveLength(2);
  expect(
    screen.queryByRole("button", { name: "Retry checks" }),
  ).not.toBeInTheDocument();
  expect(fetch).toHaveBeenCalledTimes(3);
});

it("shows named rows with honest outcomes, descriptions and links without extra requests", async () => {
  const fetch = vi.fn(async (url: string) => {
    if (/\/(?:comments|reviews)\?/.test(url)) return response([]);
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
  await screen.findByText("Conversation loaded · oldest first");
  expect(fetch).toHaveBeenCalledTimes(3);
  const user = userEvent.setup();
  await user.click(screen.getByRole("tab", { name: "Checks" }));
  const list = await screen.findByRole("list", {
    name: "Checks on the PR head commit",
  });
  const rows = within(list).getAllByRole("listitem");
  expect(rows.map((row) => row.getAttribute("data-check-category"))).toEqual([
    "failing",
    "pending",
    "successful",
    "skipped",
    "neutral",
  ]);
  expect(rows[0]).toHaveTextContent("BuildFailedCompilation failed");
  expect(rows[2]).toHaveTextContent("Unit testsPassedAll tests passed");
  expect(rows[3]).toHaveTextContent("Skipped");
  expect(rows[4]).toHaveTextContent("Neutral");
  const link = within(list).getByRole("link", { name: "Unit tests" });
  expect(link).toHaveAttribute(
    "href",
    "https://github.com/sample/project/actions/runs/1",
  );
  expect(link).toHaveAttribute("target", "_blank");
  expect(link).toHaveAttribute("rel", "noreferrer");
  expect(
    within(list).queryByRole("link", { name: "Optional deployment" }),
  ).not.toBeInTheDocument();
  for (const row of rows)
    expect(row.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  await user.click(screen.getByRole("tab", { name: "Discussion" }));
  await user.click(screen.getByRole("tab", { name: "Checks" }));
  expect(
    screen.getByRole("list", { name: "Checks on the PR head commit" }),
  ).toBe(list);
  expect(fetch).toHaveBeenCalledTimes(5);
});
