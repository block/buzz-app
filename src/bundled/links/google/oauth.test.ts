import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Host, HostResponse } from "../../../features/host/service";
import type { BrowserBridge } from "../../../shared/oauth/native-bridge";
import { deferred } from "../../../shared/test-helpers";
import {
  createTokenSource,
  DRIVE_API,
  googleClient,
  googleCredential,
  TOKEN_URL,
} from "./oauth";

beforeEach(() => {
  vi.stubEnv(
    "VITE_BUZZ_GOOGLE_OAUTH_CLIENT_ID",
    "client.apps.googleusercontent.com",
  );
  vi.stubEnv("VITE_BUZZ_GOOGLE_OAUTH_CLIENT_SECRET", "installed-app-secret");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const json = (status: number, body: unknown): HostResponse => ({
  status,
  headers: {},
  body: JSON.stringify(body),
});
const tokens = json(200, {
  access_token: "access-1",
  expires_in: 3600,
  refresh_token: "refresh-1",
});
const about = json(200, {
  user: { emailAddress: " a@block.xyz ", permissionId: "123" },
});

function fixture(
  responses: { token?: HostResponse; about?: HostResponse } = {},
) {
  const bridge: BrowserBridge = {
    begin: vi.fn(async ({ callbackPath }) => ({
      id: "attempt",
      callbackUrl: `http://127.0.0.1:12345${callbackPath}`,
    })),
    wait: vi.fn(async () => ({ parameters: [["code", "one-time"]] as const })),
    cancel: vi.fn(async () => {}),
  };
  const host: Host = {
    runCommand: vi.fn(),
    request: vi.fn(async ({ url }) =>
      url === TOKEN_URL
        ? (responses.token ?? tokens)
        : (responses.about ?? about),
    ),
  };
  return { bridge, host, controller: new AbortController() };
}
const form = (body: string | undefined) =>
  Object.fromEntries(new URLSearchParams(body ?? ""));

it("asks for Drive metadata consent with an S256 proof and exchanges the code at the loopback redirect", async () => {
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  vi.spyOn(crypto, "getRandomValues").mockReturnValueOnce(
    new Uint8Array(Buffer.from(verifier, "base64url")),
  );
  const { bridge, host, controller } = fixture();
  const credential = await googleCredential(host, controller.signal, bridge);
  expect(credential.account).toEqual({ subject: "123", email: "a@block.xyz" });
  await expect(credential.token()).resolves.toBe("access-1");

  const options = vi.mocked(bridge.begin).mock.calls[0]?.[0];
  const authorization = new URL(options?.authorizationUrl ?? "");
  expect(authorization.origin).toBe("https://accounts.google.com");
  expect(authorization.pathname).toBe("/o/oauth2/v2/auth");
  expect(Object.fromEntries(authorization.searchParams)).toEqual({
    client_id: "client.apps.googleusercontent.com",
    response_type: "code",
    scope: "https://www.googleapis.com/auth/drive.metadata.readonly",
    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent",
  });
  expect(options).toMatchObject({ useState: true });
  expect(options?.callbackPath).toMatch(/^\/callback\/[0-9a-f-]{36}$/);

  const [exchange, identify] = vi
    .mocked(host.request)
    .mock.calls.map(([request]) => request);
  expect(exchange).toMatchObject({
    url: TOKEN_URL,
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  expect(form(exchange?.body)).toEqual({
    grant_type: "authorization_code",
    code: "one-time",
    code_verifier: verifier,
    redirect_uri: `http://127.0.0.1:12345${options?.callbackPath}`,
    client_id: "client.apps.googleusercontent.com",
    client_secret: "installed-app-secret",
  });
  expect(identify).toMatchObject({
    url: `${DRIVE_API}/about?fields=user(emailAddress,permissionId)`,
    method: "GET",
    headers: { Authorization: "Bearer access-1" },
  });
  expect(bridge.cancel).toHaveBeenCalledWith("attempt");
});

it("omits the client secret when the build has none", async () => {
  vi.stubEnv("VITE_BUZZ_GOOGLE_OAUTH_CLIENT_SECRET", "");
  const { bridge, host, controller } = fixture();
  await googleCredential(host, controller.signal, bridge);
  expect(
    form(vi.mocked(host.request).mock.calls[0]?.[0].body),
  ).not.toHaveProperty("client_secret");
});

it("an unconfigured build cannot start sign-in", async () => {
  vi.stubEnv("VITE_BUZZ_GOOGLE_OAUTH_CLIENT_ID", "");
  expect(() => googleClient()).toThrow("not configured");
  const { bridge, host, controller } = fixture();
  await expect(
    googleCredential(host, controller.signal, bridge),
  ).rejects.toThrow("not configured");
  expect(bridge.begin).not.toHaveBeenCalled();
  expect(() => googleClient("has space", "")).toThrow("not configured");
});

it.each([
  {
    name: "a provider error",
    wait: [["error", "access_denied"]] as const,
    message: "Browser sign-in failed",
  },
  {
    name: "a callback without a code",
    wait: [] as const,
    message: "Invalid Google callback code",
  },
  {
    name: "a rejected exchange",
    token: json(400, { error: "invalid_grant", error_description: "leak" }),
    message: "Google sign-in failed (HTTP 400)",
  },
  {
    name: "an unreadable token response",
    token: { status: 200, headers: {}, body: "<html>" },
    message: "invalid sign-in response",
  },
  {
    name: "a token response without an access token",
    token: json(200, { expires_in: 3600 }),
    message: "did not return a valid credential",
  },
  {
    name: "a rejected account lookup",
    about: json(403, { error: "leak" }),
    message: "Google sign-in failed (HTTP 403)",
  },
  {
    name: "an account without an id",
    about: json(200, { user: { emailAddress: "a@block.xyz" } }),
    message: "did not return a valid account",
  },
])("fails on $name without forwarding provider bodies", async (scenario) => {
  const { bridge, host, controller } = fixture(scenario);
  if (scenario.wait)
    vi.mocked(bridge.wait).mockResolvedValueOnce({ parameters: scenario.wait });
  const failure = googleCredential(host, controller.signal, bridge);
  await expect(failure).rejects.toThrow(scenario.message);
  await expect(failure).rejects.not.toThrow("leak");
  expect(bridge.cancel).toHaveBeenCalledWith("attempt");
});

it("cancellation releases the native attempt and reports a cancel", async () => {
  const { bridge, host, controller } = fixture();
  const callback = deferred<{
    parameters: readonly (readonly [string, string])[];
  }>();
  vi.mocked(bridge.wait).mockReturnValueOnce(callback.promise);
  const pending = googleCredential(host, controller.signal, bridge);
  await vi.waitFor(() => expect(bridge.wait).toHaveBeenCalled());
  controller.abort();
  callback.resolve({ parameters: [["code", "late"]] });
  await expect(pending).rejects.toThrow("Sign-in canceled.");
  expect(bridge.cancel).toHaveBeenCalledWith("attempt");
  expect(host.request).not.toHaveBeenCalled();
});

it("serves the access token until a minute before expiry, then renews once for concurrent callers", async () => {
  vi.useFakeTimers();
  const { host } = fixture({
    token: json(200, { access_token: "access-2", expires_in: 3600 }),
  });
  const client = googleClient();
  const token = createTokenSource(host, client, {
    access: "access-1",
    expiresAt: Date.now() + 1_000,
    refresh: "refresh-1",
  });
  await expect(token()).resolves.toBe("access-1");
  expect(host.request).not.toHaveBeenCalled();
  vi.advanceTimersByTime(2_000);
  const renewals = await Promise.all([token(), token()]);
  expect(renewals).toEqual(["access-2", "access-2"]);
  expect(host.request).toHaveBeenCalledTimes(1);
  expect(form(vi.mocked(host.request).mock.calls[0]?.[0].body)).toEqual({
    grant_type: "refresh_token",
    refresh_token: "refresh-1",
    client_id: "client.apps.googleusercontent.com",
    client_secret: "installed-app-secret",
  });
  // The API rejected the fresh token: renew again, keeping the original refresh token.
  await expect(token(true)).resolves.toBe("access-2");
  expect(host.request).toHaveBeenCalledTimes(2);
  expect(form(vi.mocked(host.request).mock.calls[1]?.[0].body)).toMatchObject({
    refresh_token: "refresh-1",
  });
});

it("an expired session without a refresh token asks for a new sign-in", async () => {
  const { host } = fixture();
  const token = createTokenSource(host, googleClient(), {
    access: "access-1",
    expiresAt: 0,
    refresh: undefined,
  });
  await expect(token()).rejects.toThrow("Sign in again");
  expect(host.request).not.toHaveBeenCalled();
});
