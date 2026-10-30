// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { StrictMode, useState } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { BrowserControlBar as SharingControl } from "./BrowserControlBar";
import type { BrowserStatus, BrowserControl } from "./platform";

function BrowserControlBar({
  control,
  sessionId,
  status,
  eligible = false,
  agentName = "Tester",
}: {
  control: BrowserControl;
  sessionId: string;
  status?: BrowserStatus;
  eligible?: boolean;
  agentName?: string;
}) {
  const [error, setError] = useState<string>();
  return (
    <>
      <SharingControl
        recipients={[
          {
            id: "tester",
            name: agentName,
            control,
            eligible,
            unavailable: "Not running here",
          },
        ]}
        sessionId={sessionId}
        status={status}
        prepare={async () => {}}
        onError={setError}
      />
      {error ? <p role="alert">{error}</p> : null}
    </>
  );
}

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
  await user.click(screen.getByRole("button", { name: /^Share/ }));
  expect(screen.getByRole("status")).toHaveTextContent("Tester");
  expect(api.grant).toHaveBeenCalledWith("website");
  await user.click(screen.getByRole("button", { name: /^Take control/ }));
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
  await user.click(screen.getByRole("button", { name: /^Share/ }));
  expect(
    screen.getByRole("button", { name: "Take control from Tester" }),
  ).toHaveAttribute("aria-busy", "true");
  await user.click(screen.getByRole("button", { name: /^Take control/ }));
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
  await userEvent.click(screen.getByRole("button", { name: /^Share/ }));
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
  await user.click(screen.getByRole("button", { name: /^Share/ }));
  vi.mocked(api.revoke).mockRejectedValueOnce(
    new Error("Native connection lost"),
  );
  await user.click(screen.getByRole("button", { name: /^Take control/ }));
  expect(screen.getByRole("alert")).toHaveTextContent("Native connection lost");
  expect(screen.getByRole("status")).toHaveTextContent("Tester");
  await user.click(screen.getByRole("button", { name: /^Take control/ }));
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
  await userEvent.click(screen.getByRole("button", { name: /^Share/ }));
  view.rerender(
    <BrowserControlBar
      control={api}
      eligible
      agentName="Tester"
      sessionId="website"
      status={{ ...initial }}
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent("Tester");
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
  await userEvent.click(screen.getByRole("button", { name: /^Share/ }));
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
  expect(screen.getByRole("button", { name: /^Share/ })).toBeEnabled();
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
  await user.click(screen.getByRole("button", { name: /^Share/ }));
  await user.click(screen.getByRole("button", { name: /^Take control/ }));
  vi.mocked(api.revoke).mockClear();
  let finish!: (grant: { token: string; revision: number }) => void;
  vi.mocked(api.grant).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await user.click(screen.getByRole("button", { name: /^Share/ }));
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
  expect(screen.getByRole("status")).toHaveTextContent("Tester");
  expect(api.revoke).not.toHaveBeenCalled();
});

it("cancels a menu selection while the native guest is still being restored", async () => {
  const api = control();
  let restore!: () => void;
  const restored = new Promise<void>((resolve) => {
    restore = resolve;
  });
  const prepare = vi.fn(() => restored);
  const recipients = ["Alice", "Bob"].map((name) => ({
    id: name,
    name,
    control: api,
    eligible: true,
    unavailable: "",
  }));
  render(
    <SharingControl
      recipients={recipients}
      sessionId="website"
      prepare={prepare}
      onError={() => {}}
    />,
  );
  const user = userEvent.setup();
  await user.tab();
  await user.keyboard("{Enter}");
  await user.click(await screen.findByRole("menuitem", { name: "Alice" }));
  await waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
  expect(api.grant).not.toHaveBeenCalled();
  await user.click(
    screen.getByRole("button", { name: "Take control from Alice" }),
  );
  await act(async () => {
    restore();
    await restored;
  });
  expect(api.grant).not.toHaveBeenCalled();
  expect(api.revoke).toHaveBeenCalledWith("website");
  expect(screen.getByRole("button", { name: "Share browser" })).toBeVisible();
});

it("keeps keyboard focus on takeover while sharing and returns it to Share", async () => {
  const api = control();
  let finish!: (value: { token: string; revision: number }) => void;
  vi.mocked(api.grant).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const user = userEvent.setup();
  render(<BrowserControlBar control={api} sessionId="website" eligible />);
  await user.tab();
  await user.keyboard("{Enter}");
  expect(
    screen.getByRole("button", { name: "Take control from Tester" }),
  ).toHaveFocus();
  await act(async () => finish({ token: "grant", revision: 1 }));
  expect(
    screen.getByRole("button", { name: "Take control from Tester" }),
  ).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(
    screen.getByRole("button", { name: "Share with Tester" }),
  ).toHaveFocus();
});

it("returns menu selection focus to takeover", async () => {
  const api = control();
  render(
    <SharingControl
      recipients={["Alice", "Bob"].map((name) => ({
        id: name,
        name,
        control: api,
        eligible: true,
        unavailable: "",
      }))}
      sessionId="website"
      prepare={async () => {}}
      onError={() => {}}
    />,
  );
  const user = userEvent.setup();
  await user.tab();
  await user.keyboard("{Enter}");
  await user.click(await screen.findByRole("menuitem", { name: "Alice" }));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Take control from Alice" }),
    ).toHaveFocus(),
  );
});
