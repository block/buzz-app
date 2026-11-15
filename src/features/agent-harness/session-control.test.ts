import { expect, it, vi } from "vitest";
import { SessionControls } from "./session-control";

it("preserves ordered handoffs after a failed admission", async () => {
  const controls = new SessionControls(() => {});
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = controls.deliver(
    "shared",
    async () => {
      await gate;
      throw new Error("admission failed");
    },
    true,
  );
  const failed = expect(first.done).rejects.toThrow("admission failed");
  const following = vi.fn(async () => {});
  const second = controls.deliver("shared", following, true);
  expect(controls.active("shared")).toBe(true);
  expect(following).not.toHaveBeenCalled();
  release();
  await failed;
  await second.done;
  expect(following).toHaveBeenCalledOnce();
  expect(controls.active("shared")).toBe(false);
});

it("keeps ordinary steering handoffs concurrent", async () => {
  const controls = new SessionControls(() => {});
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = controls.deliver("thread", async () => {
    await gate;
  });
  const following = vi.fn(async () => {});
  const second = controls.deliver("thread", following);
  try {
    await second.done;
    expect(following).toHaveBeenCalledOnce();
    expect(controls.active("thread")).toBe(true);
  } finally {
    release();
    await first.done;
  }
  expect(controls.active("thread")).toBe(false);
});
