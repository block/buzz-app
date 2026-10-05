import { expect, it, vi } from "vitest";
import type { Credential } from "./browser";
import { createOAuthSession } from "./session";
import { deferred } from "../test-helpers";

const credential: Credential = {
  value: "private-token",
  account: { email: "a@example.com" },
};
it("keeps a reusable credential outside UI snapshots and clears it on sign-out", async () => {
  const acquire = vi.fn(async () => credential);
  const session = createOAuthSession(acquire);
  const listener = vi.fn();
  const unsubscribe = session.subscribe(listener);
  await session.signIn();
  expect(session.snapshot()).toEqual({
    status: "signed-in",
    account: credential.account,
  });
  expect(session.credential()).toBe(credential);
  session.signOut();
  expect(() => session.credential()).toThrow("Sign in");
  expect(session.snapshot()).toEqual({ status: "signed-out" });
  expect(listener).toHaveBeenCalled();
  listener.mockClear();
  unsubscribe();
  session.dispose();
  expect(listener).not.toHaveBeenCalled();
});
it.each(["cancel", "signOut", "dispose"] as const)(
  "%s rejects late credentials",
  async (action) => {
    const release = deferred<Credential>();
    let signal: AbortSignal | undefined;
    const session = createOAuthSession(async (current) => {
      signal = current;
      return release.promise;
    });
    const pending = session.signIn();
    expect(session.snapshot().status).toBe("pending");
    session[action]();
    expect(signal?.aborted).toBe(true);
    release.resolve(credential);
    await pending;
    expect(session.snapshot()).toEqual({ status: "signed-out" });
    expect(() => session.credential()).toThrow("Sign in");
  },
);
it("a stale failure cannot replace a new sign-in, and concurrent clicks start only one attempt", async () => {
  const old = deferred<Credential>();
  const acquire = vi
    .fn()
    .mockImplementationOnce(() => old.promise)
    .mockResolvedValueOnce(credential);
  const session = createOAuthSession(acquire);
  const pending = session.signIn();
  await session.signIn();
  expect(acquire).toHaveBeenCalledTimes(1);
  session.cancel();
  await session.signIn();
  old.reject(new Error("stale failure"));
  await pending;
  expect(session.snapshot()).toEqual({
    status: "signed-in",
    account: credential.account,
  });
  expect(session.credential()).toBe(credential);
});
it("allows retry after a failed attempt but cannot restart after disposal", async () => {
  const acquire = vi
    .fn()
    .mockRejectedValueOnce(new Error("Try again."))
    .mockResolvedValueOnce(credential);
  const session = createOAuthSession(acquire);
  await session.signIn();
  expect(session.snapshot()).toEqual({
    status: "signed-out",
    error: "Try again.",
  });
  await session.signIn();
  expect(session.credential()).toBe(credential);
  session.dispose();
  await session.signIn();
  expect(acquire).toHaveBeenCalledTimes(2);
  expect(() => session.credential()).toThrow("Sign in");
});
