// Created fresh inside apply() on every activation. The token lives only in
// this closure's memory for the activation's lifetime: never persisted,
// never logged, gone on disable/dispose (and on browser reload).
export function createTokenStore() {
  let token: string | null = null;
  const listeners = new Set<() => void>();
  return {
    getToken: () => token,
    setToken: (next: string | null) => {
      token = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose: () => {
      token = null;
      listeners.clear();
    },
  };
}

export type TokenStore = ReturnType<typeof createTokenStore>;
