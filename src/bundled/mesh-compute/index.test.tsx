// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { PluginModule } from "../../plugins/api";
import { apply } from "./index";
const native = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: () => true }));
vi.mock("@tauri-apps/api/core", () => native);
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it("revokes a pending selection on disposal and never starts it", async () => {
  let resolve!: (value: string) => void;
  const gate = new Promise<string>((done) => {
    resolve = done;
  });
  native.invoke.mockImplementation((command) =>
    command === "mesh_compute_select"
      ? gate
      : Promise.resolve({ available: true, lifecycle: { state: "stopped" } }),
  );
  const snapshot = {
    status: "ready",
    viewer: "viewer",
    scope: "https://fixture.example:viewer",
  };
  let dispose!: () => void;
  let Component!: React.ComponentType;
  const ctx = {
    relay: { snapshot: () => snapshot, subscribe: () => () => {} },
    effect: (setup: () => () => void) => {
      dispose = setup();
    },
    settingsCards: {
      register: (card: { component: React.ComponentType }) => {
        Component = card.component;
      },
    },
  } as unknown as Parameters<PluginModule["apply"]>[0];
  apply(ctx);
  render(<Component />);
  await waitFor(() =>
    expect(native.invoke).toHaveBeenCalledWith("mesh_compute_select", {
      community: "https://fixture.example",
    }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("switch", { name: "Use shared compute" }),
    ).not.toHaveAttribute("aria-disabled", "true"),
  );
  fireEvent.click(screen.getByRole("switch", { name: "Use shared compute" }));
  expect(
    screen.getByRole("switch", { name: "Use shared compute" }),
  ).toHaveAttribute("aria-disabled", "true");
  dispose();
  await act(async () => {
    resolve("old-lease");
    await gate;
  });
  await waitFor(() =>
    expect(native.invoke).toHaveBeenCalledWith("mesh_compute_release", {
      lease: "old-lease",
    }),
  );
  expect(
    native.invoke.mock.calls.some(
      ([command]) => command === "mesh_compute_start",
    ),
  ).toBe(false);
});

it("preserves the running lease through reconnect and revokes on identity change", async () => {
  native.invoke.mockImplementation((command) =>
    Promise.resolve(
      command === "mesh_compute_select"
        ? "stable-lease"
        : { available: true, lifecycle: { state: "stopped" } },
    ),
  );
  let snapshot = {
    status: "ready",
    viewer: "viewer",
    scope: "https://fixture.example:viewer",
  };
  const listeners = new Set<() => void>();
  let dispose!: () => void;
  let Component!: React.ComponentType;
  const ctx = {
    relay: {
      snapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    effect: (setup: () => () => void) => {
      dispose = setup();
    },
    settingsCards: {
      register: (card: { component: React.ComponentType }) => {
        Component = card.component;
      },
    },
  } as unknown as Parameters<PluginModule["apply"]>[0];
  apply(ctx);
  render(<Component />);
  await waitFor(() =>
    expect(
      screen.getByRole("switch", { name: "Use shared compute" }),
    ).not.toHaveAttribute("aria-disabled", "true"),
  );
  fireEvent.click(screen.getByRole("switch", { name: "Use shared compute" }));
  await waitFor(() =>
    expect(native.invoke).toHaveBeenCalledWith("mesh_compute_start", {
      lease: "stable-lease",
    }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("switch", { name: "Use shared compute" }),
    ).not.toHaveAttribute("aria-disabled", "true"),
  );
  await act(async () => {
    snapshot = { ...snapshot, status: "connecting" };
    for (const listener of listeners) listener();
    snapshot = { ...snapshot, status: "ready" };
    for (const listener of listeners) listener();
  });
  expect(
    native.invoke.mock.calls.filter(
      ([command]) => command === "mesh_compute_select",
    ),
  ).toHaveLength(1);
  expect(
    native.invoke.mock.calls.some(
      ([command]) => command === "mesh_compute_release",
    ),
  ).toBe(false);
  await waitFor(() =>
    expect(
      screen.getByRole("switch", { name: "Use shared compute" }),
    ).not.toHaveAttribute("aria-disabled", "true"),
  );
  fireEvent.click(screen.getByRole("switch", { name: "Use shared compute" }));
  await waitFor(() =>
    expect(
      native.invoke.mock.calls.filter(
        ([command]) => command === "mesh_compute_start",
      ),
    ).toHaveLength(2),
  );
  expect(
    native.invoke.mock.calls.filter(
      ([command]) => command === "mesh_compute_start",
    )[1]?.[1],
  ).toEqual({ lease: "stable-lease" });
  await act(async () => {
    snapshot = { status: "disconnected", viewer: "", scope: "" };
    for (const listener of listeners) listener();
  });
  await waitFor(() =>
    expect(native.invoke).toHaveBeenCalledWith("mesh_compute_release", {
      lease: "stable-lease",
    }),
  );
  dispose();
});

it("renders Running without claiming connectivity, stops by lease, and separates errors", async () => {
  let state = "ready";
  native.invoke.mockImplementation((command) => {
    if (command === "mesh_compute_select") return Promise.resolve("lease");
    if (command === "mesh_compute_release") {
      state = "stopped";
      return Promise.resolve();
    }
    return Promise.resolve({ available: true, lifecycle: { state } });
  });
  const snapshot = {
    status: "ready",
    viewer: "viewer",
    scope: "https://fixture.example:viewer",
  };
  let Component!: React.ComponentType;
  let dispose!: () => void;
  apply({
    relay: { snapshot: () => snapshot, subscribe: () => () => {} },
    effect: (setup: () => () => void) => {
      dispose = setup();
    },
    settingsCards: {
      register: (card: { component: React.ComponentType }) => {
        Component = card.component;
      },
    },
  } as unknown as Parameters<PluginModule["apply"]>[0]);
  render(<Component />);
  await screen.findByText("Running");
  expect(screen.queryByText("Connected")).not.toBeInTheDocument();
  expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true");
  fireEvent.click(screen.getByRole("switch"));
  await screen.findByText("Off");
  expect(native.invoke).toHaveBeenCalledWith("mesh_compute_release", {
    lease: "lease",
  });
  native.invoke.mockRejectedValueOnce(new Error("Status unavailable"));
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Status unavailable",
  );
  expect(screen.getByRole("status")).toHaveTextContent("Off");
  dispose();
});
