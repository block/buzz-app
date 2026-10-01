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
