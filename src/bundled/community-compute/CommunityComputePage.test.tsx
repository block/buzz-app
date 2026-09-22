// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import type {
  ComputeStatus,
  ComputeStatusSource,
} from "../../features/community-compute/status";
import type { RelayData, RelaySnapshot } from "../../features/relay/service";
import { createRelaySession } from "../../features/relay/session";
import { CommunityComputePage } from "./CommunityComputePage";
import "@testing-library/jest-dom/vitest";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function source() {
  let state: ComputeStatus = { state: "loading" };
  const listeners = new Set<() => void>();
  const service: ComputeStatusSource = {
    snapshot: () => state,
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    retry: vi.fn(),
  };
  return {
    service,
    listeners,
    update(next: ComputeStatus) {
      state = next;
      for (const fn of listeners) fn();
    },
  };
}
it("renders live status errors and directs retry to the current community", () => {
  const first = source();
  const second = source();
  const session = createRelaySession(null);
  let snapshot: RelaySnapshot = {
    status: "ready",
    generation: 1,
    scope: "one",
    session: session.session,
    compute: first.service,
  };
  const listeners = new Set<() => void>();
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    retry: vi.fn(),
    disconnect: vi.fn(),
    clearCache: vi.fn(),
  };
  const view = render(
    <StrictMode>
      <CommunityComputePage relay={relay} />
    </StrictMode>,
  );
  expect(screen.getByText("Checking community compute…")).toBeInTheDocument();
  act(() =>
    first.update({ state: "error", error: "First community unavailable" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
  expect(first.service.retry).toHaveBeenCalledOnce();
  act(() => {
    snapshot = { ...snapshot, scope: "two", compute: second.service };
    for (const fn of listeners) fn();
  });
  expect(first.listeners.size).toBe(0);
  act(() =>
    first.update({ state: "error", error: "Late first-community result" }),
  );
  expect(
    screen.queryByText("Late first-community result"),
  ).not.toBeInTheDocument();
  act(() =>
    second.update({
      state: "ready",
      snapshot: {
        memberCount: 1,
        sharingDeviceCount: 0,
        sharedCapacityGb: null,
        models: [],
        devices: [],
        includesSelf: false,
        reason: null,
      },
    }),
  );
  expect(
    screen.getByText("No one is sharing compute yet."),
  ).toBeInTheDocument();
  expect(screen.getByRole("switch")).toHaveAttribute("aria-disabled", "true");
  view.unmount();
  expect(second.listeners.size).toBe(0);
  session.dispose();
});

it("keeps global Stop available when the selected community is disconnected", async () => {
  const native = await import("../../features/community-compute/native");
  const { createSharingSource } = await import(
    "../../features/community-compute/sharing"
  );
  const running = {
    available: true,
    generation: 7,
    state: "running",
    mode: "serve",
    modelId: "model",
    community: "https://sharing.example",
    viewer: "viewer",
    detail: "Sharing with verified community members",
  };
  const invoke = vi.fn(async (command: string) =>
    command === "community_compute_models"
      ? { entries: [] }
      : command === "community_compute_stop"
        ? { ...running, state: "off", mode: null }
        : running,
  );
  vi.spyOn(native, "observeNativeSharing").mockImplementation(() =>
    createSharingSource(invoke as never),
  );
  const session = createRelaySession(null);
  const snapshot: RelaySnapshot = {
    status: "disconnected",
    generation: 1,
    session: session.session,
  };
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry: vi.fn(),
    disconnect: vi.fn(),
    clearCache: vi.fn(),
  };
  const view = render(
    <StrictMode>
      <CommunityComputePage relay={relay} />
    </StrictMode>,
  );
  await waitFor(() =>
    expect(
      screen.getByText("This machine is sharing compute with sharing.example."),
    ).toBeInTheDocument(),
  );
  fireEvent.click(screen.getByRole("switch"));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("community_compute_stop", {
      generation: 7,
    }),
  );
  await waitFor(() =>
    expect(screen.getByRole("switch")).toHaveAttribute("aria-disabled", "true"),
  );
  expect(
    invoke.mock.calls.some(
      ([command]) => command === "community_compute_start",
    ),
  ).toBe(false);
  view.unmount();
  session.dispose();
});
