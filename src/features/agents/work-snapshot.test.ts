import { expect, it, vi } from "vitest";
import { workSnapshot, type ActivitySnapshot } from "./work-snapshot";
it("retries full bounded state on the next pulse and stops on retirement", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const send = vi
    .fn<(s: ActivitySnapshot) => Promise<void>>()
    .mockImplementationOnce(() => gate)
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue(undefined);
  const work = workSnapshot(send, "channel");
  work.step("Read");
  work.pulse(null);
  work.pulse(null);
  expect(send).toHaveBeenCalledTimes(1);
  release();
  await gate;
  await Promise.resolve();
  await Promise.resolve();
  for (let i = 0; i < 40; i++) work.step(`Step ${i}`);
  work.pulse("root");
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  await Promise.resolve();
  await Promise.resolve();
  work.pulse("root");
  expect(send).toHaveBeenCalledTimes(3);
  expect(send.mock.calls[2]?.[0]).toMatchObject({
    threadRootId: "root",
    seq: 3,
  });
  expect(send.mock.calls[2]?.[0].steps).toHaveLength(32);
  expect(send.mock.calls[2]?.[0].steps.at(-1)).toBe("Step 39");
  work.stop();
  work.pulse(null);
  expect(send).toHaveBeenCalledTimes(3);
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(4));
  expect(send.mock.calls[3]?.[0]).toMatchObject({ active: false, seq: 4 });
  work.pulse(null);
  work.stop();
  expect(send).toHaveBeenCalledTimes(4);
});

it("retires after an unresolved publication settles", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const send = vi
    .fn<(s: ActivitySnapshot) => Promise<void>>()
    .mockImplementationOnce(() => pending)
    .mockResolvedValue(undefined);
  const work = workSnapshot(send, "channel");
  work.pulse("thread");
  work.stop();
  expect(send).toHaveBeenCalledTimes(1);
  release();
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  expect(send.mock.calls[1]?.[0]).toMatchObject({
    active: false,
    threadRootId: "thread",
  });
  work.pulse("thread");
  expect(send).toHaveBeenCalledTimes(2);
});
