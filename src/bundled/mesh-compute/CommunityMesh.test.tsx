// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RelayData } from "../../features/relay/service";
import { CommunityMesh } from "./CommunityMesh";
const native = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: () => true }));
vi.mock("@tauri-apps/api/core", () => native);
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
function relay() {
  const profiles = new Map([["a".repeat(64), { name: "Alice" }]]);
  const snapshot = {
    session: {
      profiles: {
        snapshot: () => profiles,
        subscribe: () => () => {},
        ensure: vi.fn().mockResolvedValue(undefined),
      },
    },
  };
  return {
    snapshot: () => snapshot,
    subscribe: () => () => {},
  } as unknown as RelayData;
}
it("reads automatically without starting a node, distinguishes empty, unavailable and errors, and retries", async () => {
  native.invoke.mockResolvedValueOnce({ unavailable: null, entries: [] });
  const source = relay();
  const view = render(
    <CommunityMesh community="https://fixture.example" relay={source} />,
  );
  await screen.findByText("No one is sharing compute yet.");
  expect(native.invoke).toHaveBeenCalledExactlyOnceWith(
    "mesh_compute_inventory",
    { community: "https://fixture.example" },
  );
  native.invoke.mockResolvedValueOnce({
    unavailable: "Status is stale",
    entries: [],
  });
  // The page's single Refresh reruns the read through refreshKey.
  view.rerender(
    <CommunityMesh
      community="https://fixture.example"
      relay={source}
      refreshKey={1}
    />,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("Status is stale");
  expect(
    screen.queryByText("No one is sharing compute yet."),
  ).not.toBeInTheDocument();
  native.invoke.mockRejectedValueOnce(new Error("Identity unavailable"));
  view.rerender(
    <CommunityMesh
      community="https://fixture.example"
      relay={source}
      refreshKey={2}
    />,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Identity unavailable",
  );
});
it("rejects a late previous-community response and resolves names from session profiles", async () => {
  let release!: (value: unknown) => void;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  native.invoke.mockReturnValueOnce(pending).mockResolvedValueOnce({
    unavailable: null,
    entries: [
      {
        memberPubkey: "a".repeat(64),
        modelId: "model",
        modelName: "Model",
        deviceId: "device",
        deviceName: "Studio",
        vramGb: 32,
      },
    ],
  });
  const source = relay();
  const view = render(
    <CommunityMesh community="https://old.example" relay={source} />,
  );
  view.rerender(
    <CommunityMesh community="https://new.example" relay={source} />,
  );
  expect(await screen.findByRole("listitem")).toHaveTextContent(
    "Alice — Model — Studio — 32 GB advertised VRAM",
  );
  // Thomas's community summary: contributors, shared memory, model count.
  expect(
    screen.getByText("1 person is contributing compute."),
  ).toBeInTheDocument();
  expect(screen.getByText("32 GB")).toBeInTheDocument();
  await act(async () => {
    release({ unavailable: null, entries: [] });
    await pending;
  });
  expect(
    screen.queryByText("No one is sharing compute yet."),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("listitem")).toHaveTextContent("Alice");
});
