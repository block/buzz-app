// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { RelayData } from "../../features/relay/service";
import type { MeshStatus } from "./index";
import { ComputeSettings } from "./ComputeSettings";
const native = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: () => true }));
vi.mock("@tauri-apps/api/core", () => native);
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const profiles = new Map([["viewer", { name: "Alex" }]]);
const snapshot = {
  viewer: "viewer",
  session: {
    profiles: {
      snapshot: () => profiles,
      subscribe: () => () => {},
      ensure: async () => {},
    },
  },
};
const relay = {
  snapshot: () => snapshot,
  subscribe: () => () => {},
} as unknown as RelayData;
function fixture(memory = 32) {
  native.invoke.mockImplementation(async (command) =>
    command === "mesh_compute_catalog"
      ? {
          hosting: {
            model: memory >= 16 ? "fixture-model" : null,
            maxVramGb: memory / 4,
            memoryDisplay: `${memory} GB`,
          },
        }
      : { unavailable: null, entries: [] },
  );
  return {
    community: "https://fixture.example",
    relay,
    status: { available: true, lifecycle: { state: "stopped" } } as MeshStatus,
    busy: false,
    leaseReady: true,
    otherCommunity: false,
    error: null,
    refreshKey: 0,
    share: vi.fn(async () => {}),
    refresh: vi.fn(),
  };
}
it("requires explicit sharing confirmation and permits cancellation while startup is pending", async () => {
  const props = fixture();
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  props.share.mockImplementationOnce(() => pending);
  const user = userEvent.setup();
  render(<ComputeSettings {...props} />);
  const local = await screen.findByRole("radio", {
    name: /Share this computer/,
  });
  try {
    await waitFor(() =>
      expect(local).not.toHaveAttribute("aria-disabled", "true"),
    );
    await user.click(local);
    expect(props.share).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole("button", { name: "Share this computer" }),
    );
    expect(props.share).toHaveBeenNthCalledWith(1, false, {
      model: "fixture-model",
      maxVramGb: 8,
    });
    expect(
      screen.getByRole("status", { name: "Compute status" }),
    ).toHaveTextContent("Starting shared compute");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(props.share).toHaveBeenNthCalledWith(2, true);
    await waitFor(() =>
      expect(
        screen.getByRole("radio", { name: "Use community compute" }),
      ).toBeChecked(),
    );
  } finally {
    await act(async () => {
      finish();
      await pending;
    });
  }
  expect(
    screen.queryByRole("button", { name: "Cancel" }),
  ).not.toBeInTheDocument();
});
it("shows real download bytes, then replaces progress with the sharing state", async () => {
  const props = fixture();
  props.status = {
    available: true,
    sharing: "fixture-model",
    lifecycle: { state: "ready" },
    modelReady: false,
    download: {
      label: "private model name",
      file: null,
      downloadedBytes: 500,
      totalBytes: 1000,
      done: false,
    },
  };
  const view = render(<ComputeSettings {...props} />);
  expect(screen.getByRole("progressbar")).toHaveAttribute(
    "aria-valuenow",
    "50",
  );
  expect(screen.queryByText("private model name")).not.toBeInTheDocument();
  view.rerender(
    <ComputeSettings
      {...props}
      status={{ ...props.status, modelReady: true, download: null }}
    />,
  );
  expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  expect(
    screen.getByRole("status", { name: "Compute status" }),
  ).toHaveTextContent("You’re helping power agents");
});
it("keeps an unsupported computer on community compute and explains the empty community", async () => {
  const props = fixture(8);
  render(<ComputeSettings {...props} />);
  expect(
    await screen.findByRole("radio", { name: /16 GB required/ }),
  ).toHaveAttribute("aria-disabled", "true");
  expect(
    screen.getByRole("radio", { name: "Use community compute" }),
  ).toBeChecked();
  expect(
    await screen.findByText(/Agents can run once someone starts sharing/),
  ).toBeVisible();
  expect(props.share).not.toHaveBeenCalled();
});
it("never describes a failed download as sharing", async () => {
  const props = fixture();
  render(
    <ComputeSettings
      {...props}
      status={{
        available: true,
        sharing: "fixture-model",
        modelReady: true,
        lifecycle: { state: "failed" },
      }}
    />,
  );
  expect(
    screen.getByRole("status", { name: "Compute status" }),
  ).toHaveTextContent("Restart Buzz");
});
it.each([
  ["starting", null, "Connecting to community compute…"],
  ["starting", "fixture-model", "Starting shared compute…"],
  [
    "stopped",
    "fixture-model",
    "Sharing is enabled, but this computer isn’t running.",
  ],
] as const)(
  "reports %s with sharing intent %s without claiming community compute is running",
  async (state, sharing, expected) => {
    const props = fixture();
    render(
      <ComputeSettings
        {...props}
        status={{ available: true, sharing, lifecycle: { state } }}
      />,
    );
    expect(
      screen.getByRole("status", { name: "Compute status" }),
    ).toHaveTextContent(expected);
    if (state === "starting" && sharing)
      expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  },
);
it("shows an active native download without a sharing hint, but ignores progress retained after stopping", async () => {
  const props = fixture();
  const status: MeshStatus = {
    available: true,
    lifecycle: { state: "starting" },
    download: {
      label: "fixture",
      file: null,
      downloadedBytes: 30,
      totalBytes: 100,
      done: false,
    },
  };
  const view = render(<ComputeSettings {...props} status={status} />);
  expect(screen.getByRole("progressbar")).toHaveAttribute(
    "aria-valuenow",
    "30",
  );
  expect(
    screen.getByRole("radio", { name: /Share this computer/ }),
  ).toBeChecked();
  view.rerender(
    <ComputeSettings
      {...props}
      status={{ ...status, lifecycle: { state: "stopped" } }}
    />,
  );
  expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
});
