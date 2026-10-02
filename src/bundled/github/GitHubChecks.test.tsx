// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
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
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (url.includes("/pulls/")) return Promise.resolve(response(pull));
      if (url.includes("/check-runs?")) return pending;
      return Promise.resolve(
        response({ total_count: 0, state: "pending", statuses: [] }),
      );
    }),
  );
  render(<GitHubPanel target={target} close={() => {}} />);
  await screen.findByRole("heading", { name: "A small change #1" });
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
    if (url.includes("/pulls/")) return response(pull);
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
    fetch.mock.calls.filter(([url]) => url.includes("/pulls/")),
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
      if (url.includes("/pulls/")) return Promise.resolve(response(pull));
      if (url.includes("/issues/"))
        return Promise.resolve(response({ title: "An issue" }));
      signals.push(options.signal as AbortSignal);
      return url.includes("/check-runs?")
        ? pending
        : Promise.resolve(response({ total_count: 0, statuses: [] }));
    }),
  );
  const view = render(<GitHubPanel target={target} close={() => {}} />);
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
  const fetch = vi.fn(async () =>
    response({ title: "Old PR", updated_at: "not-a-date" }),
  );
  vi.stubGlobal("fetch", fetch);
  render(<GitHubPanel target={target} close={() => {}} />);
  await screen.findByRole("heading", { name: "Old PR #1" });
  expect(screen.getAllByText("Unavailable")).toHaveLength(2);
  expect(
    screen.queryByRole("button", { name: "Retry checks" }),
  ).not.toBeInTheDocument();
  expect(fetch).toHaveBeenCalledTimes(1);
});
