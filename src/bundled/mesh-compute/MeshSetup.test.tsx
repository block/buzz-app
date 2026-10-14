// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { MeshSetup } from "./MeshSetup";
import type { MeshStatus } from "./index";
import type { RelayData } from "../../features/relay/service";
const native = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: () => true }));
vi.mock("@tauri-apps/api/core", () => native);
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.resetAllMocks();
});
const profiles = new Map([["member", { name: "Alex" }]]);
const snapshot = {
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
const model = "fixture/gemma-small:Q4_K_M";
function fixture(host: boolean, community: boolean | null) {
  native.invoke.mockImplementation(async (command) =>
    command === "mesh_compute_catalog"
      ? {
          hosting: {
            memoryDisplay: host ? "16 GB" : "8 GB",
            maxVramGb: host ? 4 : 2,
            model: host ? model : null,
          },
          entries: [
            { model, name: "Gemma small", size: "2 GB", installed: false },
          ],
        }
      : {
          unavailable: community === null ? "Discovery unavailable" : null,
          entries: community
            ? [{ memberPubkey: "member", modelId: model }]
            : [],
        },
  );
  return {
    onActionChange: vi.fn(),
    community: "https://fixture.example",
    relay,
    status: { available: true, lifecycle: { state: "stopped" } } as MeshStatus,
    busy: false,
    disabled: false,
    otherCommunity: false,
    leaseReady: true,
    error: null,
    progress: null,
    refreshKey: 0,
    share: vi.fn(),
    onReadyChange: vi.fn(),
  };
}
it.each([false, true])(
  "allows community compute without a download (can host: %s)",
  async (host) => {
    const props = fixture(host, true);
    const user = userEvent.setup();
    render(<MeshSetup {...props} />);
    await waitFor(() =>
      expect(props.onActionChange.mock.lastCall?.[0].enabled).toBe(true),
    );
    expect(
      screen.getByRole("radio", {
        name: host ? /Use this computer/ : "Use community compute",
      }),
    ).toBeChecked();
    expect(screen.getAllByRole("radio")[0]).toHaveAccessibleName(
      /Use this computer/,
    );
    if (!host)
      expect(
        screen.getByRole("radio", {
          name: /Use this computer.*16 GB required/,
        }),
      ).toHaveAttribute("aria-disabled", "true");
    if (host)
      await user.click(
        screen.getByRole("radio", { name: "Use community compute" }),
      );
    await waitFor(() =>
      expect(props.onReadyChange).toHaveBeenLastCalledWith(true),
    );
    expect(
      screen.getByRole("radio", { name: "Use community compute" }),
    ).toBeChecked();
    expect(
      screen.getByText(
        /Powered by 1 person in your Buzz community. Free to use./,
      ),
    ).toBeVisible();
    if (host) {
      const local = screen.getByRole("radio", { name: /Use this computer/ });
      await user.hover(local);
      expect(await screen.findByRole("tooltip")).toHaveTextContent(
        "Share up to 25% of your computer’s memory",
      );
      await user.unhover(local);
      await waitFor(() =>
        expect(screen.queryByRole("tooltip")).not.toBeInTheDocument(),
      );
      await user.hover(
        screen.getByRole("radio", { name: "Use community compute" }),
      );
      expect(await screen.findByRole("tooltip")).toHaveTextContent(
        "Nothing to download, and no model runs on your computer.",
      );
    }
    expect(props.share).not.toHaveBeenCalled();
  },
);
it("blocks an empty community on a machine without a suitable model", async () => {
  const props = fixture(false, false);
  render(<MeshSetup {...props} />);
  await screen.findByText(/Ask someone with a more capable computer/);
  expect(
    screen.getByRole("radio", { name: /Use this computer.*16 GB required/ }),
  ).toHaveAttribute("aria-disabled", "true");
  expect(screen.getByText(/Your computer has 8 GB of memory/)).toBeVisible();
  expect(props.onReadyChange).toHaveBeenLastCalledWith(false);
  expect(props.share).not.toHaveBeenCalled();
});
it("keeps failed discovery distinct from empty and recovers on a new read", async () => {
  const props = fixture(false, null);
  const view = render(<MeshSetup {...props} />);
  await screen.findByRole("alert");
  expect(
    screen.queryByText(/Ask someone with a more capable computer/),
  ).not.toBeInTheDocument();
  expect(props.onReadyChange).toHaveBeenLastCalledWith(false);
  fixture(false, true);
  view.rerender(<MeshSetup {...props} refreshKey={1} />);
  await waitFor(() =>
    expect(props.onReadyChange).toHaveBeenLastCalledWith(true),
  );
});

it("continues immediately while the sharing download is still pending", async () => {
  const props = fixture(true, false);
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  props.share.mockReturnValue(pending);
  const view = render(<MeshSetup {...props} />);
  await waitFor(() =>
    expect(props.onActionChange.mock.lastCall?.[0].enabled).toBe(true),
  );
  act(() => props.onActionChange.mock.lastCall?.[0].run());
  try {
    expect(props.onReadyChange).toHaveBeenCalledWith(true, true);
    await waitFor(() =>
      expect(props.share).toHaveBeenCalledExactlyOnceWith(model, 4),
    );
    view.rerender(
      <MeshSetup
        {...props}
        busy
        status={{
          available: true,
          sharing: model,
          modelReady: false,
          lifecycle: { state: "starting" },
        }}
      />,
    );
    expect(props.onReadyChange).toHaveBeenLastCalledWith(true);
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Cancel" }),
    ).not.toBeInTheDocument();
  } finally {
    await act(async () => {
      finish();
      await pending;
    });
  }
});

it("remembers completed community setup without starting a local model next time", async () => {
  const props = fixture(true, true);
  const user = userEvent.setup();
  const first = render(<MeshSetup {...props} />);
  await waitFor(() =>
    expect(props.onActionChange.mock.lastCall?.[0].enabled).toBe(true),
  );
  await user.click(
    screen.getByRole("radio", { name: "Use community compute" }),
  );
  act(() => props.onActionChange.mock.lastCall?.[0].run());
  expect(props.onReadyChange).toHaveBeenCalledWith(true, true);
  first.unmount();
  props.onReadyChange.mockClear();
  const second = render(<MeshSetup {...props} />);
  await waitFor(() =>
    expect(props.onReadyChange).toHaveBeenCalledWith(true, true),
  );
  expect(props.share).not.toHaveBeenCalled();
  second.unmount();
  props.onReadyChange.mockClear();
  render(<MeshSetup {...props} community="https://other.example" />);
  await waitFor(() =>
    expect(props.onActionChange.mock.lastCall?.[0].enabled).toBe(true),
  );
  expect(props.onReadyChange).not.toHaveBeenCalledWith(true, true);
});
