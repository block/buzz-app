// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { PluginModule } from "../../plugins/api";
import { apply, type MeshStatus } from "./index";
const native = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: () => true }));
vi.mock("@tauri-apps/api/core", () => native);
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
});

it("observes startup during a pending selection and keeps observing idle and failed reads", async () => {
  vi.useFakeTimers();
  let release!: (id: string) => void;
  const selection = new Promise<string>((resolve) => {
    release = resolve;
  });
  let status: MeshStatus = {
    available: true,
    lifecycle: { state: "starting" },
    sharing: "fixture-model",
  };
  let failRead = false;
  native.invoke.mockImplementation(async (command) => {
    if (command === "mesh_compute_select") return selection;
    if (command === "mesh_compute_status") {
      if (failRead) throw new Error("Status temporarily unavailable");
      return status;
    }
    if (command === "mesh_compute_catalog")
      return {
        hosting: {
          memoryDisplay: "32 GB",
          model: "fixture-model",
          maxVramGb: 8,
        },
      };
    if (command === "mesh_compute_inventory")
      return { unavailable: null, entries: [] };
    return undefined;
  });
  const profiles = new Map();
  const snapshot = {
    status: "ready",
    viewer: "viewer",
    scope: "https://fixture.example:viewer",
    session: {
      profiles: {
        snapshot: () => profiles,
        subscribe: () => () => {},
        ensure: async () => {},
      },
    },
  };
  let Settings!: ComponentType;
  const dispose: (() => void)[] = [];
  apply({
    relay: { snapshot: () => snapshot, subscribe: () => () => {} },
    communityReader: {
      snapshot: () => ({ viewer: "viewer" }),
      subscribe: () => () => {},
    },
    settingsCards: {
      register: (card: { component: ComponentType }) => {
        Settings = card.component;
      },
    },
    effect: (setup: () => (() => void) | undefined) => {
      const close = setup();
      if (close) dispose.push(close);
    },
  } as unknown as Parameters<PluginModule["apply"]>[0]);
  try {
    await act(async () => {
      render(<Settings />);
    });
    expect(
      screen.getByRole("status", { name: "Compute status" }),
    ).toHaveTextContent("Starting shared compute");
    expect(native.invoke).toHaveBeenCalledWith(
      "mesh_compute_select",
      expect.anything(),
    );
    status = { available: true, lifecycle: { state: "stopped" } };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(
      screen.getByRole("status", { name: "Compute status" }),
    ).not.toHaveTextContent("Starting shared compute");
    failRead = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Status temporarily unavailable",
    );
    failRead = false;
    status = {
      available: true,
      lifecycle: { state: "starting" },
      sharing: "fixture-model",
      download: {
        label: "fixture",
        file: null,
        downloadedBytes: 40,
        totalBytes: 100,
        done: false,
      },
    };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "40",
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  } finally {
    await act(async () => {
      release("fixture-lease");
      await selection;
    });
    cleanup();
    for (const close of dispose) close();
  }
});
