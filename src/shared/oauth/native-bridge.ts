import { invoke, isTauri } from "@tauri-apps/api/core";

export type OAuthCallback = Readonly<{
  parameters: readonly (readonly [string, string])[];
}>;
export type BrowserBridge = {
  begin(options: {
    authorizationUrl: string;
    callbackPath: string;
    useState?: boolean;
  }): Promise<{ id: string; callbackUrl: string }>;
  wait(id: string): Promise<OAuthCallback>;
  cancel(id: string): Promise<void>;
};

export const browserLoginAvailable = () => isTauri();

/** The shared native `oauth_callback` module: loopback redirect, browser launch and state. */
export const nativeBridge: BrowserBridge = {
  begin: (options) => invoke("oauth_callback_begin", options),
  wait: (id) => invoke("oauth_callback_wait", { id }),
  cancel: (id) => invoke("oauth_callback_cancel", { id }),
};

export function base64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** RFC 7636 S256 pair; the verifier lives in memory for one attempt only. */
export async function pkceChallenge() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

/**
 * One browser handoff: open the authorization URL, await the loopback callback
 * and always release the native attempt. A random callback path binds the attempt.
 */
export async function browserCallback(
  bridge: BrowserBridge,
  signal: AbortSignal,
  authorizationUrl: string,
) {
  signal.throwIfAborted();
  let id: string | undefined;
  const cancel = () => {
    if (id) void bridge.cancel(id).catch(() => {});
  };
  try {
    const attempt = await bridge.begin({
      authorizationUrl,
      callbackPath: `/callback/${crypto.randomUUID()}`,
      useState: true,
    });
    id = attempt.id;
    signal.addEventListener("abort", cancel, { once: true });
    signal.throwIfAborted();
    const response = await bridge.wait(id);
    signal.throwIfAborted();
    return {
      callbackUrl: attempt.callbackUrl,
      parameters: new URLSearchParams(
        response.parameters.map(([name, value]) => [name, value]),
      ),
    };
  } finally {
    signal.removeEventListener("abort", cancel);
    if (id) await bridge.cancel(id);
  }
}

/** The single authorization code from a callback, or the provider's failure. */
export function callbackCode(parameters: URLSearchParams, provider: string) {
  if (parameters.has("error"))
    throw new Error("Browser sign-in failed. Try again.");
  const codes = parameters.getAll("code");
  const code = codes[0];
  if (codes.length !== 1 || !code || code.length > 4096)
    throw new Error(`Invalid ${provider} callback code.`);
  return code;
}
