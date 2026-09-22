// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RegisteredPanel } from "../../features/panels/service";
import {
  observeNativeSharing,
  openComputeWidget,
} from "../../features/community-compute/native";
import type { SharingSnapshot } from "../../features/community-compute/sharing";
import { PanelLaunchers } from "./PanelLaunchers";

vi.mock("../../features/community-compute/native", () => ({
  openComputeWidget: vi.fn(),
  observeNativeSharing: vi.fn(),
}));
let snapshot: SharingSnapshot;
let notify: () => void;
beforeEach(() => {
  snapshot = {
    models: [],
    status: {
      available: true,
      state: "running",
      mode: "serve",
      preferredMode: "serve",
      modelId: "model",
      generation: 1,
      community: null,
      viewer: null,
    },
  };
  vi.mocked(observeNativeSharing).mockReturnValue({
    source: {
      snapshot: () => snapshot,
      subscribe: (listener) => {
        notify = listener;
        return () => {};
      },
      start: vi.fn(),
      stop: vi.fn(),
    },
    dispose: vi.fn(),
  });
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const compute = {
  id: "compute",
  key: "buzz.community-compute/compute",
  pluginId: "buzz.community-compute",
  revision: "1",
  title: "Compute",
  launcher: { icon: "/cpu.svg", target: "" },
  matches: () => false,
  component: () => null,
} as RegisteredPanel;

it("opens the native widget instead of a panel and disappears on disable", async () => {
  vi.mocked(openComputeWidget).mockResolvedValue();
  const launch = vi.fn();
  const view = render(
    <PanelLaunchers panels={[compute]} selected={undefined} launch={launch} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open Compute widget" }));
  await vi.waitFor(() => expect(openComputeWidget).toHaveBeenCalledOnce());
  expect(launch).not.toHaveBeenCalled();
  view.rerender(
    <PanelLaunchers panels={[]} selected={undefined} launch={launch} />,
  );
  expect(
    screen.queryByRole("button", { name: "Open Compute widget" }),
  ).toBeNull();
});

it("shows a native launch failure and allows retry", async () => {
  vi.mocked(openComputeWidget).mockRejectedValueOnce(
    new Error("Window unavailable"),
  );
  render(
    <PanelLaunchers panels={[compute]} selected={undefined} launch={vi.fn()} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open Compute widget" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Window unavailable",
  );
  expect(
    screen.getByRole("button", { name: "Open Compute widget" }),
  ).toBeEnabled();
  vi.mocked(openComputeWidget).mockResolvedValue();
  fireEvent.click(screen.getByRole("button", { name: "Open Compute widget" }));
  await vi.waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});

it("only shows the launcher while this app is actively serving", () => {
  snapshot = { models: [] };
  render(
    <PanelLaunchers panels={[compute]} selected={undefined} launch={vi.fn()} />,
  );
  const button = () =>
    screen.queryByRole("button", { name: "Open Compute widget" });
  expect(button()).toBeNull();
  const status = {
    available: true,
    state: "running" as const,
    mode: "client" as const,
    preferredMode: "client" as const,
    modelId: "model",
    generation: 1,
    community: null,
    viewer: null,
  };
  act(() => {
    snapshot = { models: [], status };
    notify();
  });
  expect(button()).toBeNull();
  for (const state of [
    "off",
    "starting",
    "running",
    "stopping",
    "failed",
  ] as const) {
    act(() => {
      snapshot = {
        models: [],
        status: { ...status, preferredMode: "serve", mode: "serve", state },
      };
      notify();
    });
    if (state === "running") expect(button()).toBeInTheDocument();
    else expect(button()).toBeNull();
  }
});
