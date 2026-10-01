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
    command === "mesh_compute_select" ? gate : Promise.resolve({}),
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
  fireEvent.click(screen.getByText("Start Mesh client"));
  expect(screen.getByText("Start Mesh client")).toBeDisabled();
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
    Promise.resolve(command === "mesh_compute_select" ? "stable-lease" : {}),
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
  fireEvent.click(screen.getByText("Start Mesh client"));
  await waitFor(() =>
    expect(native.invoke).toHaveBeenCalledWith("mesh_compute_start", {
      lease: "stable-lease",
    }),
  );
  await waitFor(() =>
    expect(screen.getByText("Start Mesh client")).toBeEnabled(),
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
  fireEvent.click(screen.getByText("Start Mesh client"));
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
    )[1][1],
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
