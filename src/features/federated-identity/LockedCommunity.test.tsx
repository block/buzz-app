// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LockedCommunity } from "./LockedCommunity";
import { admits, relayGates } from "./lock";
import { federatedFixture } from "./testing";

const viewer = "a".repeat(64);
const origin = "wss://relay.example";
const proof = [{ viewer, relay: origin, allowed: true }];

const ipc = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: ipc.invoke }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("admits a signed-in session, or an offline one only until its saved session ends", () => {
  const { service, publish } = federatedFixture();
  const now = Date.parse("2026-11-05T12:00:00Z");
  expect(admits(service.snapshot(), viewer, origin, now)).toBe(false);
  publish({
    status: "signed-in",
    cacheAdmissions: proof,
    expiresAt: "2099-01-01T00:00:00Z",
  });
  expect(admits(service.snapshot(), viewer, origin, now)).toBe(true);
  publish({ status: "restoring" });
  expect(admits(service.snapshot(), viewer, origin, now)).toBe(false);
  publish({
    status: "unavailable",
    failure: "network-unavailable",
    expiresAt: "2026-11-05T13:00:00Z",
  });
  expect(admits(service.snapshot(), viewer, origin, now)).toBe(true);
  expect(
    admits(
      service.snapshot(),
      viewer,
      origin,
      Date.parse("2026-11-05T13:00:01Z"),
    ),
  ).toBe(false);
  // Secure storage refusing is not the network: nothing to read offline.
  publish({ failure: "storage-unavailable" });
  expect(admits(service.snapshot(), viewer, origin, now)).toBe(false);
  publish({ status: "reauthentication-required", failure: null });
  expect(admits(service.snapshot(), viewer, origin, now)).toBe(false);
});

it("asks native which communities are the organization's, and ends offline reading on time", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-11-05T12:00:00Z"));
  ipc.invoke.mockResolvedValue(true);
  const { service, publish } = federatedFixture();
  const gate = relayGates(service)("wss://relay.example");
  if (!gate) throw new Error("Native gate expected");
  expect(await gate.protects()).toBe(true);
  expect(ipc.invoke).toHaveBeenCalledWith("federated_identity_protects", {
    relay: "wss://relay.example",
  });
  const listener = vi.fn();
  gate.subscribe(listener);
  publish({
    status: "unavailable",
    failure: "network-timeout",
    expiresAt: "2026-11-05T12:30:00Z",
    cacheAdmissions: proof,
  });
  expect(gate.admits(viewer)).toBe(true);
  listener.mockClear();
  vi.advanceTimersByTime(30 * 60_000);
  expect(listener).toHaveBeenCalledOnce();
  expect(gate.admits(viewer)).toBe(false);
});

it("ends offline reading on time while native is still rechecking the session", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-11-05T12:00:00Z"));
  ipc.invoke.mockResolvedValue(true);
  const { service, publish } = federatedFixture();
  publish({
    status: "unavailable",
    failure: "network-timeout",
    expiresAt: "2026-11-05T12:30:00Z",
    cacheAdmissions: proof,
  });
  const gate = relayGates(service)("wss://relay.example");
  if (!gate) throw new Error("Native gate expected");
  expect(await gate.protects()).toBe(true);
  const listener = vi.fn();
  const unsubscribe = gate.subscribe(listener);
  try {
    expect(gate.admits(viewer)).toBe(true);
    vi.advanceTimersByTime(30 * 60_000 - 1_000);
    publish({ status: "restoring", failure: null });
    listener.mockClear();
    vi.advanceTimersByTime(999);
    expect(gate.admits(viewer)).toBe(true);
    expect(listener).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(gate.admits(viewer)).toBe(false);
    expect(listener).toHaveBeenCalledOnce();

    publish({ status: "unavailable", failure: "network-timeout" });
    expect(gate.admits(viewer)).toBe(false);
    publish({ status: "signed-in", expiresAt: "2026-11-05T13:00:00Z" });
    expect(gate.admits(viewer)).toBe(true);
  } finally {
    unsubscribe();
  }
});

it("protects nothing without native identity", () => {
  const { service } = federatedFixture();
  expect(
    relayGates({ ...service, apiAvailable: false })("wss://relay.example"),
  ).toBeUndefined();
});

it("opens browser sign-in once when reauthentication is required", async () => {
  const user = userEvent.setup();
  const { service, publish } = federatedFixture();
  publish({ status: "reauthentication-required" });
  vi.mocked(service.signIn).mockImplementation(async () => {
    publish({ status: "signing-in" });
    return service.snapshot();
  });
  render(<LockedCommunity identity={service} />);
  expect(
    screen.getByRole("heading", { name: "Sign in to continue" }),
  ).toBeVisible();
  expect(service.signIn).toHaveBeenCalledOnce();
  expect(
    await screen.findByText(/Finish signing in in your browser/),
  ).toBeVisible();

  // A cancel leaves the choice to the person; nothing reopens by itself.
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(
    await screen.findByText(
      "Your sign-in has ended. Sign in again to see this community.",
    ),
  ).toBeVisible();
  expect(service.signIn).toHaveBeenCalledOnce();
  await user.click(screen.getByRole("button", { name: "Sign in" }));
  expect(service.signIn).toHaveBeenCalledTimes(2);
});

it("waits while the saved sign-in is checked, and explains an offline end", () => {
  const { service, publish } = federatedFixture();
  publish({ status: "restoring" });
  render(<LockedCommunity identity={service} />);
  expect(screen.getByText("Checking your sign-in…")).toBeVisible();
  expect(service.signIn).not.toHaveBeenCalled();
  act(() => publish({ status: "unavailable", failure: "network-unavailable" }));
  expect(
    screen.getByText(
      "Your sign-in has ended. Connect to the internet to sign in again.",
    ),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
  expect(service.signIn).not.toHaveBeenCalled();
});

it("keeps its verdict while native checks the saved session again", async () => {
  ipc.invoke.mockResolvedValue(true);
  const { service, publish } = federatedFixture();
  publish({ status: "restoring" });
  const gate = relayGates(service)("wss://relay.example");
  if (!gate) throw new Error("Native gate expected");
  expect(await gate.protects()).toBe(true);
  expect(gate.admits(viewer)).toBe(false);
  publish({
    status: "signed-in",
    cacheAdmissions: proof,
    expiresAt: "2099-01-01T00:00:00Z",
  });
  expect(gate.admits(viewer)).toBe(true);
  publish({ status: "restoring" });
  expect(gate.admits(viewer)).toBe(true);
  publish({ status: "reauthentication-required" });
  expect(gate.admits(viewer)).toBe(false);
  publish({ status: "restoring" });
  expect(gate.admits(viewer)).toBe(false);
});

it("keeps protection lookup failures locked, even signed in, and retries", async () => {
  const { service, publish } = federatedFixture();
  publish({
    status: "signed-in",
    expiresAt: "2099-01-01T00:00:00Z",
    cacheAdmissions: proof,
  });
  ipc.invoke
    .mockRejectedValueOnce(new Error("native-unavailable"))
    .mockResolvedValueOnce(false);
  const gate = relayGates(service)(origin);
  if (!gate) throw new Error("Native gate expected");
  expect(await gate.protects()).toBeUndefined();
  expect(gate.admits(viewer)).toBe(false);
  expect(await gate.protects()).toBe(false);
  expect(gate.admits(viewer)).toBe(true);
});

it("requires native proof for the exact key/community and drops it on account change or refusal", async () => {
  ipc.invoke.mockResolvedValue(true);
  const { service, publish } = federatedFixture();
  publish({ status: "signed-in", expiresAt: "2099-01-01T00:00:00Z" });
  const gate = relayGates(service)(origin);
  if (!gate) throw new Error("Native gate expected");
  await gate.protects();
  expect(gate.admits(viewer)).toBe(false);
  publish({ cacheAdmissions: proof });
  expect(gate.admits(viewer)).toBe(true);
  expect(gate.admits("b".repeat(64))).toBe(false);
  const other = relayGates(service)("wss://other.example");
  if (!other) throw new Error("Native gate expected");
  await other.protects();
  expect(other.admits(viewer)).toBe(false);
  publish({ revision: "other-account", cacheAdmissions: [] });
  expect(gate.admits(viewer)).toBe(false);
  publish({ failure: "binding-mismatch" });
  expect(gate.admits(viewer)).toBe(false);
  publish({ cacheAdmissions: [{ viewer, relay: origin, allowed: false }] });
  expect(gate.canConnect?.(viewer)).toBe(false);
});

it("gates each community on its own organization server's admission", async () => {
  ipc.invoke.mockResolvedValue(true);
  const first = federatedFixture("first");
  const second = federatedFixture("second");
  const forCommunity = vi.fn(() => second.service);
  const gate = relayGates({ ...first.service, forCommunity })(origin);
  if (!gate) throw new Error("Native gate expected");
  await gate.protects();
  first.publish({
    status: "signed-in",
    expiresAt: "2099-01-01T00:00:00Z",
    cacheAdmissions: proof,
  });
  expect(gate.admits(viewer)).toBe(false);
  const changed = vi.fn();
  const stop = gate.subscribe(changed);
  second.publish({
    status: "signed-in",
    expiresAt: "2099-01-01T00:00:00Z",
    cacheAdmissions: proof,
  });
  expect(gate.admits(viewer)).toBe(true);
  expect(changed).toHaveBeenCalledOnce();
  expect(forCommunity).toHaveBeenCalledWith(origin);
  stop();
});

it("lets account switching own sign-in after a refused signed-in session", async () => {
  const { service, publish } = federatedFixture();
  publish({
    status: "signed-in",
    failure: "binding-mismatch",
    email: "a@example.com",
  });
  render(<LockedCommunity identity={service} retry={vi.fn()} relay={origin} />);
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Switch account" }));
  expect(service.signOut).toHaveBeenCalledOnce();
  expect(service.signIn).toHaveBeenCalledOnce();
});

it("leaves explicit sign-out locked until the person chooses sign-in", async () => {
  const { service } = federatedFixture();
  render(<LockedCommunity identity={service} />);
  expect(service.signIn).not.toHaveBeenCalled();
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Sign in" }));
  expect(service.signIn).toHaveBeenCalledOnce();
});

it("allows reauthorization after policy expiry without admitting cached history", async () => {
  ipc.invoke.mockResolvedValue(true);
  const { service, publish } = federatedFixture();
  publish({
    status: "signed-in",
    expiresAt: "2099-01-01T00:00:00Z",
    cacheAdmissions: [
      { viewer, relay: origin, allowed: false, retryable: true },
    ],
  });
  const gate = relayGates(service)(origin);
  if (!gate) throw new Error("Native gate expected");
  await gate.protects();
  expect(gate.admits(viewer)).toBe(false);
  expect(gate.canConnect?.(viewer)).toBe(true);
});
