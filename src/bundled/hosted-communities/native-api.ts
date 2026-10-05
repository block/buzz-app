// Builderlab sign-in through the native builderlab_* commands. The session is
// the bl CLI's shared store, which every command re-reads.
import { invoke } from "@tauri-apps/api/core";
import type { Account } from "./api";

// No timeout: a Keychain prompt may legitimately hold a call open until the
// user answers it. Tauri rejects with a string; the card shows an Error's message.
async function run<T>(command: string): Promise<T> {
  try {
    return await invoke<T>(command);
  } catch (error) {
    throw typeof error === "string" ? new Error(error) : error;
  }
}

export const nativeGetAuth = () => run<Account | null>("builderlab_auth");
/** Aborting the signal cancels the pending browser login, which then rejects. */
export async function nativeLogin(signal: AbortSignal): Promise<Account> {
  signal.throwIfAborted();
  const cancel = () => {
    invoke("builderlab_cancel").catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    return await run<Account>("builderlab_login");
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}
export const nativeSignOut = () => run<void>("builderlab_sign_out");
export const nativeDeviceKey = () => invoke<string | null>("identity_restore");
