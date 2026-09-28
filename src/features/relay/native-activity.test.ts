import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { nativeActivityLease } from "./native-activity";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));
afterEach(() => vi.mocked(invoke).mockReset());
const viewer = "a".repeat(64),
  relay = "b".repeat(64);
const account = (origin: string, lease: string) => ({
  origin,
  lease,
  viewer,
  relayAuthor: relay,
});
it("independent community leases close only their own generation and fence history results", async () => {
  const first = new AbortController(),
    second = new AbortController();
  const a = account(
    "https://a.example",
    "11111111-1111-4111-8111-111111111111",
  );
  const b = account(
    "https://b.example",
    "22222222-2222-4222-8222-222222222222",
  );
  let finish!: (value: unknown) => void;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "account_activity_open")
      return (args as { community?: string } | undefined)?.community ===
        a.origin
        ? a
        : b;
    if (command === "account_history_read")
      return new Promise((resolve) => {
        finish = resolve;
      });
    return undefined;
  });
  const leaseA = await nativeActivityLease(a.origin, viewer, first.signal);
  const leaseB = await nativeActivityLease(b.origin, viewer, second.signal);
  const read = leaseA.history.read(
    "c".repeat(64),
    "channel",
    undefined,
    new AbortController().signal,
  );
  first.abort();
  finish({ records: [] });
  await expect(read).rejects.toThrow();
  expect(invoke).toHaveBeenCalledWith("account_connection_close", {
    lease: a.lease,
  });
  expect(
    vi
      .mocked(invoke)
      .mock.calls.filter(([name]) => name === "account_connection_close"),
  ).toHaveLength(1);
  await leaseB.history.delete(new AbortController().signal);
  expect(invoke).toHaveBeenCalledWith("account_history_delete", {
    lease: b.lease,
  });
  second.abort();
  await leaseB.close();
  expect(invoke).toHaveBeenCalledWith("account_connection_close", {
    lease: b.lease,
  });
});
it("cancelled open closes the late native lease without exposing history", async () => {
  let finish!: (value: unknown) => void;
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "account_activity_open"
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : undefined,
  );
  const abort = new AbortController();
  const pending = nativeActivityLease(
    "https://a.example",
    viewer,
    abort.signal,
  );
  abort.abort();
  const a = account(
    "https://a.example",
    "11111111-1111-4111-8111-111111111111",
  );
  finish(a);
  await expect(pending).rejects.toThrow();
  expect(invoke).toHaveBeenCalledWith("account_connection_close", {
    lease: a.lease,
  });
});

it("failed cleanup is retained and must succeed before a replacement opens", async () => {
  const a = account(
    "https://cleanup.example",
    "33333333-3333-4333-8333-333333333333",
  );
  let failClose = true;
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "account_activity_open") return a;
    if (command === "account_connection_close" && failClose)
      throw new Error("IPC failed");
  });
  const controller = new AbortController();
  const first = await nativeActivityLease(a.origin, viewer, controller.signal);
  await expect(first.close()).rejects.toThrow("could not close");
  await expect(
    nativeActivityLease(a.origin, viewer, new AbortController().signal),
  ).rejects.toThrow("could not close");
  expect(
    vi
      .mocked(invoke)
      .mock.calls.filter(([name]) => name === "account_activity_open"),
  ).toHaveLength(1);
  failClose = false;
  const next = await nativeActivityLease(
    a.origin,
    viewer,
    new AbortController().signal,
  );
  expect(
    vi
      .mocked(invoke)
      .mock.calls.filter(([name]) => name === "account_activity_open"),
  ).toHaveLength(2);
  await next.close();
});
