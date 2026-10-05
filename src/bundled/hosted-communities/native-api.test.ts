import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { call, deviceKey, getAuth, login, signOut, type Account } from "./api";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => true,
}));
// The wire shape src-tauri/src/builderlab.rs serialises for both auth and login.
const account: Account = {
  expiresAt: "2030-01-01T00:00:00Z",
  email: "a@example.com",
  name: null,
  capabilities: { can_delete_buzz_communities: false },
  shared: true,
};
const DENIED =
  "Keychain access was denied. Allow Buzz to use the Builderlab session in Keychain and retry.";

beforeEach(() => {
  vi.stubGlobal("navigator", { platform: "MacIntel" });
  vi.stubEnv("VITE_BUZZ_LIVE", "0");
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("No development broker in this build");
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

it("reads the shared session and signs out through the native commands", async () => {
  vi.mocked(invoke).mockResolvedValueOnce(account);
  await expect(getAuth()).resolves.toEqual(account);
  expect(invoke).toHaveBeenCalledExactlyOnceWith("builderlab_auth");
  vi.mocked(invoke).mockResolvedValueOnce(undefined);
  await expect(signOut()).resolves.toBeUndefined();
  expect(invoke).toHaveBeenLastCalledWith("builderlab_sign_out");
  expect(fetch).not.toHaveBeenCalled();
});

it("cancels a pending native login when its signal aborts", async () => {
  let fail!: (reason: unknown) => void;
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "builderlab_login")
      return new Promise((_, reject) => {
        fail = reject;
      });
    if (command === "builderlab_cancel") {
      fail("Builderlab authentication canceled");
      return Promise.resolve();
    }
    throw new Error(`Unexpected command ${command}`);
  });
  const controller = new AbortController();
  const pending = login(controller.signal);
  await vi.waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("builderlab_login"),
  );
  controller.abort();
  expect(invoke).toHaveBeenCalledWith("builderlab_cancel");
  await expect(pending).rejects.toThrow("Builderlab authentication canceled");
  // A settled login no longer listens to its signal.
  vi.mocked(invoke).mockReset().mockResolvedValue(account);
  const settled = new AbortController();
  await expect(login(settled.signal)).resolves.toEqual(account);
  settled.abort();
  expect(invoke).toHaveBeenCalledExactlyOnceWith("builderlab_login");
});

it("passes the Keychain denial through as an Error with the exact text", async () => {
  vi.mocked(invoke).mockRejectedValueOnce(DENIED);
  const reason = await getAuth().catch((error: unknown) => error);
  expect(reason).toBeInstanceOf(Error);
  expect((reason as Error).message).toBe(DENIED);
});

it("reads this device's key natively and treats failures as unreadable", async () => {
  const key = "ab".repeat(32);
  vi.mocked(invoke).mockResolvedValueOnce(key.toUpperCase());
  await expect(deviceKey()).resolves.toBe(key);
  expect(invoke).toHaveBeenCalledExactlyOnceWith("identity_restore");
  vi.mocked(invoke).mockResolvedValueOnce(null);
  await expect(deviceKey()).resolves.toBeNull();
  vi.mocked(invoke).mockRejectedValueOnce("Identity unavailable");
  await expect(deviceKey()).resolves.toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});

it("refuses community actions natively until they have a native owner", async () => {
  await expect(call("identity")).rejects.toThrow(
    "Hosted community actions are not available natively yet",
  );
  expect(invoke).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it("keeps the development broker path even inside Tauri", async () => {
  vi.stubEnv("VITE_BUZZ_LIVE", "1");
  vi.mocked(fetch).mockResolvedValue(Response.json({ auth: null }));
  await expect(getAuth()).resolves.toBeNull();
  expect(fetch).toHaveBeenCalledWith("/api/builderlab/auth");
  expect(invoke).not.toHaveBeenCalled();
});
