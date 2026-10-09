export type OAuthAccount = Readonly<{ subject: string; email: string }>;

export type LoginSnapshot = Readonly<{
  status: "signed-out" | "pending" | "signed-in";
  account?: OAuthAccount;
  error?: string;
}>;

/** One plugin lifetime owns the reusable credential; UI snapshots never contain it. */
export function createOAuthSession<
  Credential extends { account: OAuthAccount },
>(provider: string, acquire: (signal: AbortSignal) => Promise<Credential>) {
  let credential: Credential | undefined;
  let attempt: AbortController | undefined;
  let disposed = false;
  let state: LoginSnapshot = { status: "signed-out" };
  const listeners = new Set<() => void>();
  const publish = (next: LoginSnapshot) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const reset = () => {
    attempt?.abort();
    attempt = undefined;
    credential = undefined;
    publish({ status: "signed-out" });
  };
  return {
    snapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    credential() {
      if (!credential) throw new Error(`Sign in to ${provider} first.`);
      return credential;
    },
    cancel: reset,
    signOut: reset,
    async signIn() {
      if (disposed || attempt) return;
      credential = undefined;
      const current = new AbortController();
      attempt = current;
      publish({ status: "pending" });
      try {
        const result = await acquire(current.signal);
        current.signal.throwIfAborted();
        if (attempt !== current || disposed) return;
        credential = result;
        publish({ status: "signed-in", account: result.account });
      } catch (error) {
        if (attempt !== current || disposed) return;
        publish({
          status: "signed-out",
          error:
            error instanceof Error
              ? error.message
              : "Sign-in failed. Try again.",
        });
      } finally {
        if (attempt === current) attempt = undefined;
      }
    },
    dispose() {
      disposed = true;
      reset();
      listeners.clear();
    },
  };
}
export type OAuthSession<
  Credential extends { account: OAuthAccount } = { account: OAuthAccount },
> = ReturnType<typeof createOAuthSession<Credential>>;
