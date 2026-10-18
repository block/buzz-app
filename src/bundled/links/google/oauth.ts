import type { Host } from "../../../features/host/service";
import {
  browserCallback,
  callbackCode,
  nativeBridge,
  pkceChallenge,
  type BrowserBridge,
} from "../../../shared/oauth/native-bridge";
import type { OAuthAccount } from "../../../shared/oauth/session";

const AUTHORIZATION_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const DRIVE_API = "https://www.googleapis.com/drive/v3";
const SCOPE = "https://www.googleapis.com/auth/drive.metadata.readonly";
const TOKEN_LIMIT = 4096;
const EARLY_REFRESH_MS = 60_000;

export type GoogleClient = Readonly<{ id: string; secret: string }>;

/** This build's public OAuth client. Google documents installed-app secrets as non-confidential. */
export function googleClient(
  id = import.meta.env.VITE_BUZZ_GOOGLE_OAUTH_CLIENT_ID ?? "",
  secret = import.meta.env.VITE_BUZZ_GOOGLE_OAUTH_CLIENT_SECRET ?? "",
): GoogleClient {
  const printable = /^[\x21-\x7e]{1,256}$/;
  if (!printable.test(id))
    throw new Error("Google sign-in is not configured for this Buzz build.");
  if (secret && !printable.test(secret))
    throw new Error("This Buzz build has an invalid Google sign-in client.");
  return Object.freeze({ id, secret });
}

export type GoogleCredential = Readonly<{
  account: OAuthAccount;
  /** A current access token; `force` renews after the API rejected the last one. */
  token(force?: boolean): Promise<string>;
}>;

type Tokens = Readonly<{
  access: string;
  expiresAt: number;
  refresh: string | undefined;
}>;

function clientForm(client: GoogleClient) {
  return client.secret
    ? { client_id: client.id, client_secret: client.secret }
    : { client_id: client.id };
}

async function tokenRequest(
  host: Host,
  signal: AbortSignal | undefined,
  form: Record<string, string>,
): Promise<Tokens> {
  signal?.throwIfAborted();
  const response = await host.request({
    url: TOKEN_URL,
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(form).toString(),
  });
  signal?.throwIfAborted();
  if (response.status < 200 || response.status >= 300)
    throw new Error(
      `Google sign-in failed (HTTP ${response.status}). Try again.`,
    );
  let result: {
    access_token?: unknown;
    expires_in?: unknown;
    refresh_token?: unknown;
  };
  try {
    result = JSON.parse(response.body);
  } catch {
    throw new Error("Google returned an invalid sign-in response.");
  }
  const { access_token, expires_in, refresh_token } = result ?? {};
  if (
    typeof access_token !== "string" ||
    !access_token ||
    access_token.length > TOKEN_LIMIT ||
    typeof expires_in !== "number" ||
    !Number.isFinite(expires_in)
  )
    throw new Error("Google did not return a valid credential.");
  return {
    access: access_token,
    expiresAt: Date.now() + Math.max(0, expires_in * 1000 - EARLY_REFRESH_MS),
    refresh:
      typeof refresh_token === "string" &&
      refresh_token &&
      refresh_token.length <= TOKEN_LIMIT
        ? refresh_token
        : undefined,
  };
}

/** Serves the access token, renewing it once at a time with the refresh token. */
export function createTokenSource(
  host: Host,
  client: GoogleClient,
  initial: Tokens,
): GoogleCredential["token"] {
  let current = initial;
  let pending: Promise<string> | undefined;
  return (force = false) => {
    if (!force && Date.now() < current.expiresAt)
      return Promise.resolve(current.access);
    pending ??= (async () => {
      if (!current.refresh)
        throw new Error("Google sign-in expired. Sign in again.");
      const next = await tokenRequest(host, undefined, {
        grant_type: "refresh_token",
        refresh_token: current.refresh,
        ...clientForm(client),
      });
      current = { ...next, refresh: next.refresh ?? current.refresh };
      return current.access;
    })().finally(() => {
      pending = undefined;
    });
    return pending;
  };
}

/** Acquire Drive metadata access and identify the account. No UI or storage. */
export async function googleCredential(
  host: Host,
  signal: AbortSignal,
  bridge: BrowserBridge = nativeBridge,
): Promise<GoogleCredential> {
  signal.throwIfAborted();
  const client = googleClient();
  try {
    const { verifier, challenge } = await pkceChallenge();
    signal.throwIfAborted();
    const authorization = new URL(AUTHORIZATION_URL);
    authorization.search = new URLSearchParams({
      client_id: client.id,
      response_type: "code",
      scope: SCOPE,
      code_challenge: challenge,
      code_challenge_method: "S256",
      // Memory-only sessions re-consent each launch; offline access keeps names
      // resolving past the first hour without another browser round trip.
      access_type: "offline",
      prompt: "consent",
    }).toString();
    const { callbackUrl, parameters } = await browserCallback(
      bridge,
      signal,
      authorization.href,
    );
    const code = callbackCode(parameters, "Google");
    const tokens = await tokenRequest(host, signal, {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: callbackUrl,
      ...clientForm(client),
    });
    const about = await host.request({
      url: `${DRIVE_API}/about?fields=user(emailAddress,permissionId)`,
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${tokens.access}`,
      },
    });
    signal.throwIfAborted();
    if (about.status < 200 || about.status >= 300)
      throw new Error(
        `Google sign-in failed (HTTP ${about.status}). Try again.`,
      );
    let user: { permissionId?: unknown; emailAddress?: unknown } | undefined;
    try {
      user = JSON.parse(about.body)?.user;
    } catch {
      throw new Error("Google returned an invalid sign-in response.");
    }
    if (typeof user?.permissionId !== "string" || !user.permissionId.trim())
      throw new Error("Google did not return a valid account.");
    return Object.freeze({
      account: Object.freeze({
        subject: user.permissionId,
        email:
          typeof user.emailAddress === "string" ? user.emailAddress.trim() : "",
      }),
      token: createTokenSource(host, client, tokens),
    });
  } catch (error) {
    if (signal.aborted) throw new Error("Sign-in canceled.");
    // Native errors are strings. Never forward provider bodies or credentials.
    throw error instanceof Error
      ? error
      : new Error("Could not complete Google sign-in. Try again.");
  }
}
