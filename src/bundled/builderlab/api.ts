import { invoke } from "@tauri-apps/api/core";

export type Account = {
  email: string | null;
  name: string | null;
  expiresAt: string | null;
  profile: string;
  serviceUrl: string;
};

// Keychain prompts deliberately have no renderer timeout. Only account metadata
// crosses IPC; codes, credentials, exchange and revocation stay in the companion.
async function run<T>(command: string): Promise<T> {
  try {
    return await invoke<T>(`plugin:builderlab|${command}`);
  } catch (error) {
    throw typeof error === "string" ? new Error(error) : error;
  }
}
export const getAuth = () => run<Account | null>("auth");
export const signOut = () => run<void>("sign_out");
export async function login(signal: AbortSignal): Promise<Account> {
  signal.throwIfAborted();
  const cancel = () => {
    void run<void>("cancel").catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    return await run<Account>("login");
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}
