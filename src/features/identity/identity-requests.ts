// A website asks the owner to authorize its own key, the same proof Settings →
// Security → Authorize external identity signs, and gets it back in its
// callback's fragment instead of by copy and paste:
//
//   buzz://authorize-identity?version=1&pubkey=<64 hex>&callback=<https url>&state=<state>
//
// Nothing is signed on arrival. The owner sees the callback's origin and the
// key's npub and chooses; either answer opens the callback in the browser.

export type IdentityRequest = Readonly<{
  pubkey: string;
  callback: string;
  /** The callback's origin: the site the owner is shown and answers to. */
  origin: string;
  state: string;
}>;

const keys = ["version", "pubkey", "callback", "state"];
// 32 random bytes as unpadded base64url, as the external app protocol's state.
const opaque = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

export function parseIdentityRequest(raw: string): IdentityRequest | null {
  try {
    if (raw.length > 4096 || !/^buzz:\/\/authorize-identity\/?\?/.test(raw))
      return null;
    const url = new URL(raw);
    if (
      url.hostname !== "authorize-identity" ||
      !["", "/"].includes(url.pathname) ||
      url.username ||
      url.password ||
      url.port ||
      url.hash ||
      [...url.searchParams.keys()].some((key) => !keys.includes(key)) ||
      keys.some((key) => url.searchParams.getAll(key).length !== 1)
    )
      return null;
    const value = Object.fromEntries(url.searchParams);
    const callback = new URL(value.callback ?? "");
    if (
      value.version !== "1" ||
      !/^[0-9a-f]{64}$/.test(value.pubkey ?? "") ||
      !opaque.test(value.state ?? "") ||
      callback.protocol !== "https:" ||
      !callback.hostname ||
      callback.username ||
      callback.password ||
      value.callback?.includes("#")
    )
      return null;
    return {
      pubkey: value.pubkey as string,
      callback: callback.href,
      origin: callback.origin,
      state: value.state as string,
    };
  } catch {
    return null;
  }
}

/** Where the answer goes: the callback, with the result in its fragment so it
 * never reaches a server log. */
export function identityAnswerUrl(
  request: IdentityRequest,
  answer: Readonly<{ proof: readonly string[] }> | "denied",
) {
  const fragment = new URLSearchParams({ state: request.state });
  if (answer === "denied") fragment.set("error", "access_denied");
  else fragment.set("proof", JSON.stringify(answer.proof));
  return `${request.callback}#${fragment}`;
}

/** The one request waiting for the owner. A newer link replaces it. */
export function createIdentityRequests() {
  let pending: Readonly<{
    /** Each opening is its own decision, even of the same link. */
    id: number;
    request: IdentityRequest;
    viewer: string;
  }> | null = null;
  let opened = 0;
  const listeners = new Set<() => void>();
  const set = (next: typeof pending) => {
    pending = next;
    for (const listener of [...listeners]) listener();
  };
  return {
    snapshot: () => pending,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    open: (request: IdentityRequest, viewer: string) =>
      set({ id: ++opened, request, viewer }),
    /** Closes this opening only: a newer one that replaced it stays. */
    close(id: number) {
      if (pending?.id === id) set(null);
    },
  };
}
export type IdentityRequests = ReturnType<typeof createIdentityRequests>;
