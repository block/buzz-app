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

it("marks work behind an ordered predecessor as deferred", async () => {
  const controls = new SessionControls(() => {});
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = controls.deliver(
    "shared",
    async () => {
      await gate;
    },
    true,
  );
  const following = vi.fn(async () => {});
  const second = controls.deliver("shared", following, true);
  try {
    expect(second.deferred).toBe(true);
  } finally {
    release();
    await Promise.all([first.done, second.done]);
  }
});

it("cancels ordered callbacks before releasing their predecessor", async () => {
  const controls = new SessionControls(() => {});
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = controls.deliver(
    "shared",
    async () => {
      await gate;
    },
    true,
  );
  const following = vi.fn(async () => {});
  const second = controls.deliver("shared", following, true);
  const settled = second.done.catch(() => undefined);
  controls.interrupt("shared");
  release();
  await Promise.allSettled([first.done, settled]);
  expect(following).not.toHaveBeenCalled();
  await controls.deliver("shared", following, true).done;
  expect(following).toHaveBeenCalledOnce();
});

it("keeps deferred admission alive past its handover deadline", async () => {
  const controls = new SessionControls(() => {});
  const deadline = new AbortController();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = controls.wake(
    "shared",
    new AbortController().signal,
    async () => {
      await gate;
      return { ok: true };
    },
  );
  const workingUntil = vi.fn();
  const admitted = vi.fn(
    async (delivery: { signal: AbortSignal }, deferred: boolean) => {
      expect(delivery.signal.aborted).toBe(false);
      expect(deferred).toBe(true);
    },
  );
  await controls.admit(
    "shared",
    {
      signal: deadline.signal,
      workingUntil,
    } as unknown as import("../agents/service").Delivery,
    admitted,
  );
  expect(workingUntil).toHaveBeenCalledOnce();
  deadline.abort(new Error("handover expired"));
  release();
  await first;
  await workingUntil.mock.calls[0]?.[0];
  expect(admitted).toHaveBeenCalledOnce();
});
