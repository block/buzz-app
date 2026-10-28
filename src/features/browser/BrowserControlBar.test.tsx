// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { StrictMode } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { BrowserControlBar } from "./BrowserControlBar";
import type { BrowserControl } from "./platform";

afterEach(cleanup);
function control(): BrowserControl {
  return {
    available: vi.fn(async () => true),
    grant: vi.fn(async () => ({ token: "private-token", revision: 1 })),
    revoke: vi.fn(async () => {}),
    execute: vi.fn(),
  };
}

it("requires explicit opt-in, names the recipient, and revokes on takeover and unmount", async () => {
  const api = control();
  const user = userEvent.setup();
  const view = render(
    <StrictMode>
      <BrowserControlBar
        control={api}
        sessionId="website"
        eligible
        agentName="Tester"
      />
    </StrictMode>,
  );
  expect(api.grant).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Allow agent control" }));
  expect(screen.getByRole("status")).toHaveTextContent(
    "Browser shared with Tester",
  );
  expect(api.grant).toHaveBeenCalledWith("website");
  await user.click(screen.getByRole("button", { name: "Take control" }));
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(api.revoke).toHaveBeenCalledWith("website");
  vi.mocked(api.revoke).mockClear();
  view.unmount();
  expect(api.revoke).toHaveBeenCalledWith("website");
});

it("keeps takeover available during a pending grant and keeps a late grant hidden", async () => {
  const api = control();
  let finish!: (value: { token: string; revision: number }) => void;
  vi.mocked(api.grant).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const user = userEvent.setup();
  render(
    <BrowserControlBar
      control={api}
      sessionId="website"
      eligible
      agentName="Tester"
    />,
  );
  await user.click(screen.getByRole("button", { name: "Allow agent control" }));
  expect(
    screen.getByRole("button", { name: "Allow agent control" }),
  ).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Take control" }));
  expect(api.revoke).toHaveBeenCalledTimes(1);
  await act(async () => finish({ token: "late-token", revision: 1 }));
  await waitFor(() => expect(api.revoke).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

it("revokes a grant that finishes after the panel closes", async () => {
  const api = control();
  let finish!: (value: { token: string; revision: number }) => void;
  vi.mocked(api.grant).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const view = render(
    <BrowserControlBar
      control={api}
      sessionId="website"
      eligible
      agentName="Tester"
    />,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Allow agent control" }),
  );
  view.unmount();
  expect(api.revoke).toHaveBeenCalledTimes(1);
  await act(async () => finish({ token: "late-token", revision: 1 }));
  expect(api.revoke).toHaveBeenCalledTimes(1);
});

it("shows a revoke failure and keeps sharing visible for another takeover attempt", async () => {
  const api = control();
  const user = userEvent.setup();
  render(
    <BrowserControlBar
      control={api}
      sessionId="website"
      eligible
      agentName="Tester"
    />,
  );
  await user.click(screen.getByRole("button", { name: "Allow agent control" }));
  vi.mocked(api.revoke).mockRejectedValueOnce(
    new Error("Native connection lost"),
  );
  await user.click(screen.getByRole("button", { name: "Take control" }));
  expect(screen.getByRole("alert")).toHaveTextContent("Native connection lost");
  expect(screen.getByRole("status")).toHaveTextContent(
    "Browser shared with Tester",
  );
  await user.click(screen.getByRole("button", { name: "Take control" }));
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

it("ignores a stale pre-grant poll and clears sharing after native revocation", async () => {
  const api = control();
  const initial = {
    url: "https://example.org",
    title: "Example",
    loading: false,
    error: null,
    control_granted: false,
    control_revision: 0,
  };
  const view = render(
    <BrowserControlBar
      control={api}
      sessionId="website"
      eligible
      agentName="Tester"
      status={initial}
    />,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Allow agent control" }),
  );
  view.rerender(
    <BrowserControlBar
      control={api}
      eligible
      agentName="Tester"
      sessionId="website"
      status={{ ...initial }}
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "Browser shared with Tester",
  );
  view.rerender(
    <BrowserControlBar
      control={api}
      eligible
      agentName="Tester"
      sessionId="website"
      status={{ ...initial, control_revision: 2 }}
    />,
  );
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

it("recovers eligibility after takeover invalidates a pending grant", async () => {
  const api = control();
  let finish!: (value: { token: string; revision: number }) => void;
  vi.mocked(api.grant).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const view = render(
    <BrowserControlBar
      control={api}
      sessionId="website"
      eligible
      agentName="Tester"
    />,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Allow agent control" }),
  );
  view.rerender(
    <BrowserControlBar
      control={api}
      sessionId="website"
      eligible={false}
      agentName="Tester"
    />,
  );
  view.rerender(
    <BrowserControlBar
      control={api}
      sessionId="website"
      eligible
      agentName="Tester"
    />,
  );
  expect(
    screen.getByRole("button", { name: "Allow agent control" }),
  ).toBeEnabled();
  await act(async () => finish({ token: "late", revision: 1 }));
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

it("does not let a pre-grant revocation poll cancel a replacement grant", async () => {
  const api = control();
  const user = userEvent.setup();
  const status = {
    url: "https://example.com",
    title: "Example",
    loading: false,
    error: null,
    control_revision: 0,
    control_granted: false,
  };
  const view = render(
    <BrowserControlBar
      control={api}
      sessionId="website"
      eligible
      agentName="Tester"
      status={status}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Allow agent control" }));
  let finish!: (grant: { token: string; revision: number }) => void;
  vi.mocked(api.grant).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await user.click(screen.getByRole("button", { name: "Allow agent control" }));
  view.rerender(
    <BrowserControlBar
      control={api}
      sessionId="website"
      eligible
      agentName="Tester"
      status={{ ...status, control_revision: 2 }}
    />,
  );
  expect(api.revoke).not.toHaveBeenCalled();
  await act(async () => finish({ token: "replacement", revision: 3 }));
  expect(screen.getByRole("status")).toHaveTextContent(
    "Browser shared with Tester",
  );
  expect(api.revoke).not.toHaveBeenCalled();
});
