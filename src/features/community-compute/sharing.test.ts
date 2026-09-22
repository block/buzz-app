import { afterEach, expect, it, vi } from "vitest";
import { createSharingSource, type NativeSharingStatus } from "./sharing";
const off: NativeSharingStatus = {
  available: true,
  generation: 1,
  state: "off",
  mode: null,
  modelId: null,
  community: null,
  viewer: null,
};
const running: NativeSharingStatus = {
  ...off,
  state: "running",
  mode: "serve",
  modelId: "model",
  community: "https://one.example",
  viewer: "viewer",
};
function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
afterEach(() => vi.useRealTimers());
it("binds start to the connected community/account and stop to the observed generation", async () => {
  const invoke = vi.fn(async (command: string) =>
    command === "community_compute_models"
      ? { entries: [] }
      : command === "community_compute_start"
        ? running
        : off,
  );
  const host = createSharingSource(
    invoke as never,
    "https://one.example",
    "viewer",
  );
  await host.source.start({ modelId: "model", maxVramGb: 16 });
  expect(invoke).toHaveBeenCalledWith("community_compute_start", {
    request: {
      modelId: "model",
      maxVramGb: 16,
      community: "https://one.example",
      viewer: "viewer",
    },
  });
  await host.source.stop(1);
  expect(invoke).toHaveBeenCalledWith("community_compute_stop", {
    generation: 1,
  });
  host.dispose();
  await expect(host.source.start({ modelId: "model" })).rejects.toThrow(
    /changed/,
  );
});
it("does not stop native sharing on page unmount or session disposal", async () => {
  const invoke = vi.fn(async (command: string) =>
    command === "community_compute_models" ? { entries: [] } : running,
  );
  const host = createSharingSource(
    invoke as never,
    "https://one.example",
    "viewer",
  );
  const release = host.source.subscribe(() => {});
  await vi.waitFor(() =>
    expect(host.source.snapshot().status?.state).toBe("running"),
  );
  release();
  host.dispose();
  expect(
    invoke.mock.calls.some(([command]) => command === "community_compute_stop"),
  ).toBe(false);
});
it("a late status read cannot overwrite completed Stop", async () => {
  const pending = gate<NativeSharingStatus>();
  const invoke = vi.fn((command: string) =>
    command === "community_compute_status"
      ? pending.promise
      : Promise.resolve(off),
  );
  const host = createSharingSource(
    invoke as never,
    "https://one.example",
    "viewer",
  );
  const release = host.source.subscribe(() => {});
  expect(invoke).toHaveBeenCalledWith("community_compute_status");
  await host.source.stop(1);
  pending.resolve(running);
  await pending.promise;
  expect(host.source.snapshot().status?.state).toBe("off");
  release();
  host.dispose();
});
