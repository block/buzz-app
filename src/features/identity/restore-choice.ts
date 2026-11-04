const KEY = "buzz.restore-choice";

/**
 * The backed-up key Settings chose to switch to, kept across the sign-out
 * restart (wipe clears it) so first-run recovery preselects it.
 */
export const restoreChoice = {
  get(): string | undefined {
    try {
      return localStorage.getItem(KEY) ?? undefined;
    } catch {
      return undefined;
    }
  },
  set(pubkey: string | undefined) {
    try {
      if (pubkey) localStorage.setItem(KEY, pubkey);
      else localStorage.removeItem(KEY);
    } catch {
      // Without storage the list just preselects the linked key.
    }
  },
};
