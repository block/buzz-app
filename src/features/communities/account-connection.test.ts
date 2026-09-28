import { expect, it, vi } from "vitest";
import {
  createAccountConnection,
  type ExistingAccount,
} from "./account-connection";
const viewer = "a".repeat(64);
const result: ExistingAccount = {
  viewer,
  origin: "https://relay.example",
  relayAuthor: "b".repeat(64),
  archiveAuthority: null,
  lease: "11111111-1111-4111-8111-111111111111",
};
function fixture() {
  const host = {
    begin: vi.fn(async () => "ticket"),
    run: vi.fn(async () => result),
    cancel: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  return { host, owner: createAccountConnection(host) };
}
it("does no work until explicitly submitted, accepts canonical public input and does not persist", async () => {
  const { host, owner } = fixture();
  expect(owner.snapshot()).toEqual({ status: "idle" });
  expect(host.begin).not.toHaveBeenCalled();
  await owner.check(viewer, " WSS://RELAY.example:443/ ");
  expect(host.begin).toHaveBeenCalledExactlyOnceWith({
    expectedPublicKey: viewer,
    relayUrl: "https://relay.example",
  });
  expect(owner.snapshot()).toEqual({ status: "connected", account: result });
  owner.dispose();
  expect(owner.snapshot()).toEqual({ status: "idle" });
});
it.each([
  ["nsec1secret", "https://relay.example"],
  [viewer, "http://relay.example"],
  [viewer, "https://secret@relay.example"],
])("invalid inputs never call host (%#)", async (pin, url) => {
  const { host, owner } = fixture();
  await owner.check(pin, url);
  expect(owner.snapshot().status).toBe("error");
  expect(host.begin).not.toHaveBeenCalled();
  expect(host.run).not.toHaveBeenCalled();
});
it("fences a late begin after cancel and never runs its ticket", async () => {
  const { host, owner } = fixture();
  const held = deferred<string>();
  host.begin.mockReturnValue(held.promise);
  const task = owner.check(viewer, result.origin);
  owner.cancel();
  held.resolve("late");
  await task;
  expect(host.cancel).toHaveBeenCalledExactlyOnceWith("late");
  expect(host.run).not.toHaveBeenCalled();
  expect(owner.snapshot().status).toBe("idle");
});
it("fences run results after cancel/disposal and allows retry only explicitly", async () => {
  const { host, owner } = fixture();
  const held = deferred<ExistingAccount>();
  const entered = deferred<void>();
  host.run.mockImplementationOnce(() => {
    entered.resolve(undefined);
    return held.promise;
  });
  const task = owner.check(viewer, result.origin);
  await entered.promise;
  expect(owner.snapshot().status).toBe("checking");
  await owner.check(viewer, result.origin);
  expect(host.begin).toHaveBeenCalledTimes(1);
  owner.cancel();
  held.resolve(result);
  await task;
  expect(owner.snapshot().status).toBe("idle");
  await owner.check(viewer, result.origin);
  expect(owner.snapshot().status).toBe("connected");
  owner.dispose();
  await owner.check(viewer, result.origin);
  expect(host.begin).toHaveBeenCalledTimes(2);
});
it.each(["viewer", "origin", "relayAuthor", "archiveAuthority"] as const)(
  "refuses mismatched returned %s",
  async (field) => {
    const { host, owner } = fixture();
    host.run.mockResolvedValue({ ...result, [field]: "wrong" });
    await owner.check(viewer, result.origin);
    expect(owner.snapshot().status).toBe("error");
    expect(owner.snapshot().account).toBeUndefined();
  },
);
it("preserves sanitized native string failures for accurate recovery and explicit retry", async () => {
  const { host, owner } = fixture();
  host.run.mockRejectedValueOnce(
    "Could not discover this relay. Check its address and try again.",
  );
  await owner.check(viewer, result.origin);
  expect(owner.snapshot().error).toBe(
    "Could not discover this relay. Check its address and try again.",
  );
  await owner.check(viewer, result.origin);
  expect(owner.snapshot().status).toBe("connected");
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

it("retains a failed-close lease for retry and blocks reconnect until close is confirmed", async () => {
  const { host, owner } = fixture();
  await owner.check(viewer, result.origin);
  host.close.mockRejectedValueOnce(new Error("IPC refused"));
  await owner.disconnect();
  expect(owner.snapshot()).toMatchObject({
    status: "error",
    account: result,
    error: expect.stringContaining("Disconnect was not confirmed"),
  });
  await owner.check(viewer, result.origin);
  expect(host.begin).toHaveBeenCalledTimes(1);
  const held = deferred<void>();
  host.close.mockReturnValueOnce(held.promise);
  const close = owner.disconnect();
  expect(owner.snapshot().status).toBe("disconnecting");
  await owner.disconnect();
  expect(host.close).toHaveBeenCalledTimes(2);
  held.resolve(undefined);
  await close;
  expect(owner.snapshot()).toEqual({ status: "idle" });
  await owner.check(viewer, result.origin);
  expect(owner.snapshot().status).toBe("connected");
});

it("closing the dialog during confirmed disconnect does not strand the lease result", async () => {
  const { host, owner } = fixture();
  await owner.check(viewer, result.origin);
  const held = deferred<void>();
  host.close.mockReturnValueOnce(held.promise);
  const closing = owner.disconnect();
  owner.cancel();
  held.resolve(undefined);
  await closing;
  expect(owner.snapshot()).toEqual({ status: "idle" });
});
