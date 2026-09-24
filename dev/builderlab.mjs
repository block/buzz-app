// Dev-only Builderlab account broker for the Hosted communities plugin, mirroring
// block/buzz desktop's builderlab.rs. The session credential and the signing key stay
// in this Node process; the page only sees account metadata and API results.
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { finalizeEvent } from "nostr-tools";

const API = "https://app.builderlab.xyz/api/goose";
// Builderlab checks Origin on identity binding; it also seeds the challenge origin.
export const BUILDERLAB_ORIGIN = "https://app.builderlab.xyz";
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const COMPLETE_HTML =
  "<!doctype html><meta charset=utf-8><title>Buzz authentication complete</title><p>You're signed in. You can close this window and return to Buzz.";

/** Account routes forwarded with allowlisted string fields only. */
const ROUTES = {
  identity: ["/v1/buzz/nostr-identities/current", []],
  unbind: ["/v1/buzz/nostr-identities/delete", []],
  list: ["/v1/buzz/communities/list", []],
  availability: ["/v1/buzz/communities/availability", ["name"]],
  create: ["/v1/buzz/communities", ["name"]],
  archive: ["/v1/buzz/communities/archive", ["community_id"]],
  unarchive: ["/v1/buzz/communities/unarchive", ["community_id"]],
  // Builderlab's transfer endpoint takes camelCase keys.
  transfer: [
    "/v1/buzz/communities/transfer",
    ["communityId", "transfereeNpub"],
  ],
};

/** Signs the kind 24243 challenge exactly as block/buzz desktop does, after the same checks. */
export function bindingEvent(key, challenge, now = Date.now()) {
  const { challenge_id, nonce, verification_code, origin, expires_at } =
    challenge ?? {};
  if (
    typeof challenge_id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      challenge_id,
    ) ||
    typeof nonce !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(nonce) ||
    typeof verification_code !== "string" ||
    !/^\d{6}$/.test(verification_code) ||
    origin !== BUILDERLAB_ORIGIN ||
    typeof expires_at !== "string" ||
    !(Date.parse(expires_at) > now)
  )
    throw new Error("Invalid Nostr identity challenge");
  return finalizeEvent(
    {
      kind: 24243,
      content: "",
      created_at: Math.floor(now / 1000),
      tags: [
        ["challenge_id", challenge_id],
        ["nonce", nonce],
        ["verification_code", verification_code],
        ["audience", "buzz:nostr-identity"],
        ["action", "bind_nostr_identity"],
        ["protocol", "buzz-nostr-identity"],
        ["version", "1"],
        ["origin", origin],
        ["expires_at", expires_at],
      ],
    },
    key,
  );
}

const openBrowser = (url) =>
  new Promise((resolve, reject) =>
    execFile(
      process.platform === "darwin" ? "/usr/bin/open" : "xdg-open",
      [url],
      (error) => (error ? reject(error) : resolve()),
    ),
  );

/** Waits for one loopback redirect carrying `code`, like the desktop callback listener. */
function awaitCallback(signal, open) {
  return new Promise((resolve, reject) => {
    const nonce = randomUUID().replaceAll("-", "");
    let settle;
    let settled = false;
    const server = createServer((req, res) => {
      let url;
      try {
        // Only origin-form targets; anything else is rejected without ending the listener.
        if (!req.url?.startsWith("/") || req.url.startsWith("//"))
          throw new Error("Bad request target");
        url = new URL(req.url, "http://127.0.0.1");
      } catch {
        res.writeHead(400).end("Bad request");
        return;
      }
      if (settled || url.pathname !== `/callback/${nonce}`) {
        res.writeHead(404).end("Not found");
        return;
      }
      res
        .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        .end(COMPLETE_HTML);
      const code = url.searchParams.get("code");
      settle(
        code
          ? null
          : new Error(
              url.searchParams.get("error_description") ??
                url.searchParams.get("error") ??
                "Authentication callback did not include a code",
            ),
        code,
      );
    });
    const timer = setTimeout(
      () => settle(new Error("Builderlab authentication timed out")),
      LOGIN_TIMEOUT_MS,
    );
    const abort = () => settle(new Error("Builderlab authentication canceled"));
    settle = (error, code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      server.close();
      server.closeAllConnections?.();
      if (error) reject(error);
      else resolve(code);
    };
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort);
    server.once("error", (error) => settle(error));
    server.listen(0, "127.0.0.1", () => {
      const returnTo = `http://127.0.0.1:${server.address().port}/callback/${nonce}`;
      const login = new URL(`${API}/v1/auth/login`);
      login.searchParams.set("type", "cli");
      login.searchParams.set("product", "buzz");
      login.searchParams.set("returnTo", returnTo);
      open(login.href).catch((error) => settle(error));
    });
  });
}

export function createBuilderlab({
  key,
  fetch = globalThis.fetch,
  open = openBrowser,
}) {
  let credential;
  const request = async (path, body, session = credential) => {
    if (!session) throw new Error("Sign in to Builderlab first");
    const response = await fetch(`${API}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-BB-Session-Credential": session,
        Origin: BUILDERLAB_ORIGIN,
      },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(60000),
    });
    const value = await response.json().catch(() => undefined);
    // Structured `{ error: { code, ... } }` bodies pass through for friendly UI messages.
    if (value && typeof value === "object" && (response.ok || value.error))
      return value;
    throw new Error(`Builderlab request failed (HTTP ${response.status}).`);
  };
  const me = async (session, signal) => {
    const response = await fetch(`${API}/v1/auth/me`, {
      headers: { "X-BB-Session-Credential": session },
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
    });
    if (!response.ok)
      throw new Error(
        `Builderlab session check failed with HTTP ${response.status}`,
      );
    const { email, name, expires_at } = await response.json();
    return { email, name, expiresAt: expires_at };
  };
  // Sign-in and sign-out bump the generation; late results from an older one never
  // write, clear or describe the current session.
  let generation = 0;
  let session;
  const revoke = () => {
    generation += 1;
    session?.abort();
    session = new AbortController();
    credential = undefined;
  };
  revoke();
  return {
    async auth() {
      const current = credential;
      if (!current) return null;
      const started = generation;
      try {
        const account = await me(current, session.signal);
        if (started !== generation)
          throw new Error("Builderlab session changed");
        return account;
      } catch (error) {
        if (started === generation) credential = undefined;
        throw error;
      }
    },
    async login(signal) {
      revoke();
      const started = generation;
      const attempt = AbortSignal.any([signal, session.signal]);
      const code = await awaitCallback(attempt, open);
      const response = await fetch(`${API}/v1/auth/login/exchange`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
        redirect: "error",
        signal: AbortSignal.any([attempt, AbortSignal.timeout(30000)]),
      });
      if (!response.ok)
        throw new Error(
          `Builderlab code exchange failed with HTTP ${response.status}`,
        );
      const exchanged = await response.json();
      if (
        typeof exchanged.session_credential !== "string" ||
        !exchanged.session_credential
      )
        throw new Error(
          "Builderlab code exchange returned an empty credential",
        );
      const account = await me(exchanged.session_credential, attempt);
      if (account.expiresAt !== exchanged.expires_at)
        throw new Error(
          "Builderlab session expiry did not match code exchange",
        );
      if (attempt.aborted || started !== generation)
        throw new Error("Builderlab authentication canceled");
      credential = exchanged.session_credential;
      return account;
    },
    signOut: revoke,
    async bind() {
      const session = credential;
      const started = generation;
      const challenge = await request(
        "/v1/buzz/nostr-identities/challenge",
        { origin: BUILDERLAB_ORIGIN },
        session,
      );
      if (challenge.error) return challenge;
      // A sign-out or new sign-in while the challenge was pending must not let the
      // old credential claim this device's key.
      if (started !== generation) throw new Error("Builderlab session changed");
      const event = bindingEvent(key(), challenge);
      return request(
        "/v1/buzz/nostr-identities/verify",
        {
          challenge_id: challenge.challenge_id,
          nonce: challenge.nonce,
          signed_payload: JSON.stringify(event),
        },
        session,
      );
    },
    async call(action, input) {
      const route = Object.hasOwn(ROUTES, action) ? ROUTES[action] : undefined;
      if (!route) return undefined;
      const [path, fields] = route;
      const body = {};
      for (const field of fields) {
        const value = input?.[field];
        if (typeof value !== "string" || !value || value.length > 200)
          throw new Error(`Missing ${field}`);
        body[field] = value;
      }
      return request(path, body);
    },
  };
}
