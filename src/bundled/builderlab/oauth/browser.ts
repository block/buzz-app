import type { Host } from "../../../features/host/service";
import {
  browserCallback,
  callbackCode,
  nativeBridge,
  pkceChallenge,
  type BrowserBridge,
} from "../../../shared/oauth/native-bridge";

export {
  browserLoginAvailable,
  type BrowserBridge,
  type OAuthCallback,
} from "../../../shared/oauth/native-bridge";

/** The configured HTTPS origin is granted to this plugin at build time. */
export function oauthTarget(
  value = import.meta.env.VITE_BUZZ_BUILDERLAB_URL ?? "",
) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      "Builderlab sign-in is not configured for this Buzz build.",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.href.includes("?") ||
    url.href.includes("#")
  )
    throw new Error(
      "This Buzz build does not support the configured Builderlab sign-in address.",
    );
  return `${url.href.replace(/\/$/, "")}/api/goose`;
}

export type Credential = Readonly<{
  value: string;
  account: Readonly<{
    subject: string;
    email: string;
  }>;
}>;

/** Acquire and verify a credential. No UI, storage, or authenticated API consumers. */
export async function browserCredential(
  host: Host,
  signal: AbortSignal,
  bridge: BrowserBridge = nativeBridge,
): Promise<Credential> {
  signal.throwIfAborted();
  const target = oauthTarget();
  try {
    const { verifier, challenge } = await pkceChallenge();
    signal.throwIfAborted();
    const login = new URL(`${target}/v1/auth/login`);
    login.search = new URLSearchParams({
      type: "cli",
      product: "builderlab",
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    const { parameters } = await browserCallback(bridge, signal, login.href);
    const code = callbackCode(parameters, "Builderlab");
    const request = async (
      path: string,
      credential?: string,
      body?: string,
    ) => {
      signal.throwIfAborted();
      const response = await host.request({
        url: `${target}${path}`,
        method: body ? "POST" : "GET",
        headers: {
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(credential ? { "X-BB-Session-Credential": credential } : {}),
        },
        ...(body ? { body } : {}),
      });
      signal.throwIfAborted();
      if (response.status < 200 || response.status >= 300)
        throw new Error(
          `Builderlab sign-in failed (HTTP ${response.status}). Try again.`,
        );
      try {
        return JSON.parse(response.body);
      } catch {
        throw new Error("Builderlab returned an invalid sign-in response.");
      }
    };
    const exchange = await request(
      "/v1/auth/login/exchange",
      undefined,
      JSON.stringify({ code, code_verifier: verifier }),
    );
    const session_credential = exchange?.session_credential;
    if (
      typeof session_credential !== "string" ||
      !session_credential ||
      session_credential.length > 4096 ||
      [...session_credential].some(
        (character) =>
          character.charCodeAt(0) <= 32 || character.charCodeAt(0) > 126,
      )
    )
      throw new Error("Builderlab did not return a valid credential.");
    const account = await request("/v1/auth/me", session_credential);
    if (typeof account?.subject !== "string" || !account.subject.trim())
      throw new Error("Builderlab did not return a valid account.");
    return Object.freeze({
      value: session_credential,
      account: Object.freeze({
        subject: account.subject,
        email: typeof account.email === "string" ? account.email.trim() : "",
      }),
    });
  } catch (error) {
    if (signal.aborted) throw new Error("Sign-in canceled.");
    // Native errors are strings. Never forward provider bodies or credentials.
    throw error instanceof Error
      ? error
      : new Error("Could not complete Builderlab sign-in. Try again.");
  }
}
