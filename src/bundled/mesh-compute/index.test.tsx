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
vi.mock("@tauri-apps/api/core", () => ({
  ...native,
  invoke: (command: string, args?: unknown) =>
    command === "mesh_compute_catalog"
      ? Promise.resolve({
          gpuName: null,
          vramDisplay: "unknown",
          recommended: null,
          entries: [],
        })
      : native.invoke(command, args),
}));
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
      restoreSharing: true,
    }),
  );
  await screen.findByText("Checking status…");
  expect(
    screen.queryByRole("button", { name: "Connect to community compute" }),
  ).not.toBeInTheDocument();
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
        : { available: true, lifecycle: { state: "ready" } },
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
  await screen.findByText("Running");
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
  expect(screen.getByRole("button", { name: "Disconnect" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
  await screen.findByText("Off");
  expect(native.invoke).toHaveBeenCalledWith("mesh_compute_release", {
    lease: "lease",
  });
  expect(native.invoke).toHaveBeenLastCalledWith(
    "mesh_compute_status",
    undefined,
  );
  expect(native.invoke).toHaveBeenCalledWith("mesh_compute_select", {
    community: "https://fixture.example",
    restoreSharing: false,
  });
  native.invoke.mockRejectedValueOnce(new Error("Status unavailable"));
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Status unavailable",
  );
  expect(screen.getByRole("status")).toHaveTextContent("Off");
  dispose();
});

it("polls transient states serially, stops at Running, and cancels on unmount", async () => {
  vi.useFakeTimers();
  let state = "starting";
  native.invoke.mockImplementation((command) =>
    Promise.resolve(
      command === "mesh_compute_select"
        ? "lease"
        : { available: true, lifecycle: { state } },
    ),
  );
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
      register: (page: { component: React.ComponentType }) => {
        Component = page.component;
      },
    },
  } as unknown as Parameters<PluginModule["apply"]>[0]);
  try {
    await act(async () => {
      render(<Component />);
    });
    expect(screen.getByRole("status")).toHaveTextContent("Starting…");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.getByRole("status")).toHaveTextContent("Starting…");
    state = "ready";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.getByRole("status")).toHaveTextContent("Running");
    const count = native.invoke.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(native.invoke).toHaveBeenCalledTimes(count);
    state = "stopping";
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    });
    expect(screen.getByRole("status")).toHaveTextContent("Stopping…");
    state = "stopped";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.getByRole("status")).toHaveTextContent("Off");
    state = "starting";
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    });
    cleanup();
    const finalCount = native.invoke.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(native.invoke).toHaveBeenCalledTimes(finalCount);
  } finally {
    cleanup();
    dispose();
    vi.useRealTimers();
  }
});

it("starts sharing the selected model through the existing community lease", async () => {
  native.invoke.mockImplementation((command) =>
    Promise.resolve(
      command === "mesh_compute_select"
        ? "share-lease"
        : { available: true, lifecycle: { state: "stopped" }, sharing: null },
    ),
  );
  const snapshot = {
    status: "ready",
    viewer: "viewer",
    scope: "https://fixture.example:viewer",
  };
  let Component!: React.ComponentType;
  const ctx = {
    relay: { snapshot: () => snapshot, subscribe: () => () => {} },
    effect: () => {},
    settingsCards: {
      register: (card: { component: React.ComponentType }) => {
        Component = card.component;
      },
    },
  } as unknown as Parameters<PluginModule["apply"]>[0];
  apply(ctx);
  render(<Component />);
  const button = await screen.findByRole("button", { name: "Share compute" });
  fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
  expect(button).toBeDisabled();
  fireEvent.change(
    screen.getByLabelText("Model reference or local GGUF path"),
    { target: { value: "/models/local.gguf" } },
  );
  fireEvent.click(button);
  await waitFor(() =>
    expect(native.invoke).toHaveBeenCalledWith("mesh_compute_share", {
      lease: "share-lease",
      model: "/models/local.gguf",
      maxVramGb: null,
    }),
  );
});

it.each([
  ["starting", "Starting sharing /models/local.gguf…", true],
  ["ready", "Preparing to share /models/local.gguf", false],
  ["failed", "Sharing failed for /models/local.gguf", false],
] as const)(
  "shows serving intent truthfully in %s",
  async (phase, label, disabled) => {
    native.invoke.mockImplementation((command) =>
      Promise.resolve(
        command === "mesh_compute_select"
          ? "share-lease"
          : {
              available: true,
              lifecycle: {
                state: phase,
                reason: phase === "failed" ? "Load failed" : undefined,
              },
              sharing: "/models/local.gguf",
            },
      ),
    );
    const snapshot = {
      status: "ready",
      viewer: "viewer",
      scope: "https://fixture.example:viewer",
    };
    let Component!: React.ComponentType;
    const ctx = {
      relay: { snapshot: () => snapshot, subscribe: () => () => {} },
      effect: () => {},
      settingsCards: {
        register: (card: { component: React.ComponentType }) => {
          Component = card.component;
        },
      },
    } as unknown as Parameters<PluginModule["apply"]>[0];
    apply(ctx);
    render(<Component />);
    expect(
      await screen.findByText((text) => text.startsWith(label)),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
    expect(
      screen.getByLabelText("Model reference or local GGUF path"),
    ).toBeDisabled();
    const stop = screen.getByRole("button", { name: "Stop sharing" });
    if (disabled) {
      expect(stop).toBeDisabled();
      fireEvent.click(stop);
      expect(
        native.invoke.mock.calls.filter(
          ([command]) => command === "mesh_compute_share",
        ),
      ).toHaveLength(0);
    } else {
      expect(stop).toBeEnabled();
      fireEvent.click(stop);
      await waitFor(() =>
        expect(native.invoke).toHaveBeenCalledWith("mesh_compute_share", {
          lease: "share-lease",
          model: null,
          maxVramGb: null,
        }),
      );
    }
    if (phase !== "ready")
      expect(
        screen.queryByText("Sharing /models/local.gguf"),
      ).not.toBeInTheDocument();
  },
);

it("refreshes cleared intent even when stopping a failed worker reports an error", async () => {
  let stopped = false;
  native.invoke.mockImplementation((command) => {
    if (command === "mesh_compute_select")
      return Promise.resolve("share-lease");
    if (command === "mesh_compute_share") {
      stopped = true;
      return Promise.reject("Shutdown not confirmed");
    }
    return Promise.resolve({
      available: true,
      lifecycle: { state: "failed", reason: "Load failed" },
      sharing: stopped ? null : "/models/local.gguf",
    });
  });
  const snapshot = {
    status: "ready",
    viewer: "viewer",
    scope: "https://fixture.example:viewer",
  };
  let Component!: React.ComponentType;
  const ctx = {
    relay: { snapshot: () => snapshot, subscribe: () => () => {} },
    effect: () => {},
    settingsCards: {
      register: (card: { component: React.ComponentType }) => {
        Component = card.component;
      },
    },
  } as unknown as Parameters<PluginModule["apply"]>[0];
  apply(ctx);
  render(<Component />);
  fireEvent.click(await screen.findByRole("button", { name: "Stop sharing" }));
  await screen.findByText("Shutdown not confirmed");
  fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
  await waitFor(() =>
    expect(
      screen.getByLabelText("Model reference or local GGUF path"),
    ).toBeEnabled(),
  );
  expect(
    screen.queryByRole("button", { name: "Stop sharing" }),
  ).not.toBeInTheDocument();
});

it("restores a disarmed model hint and sends sharing only on explicit resume", async () => {
  native.invoke.mockImplementation((command) =>
    Promise.resolve(
      command === "mesh_compute_select"
        ? "share-lease"
        : {
            available: true,
            lifecycle: { state: "stopped" },
            sharing: null,
            savedSharing: { model: "/models/local.gguf", enabled: false },
          },
    ),
  );
  const snapshot = {
    status: "ready",
    viewer: "viewer",
    scope: "https://fixture.example:viewer",
  };
  let Component!: React.ComponentType;
  const ctx = {
    relay: { snapshot: () => snapshot, subscribe: () => () => {} },
    effect: () => {},
    settingsCards: {
      register: (card: { component: React.ComponentType }) => {
        Component = card.component;
      },
    },
  } as unknown as Parameters<PluginModule["apply"]>[0];
  apply(ctx);
  render(<Component />);
  const resume = await screen.findByRole("button", { name: "Resume sharing" });
  fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
  expect(
    screen.getByLabelText("Model reference or local GGUF path"),
  ).toHaveValue("/models/local.gguf");
  expect(
    native.invoke.mock.calls.some(
      ([command]) =>
        command === "mesh_compute_start" || command === "mesh_compute_share",
    ),
  ).toBe(false);
  fireEvent.click(resume);
  await waitFor(() =>
    expect(native.invoke).toHaveBeenCalledWith("mesh_compute_share", {
      lease: "share-lease",
      model: "/models/local.gguf",
      maxVramGb: null,
    }),
  );
});

it("keeps SDK download progress live after management readiness and cancels on unmount", async () => {
  vi.useFakeTimers();
  let bytes = 1_000_000_000;
  let modelReady = false;
  native.invoke.mockImplementation((command) =>
    Promise.resolve(
      command === "mesh_compute_select"
        ? "lease"
        : {
            available: true,
            lifecycle: { state: "ready" },
            sharing: "fixture-model",
            modelReady,
            download: {
              label: "layers",
              file: "layer.gguf",
              downloadedBytes: bytes,
              totalBytes: 4_000_000_000,
              done: false,
            },
          },
    ),
  );
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
      register: (page: { component: React.ComponentType }) => {
        Component = page.component;
      },
    },
  } as unknown as Parameters<PluginModule["apply"]>[0]);
  try {
    await act(async () => {
      render(<Component />);
    });
    expect(screen.getByText(/Downloading layer.gguf/)).toHaveTextContent(
      "1.00 GB / 4.00 GB",
    );
    bytes = 2_000_000_000;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.getByText(/Downloading layer.gguf/)).toHaveTextContent(
      "2.00 GB / 4.00 GB",
    );
    modelReady = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    const count = native.invoke.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(native.invoke).toHaveBeenCalledTimes(count);
  } finally {
    cleanup();
    dispose();
    vi.useRealTimers();
  }
});
