import { expect, it, vi } from "vitest";
import { createActivityHistory, type HistoryPage } from "./activity-history";
const page: HistoryPage = {
  records: [],
  more: false,
  before: null,
  trimmed: false,
  epoch: 1,
  revision: 1,
  channels: [],
};
function deferred<T>() {
  let resolve!: (v: T) => void;
  return {
    promise: new Promise<T>((r) => {
      resolve = r;
    }),
    resolve: (v: T) => resolve(v),
  };
}
it("keeps history lazy and revokes late plaintext across clear/dispose/access loss", async () => {
  const held = deferred<HistoryPage>();
  let access = true;
  const host = {
    read: vi.fn(() => held.promise),
    delete: vi.fn(async () => {}),
  };
  const history = createActivityHistory(
    host,
    () => access,
    () => {},
  );
  expect(host.read).not.toHaveBeenCalled();
  const read = history.queries.read("agent", "c");
  history.clear();
  held.resolve(page);
  await expect(read).rejects.toThrow(/scope changed/);
  access = false;
  await expect(history.queries.read("agent", "c")).rejects.toThrow(
    /unavailable/,
  );
  expect(host.read).toHaveBeenCalledTimes(1);
  history.dispose();
  expect(history.queries.snapshot()).toBe(2);
});
it("delete clears live views only after success, fences in-flight reads, and leaves failure retryable", async () => {
  const held = deferred<void>();
  const read = deferred<HistoryPage>();
  const clear = vi.fn();
  const host = {
    read: vi.fn(() => read.promise),
    delete: vi.fn(() => held.promise),
  };
  const history = createActivityHistory(host, () => true, clear);
  const reading = history.queries.read("agent", "c");
  const deletion = history.queries.delete();
  await expect(history.queries.read("agent", "c")).rejects.toThrow(
    /unavailable/,
  );
  read.resolve(page);
  await expect(reading).rejects.toThrow(/scope changed/);
  held.resolve(undefined);
  await deletion;
  expect(clear).toHaveBeenCalledOnce();
  expect(history.queries.snapshot()).toBe(1);
  host.delete.mockRejectedValueOnce(new Error("disk failed"));
  await expect(history.queries.delete()).rejects.toThrow("disk failed");
  expect(clear).toHaveBeenCalledOnce();
  host.read.mockResolvedValueOnce(page);
  expect(await history.queries.read("agent", "c")).toBe(page);
});
