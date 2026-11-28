// A Pi provider for a Databricks workspace's AI Gateway, signed in with the
// browser the way the Databricks CLI is (its `databricks-cli` OAuth client,
// PKCE). Claude models speak Anthropic Messages and GPT models OpenAI
// Responses, each under the workspace's /ai-gateway, with Pi's own limits for
// the model. Sign in with `pi`, then `/login`; Buzz refreshes.
import {
  anthropicMessagesApi,
  createProvider,
  openAIResponsesApi,
} from "@earendil-works/pi-ai/compat";
import type {
  Api,
  Model,
  OAuthCredential,
  Provider,
  ProviderAuthInteraction,
  ProviderStreams,
} from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/** Pi's models whose endpoint, `databricks-<id>` with `.` as `-`, the tested
 * workspace serves. Another may serve fewer, and bill other than Pi's list. */
const MODELS = new Set([
  "claude-fable-5",
  "claude-fable-5-1",
  "claude-haiku-4-5",
  "claude-haiku-5-5",
  "claude-opus-4-5",
  "claude-opus-4-6",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-opus-5",
  "claude-opus-5-5",
  "claude-sonnet-4-5",
  "claude-sonnet-4-6",
  "claude-sonnet-5",
  "claude-sonnet-5-5",
  "gpt-5",
  "gpt-5-mini",
  "gpt-5-nano",
  "gpt-5.1",
  "gpt-5.2",
  "gpt-5.3-codex",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.5",
  "gpt-5.5-pro",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-6-astra",
  "gpt-6-luna",
  "gpt-6-sol",
  "gpt-6.1-sol",
  "gpt-6.1-terra",
]);
const CLIENT = "databricks-cli";
/** How long the browser sign-in may take. */
const LOGIN_MS = 5 * 60_000;

/** Pi's API for each protocol, sent under the signed-in workspace's `path`:
 * the workspace comes with the credential, as the request's `baseUrl`. */
const under = (api: ProviderStreams, path: string): ProviderStreams => ({
  stream: (model, context, options) =>
    api.stream({ ...model, baseUrl: model.baseUrl + path }, context, options),
  streamSimple: (model, context, options) =>
    api.streamSimple(
      { ...model, baseUrl: model.baseUrl + path },
      context,
      options,
    ),
});

/** A token response as Pi's credential, for the workspace it's from. A
 * refresh may keep the refresh token it was sent. The secrets it posts go
 * to that workspace only, never to where a redirect points. */
async function credential(
  host: string,
  body: Record<string, string>,
  signal: AbortSignal,
  refresh?: string,
): Promise<OAuthCredential> {
  const response = await fetch(`${host}/oidc/v1/token`, {
    method: "POST",
    body: new URLSearchParams({ client_id: CLIENT, ...body }),
    redirect: "error",
    signal,
  });
  if (!response.ok)
    throw new Error(
      `Databricks sign-in failed (HTTP ${response.status}). Sign in again with pi's /login.`,
    );
  const token = await response.json().catch(() => undefined);
  const access = token?.access_token,
    kept = token?.refresh_token ?? refresh,
    life = token?.expires_in;
  if (
    typeof access !== "string" ||
    !access ||
    typeof kept !== "string" ||
    !kept ||
    !(Number.isFinite(life) && life > 0)
  )
    throw new Error(
      "Databricks sent an unusable sign-in. Sign in again with pi's /login.",
    );
  return {
    type: "oauth",
    host,
    access,
    refresh: kept,
    expires: Date.now() + life * 1000,
  };
}

/** The workspace's browser sign-in: a code for a one-time PKCE verifier,
 * sent back to a loopback port only for as long as it waits. */
async function login({
  prompt,
  notify,
  signal,
}: ProviderAuthInteraction): Promise<OAuthCredential> {
  const workspace = new URL(
    await prompt({
      type: "text",
      message: "Databricks workspace URL",
      placeholder: "https://example.cloud.databricks.com",
    }),
  );
  if (workspace.protocol !== "https:")
    throw new Error("A Databricks workspace URL starts with https://");
  const host = workspace.origin;
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(16).toString("base64url");
  const waiting = AbortSignal.any([signal, AbortSignal.timeout(LOGIN_MS)]);
  const server = createServer();
  const redirect = () =>
    `http://localhost:${(server.address() as AddressInfo).port}`;
  try {
    const code = await new Promise<string>((resolve, reject) => {
      if (waiting.aborted) return reject(waiting.reason);
      waiting.addEventListener("abort", () => reject(waiting.reason), {
        once: true,
      });
      server.once("error", reject);
      server.on("request", (request, response) => {
        const query = URL.parse(
          request.url ?? "",
          "http://localhost",
        )?.searchParams;
        if (query?.get("state") !== state)
          return void response.writeHead(404).end();
        const code = query.get("code");
        response.end(
          code
            ? "Databricks sent a sign-in code. Go back to Pi to finish."
            : "Databricks sign-in failed.",
        );
        if (code) resolve(code);
        else
          reject(
            new Error(
              `Databricks sign-in failed: ${query.get("error_description") ?? query.get("error")}`,
            ),
          );
      });
      server.listen(0, "127.0.0.1", () => {
        const challenge = createHash("sha256")
          .update(verifier)
          .digest("base64url");
        const query = new URLSearchParams({
          response_type: "code",
          client_id: CLIENT,
          redirect_uri: redirect(),
          scope: "all-apis offline_access",
          state,
          code_challenge: challenge,
          code_challenge_method: "S256",
        });
        notify({ type: "auth_url", url: `${host}/oidc/v1/authorize?${query}` });
      });
    });
    return await credential(
      host,
      {
        grant_type: "authorization_code",
        code,
        redirect_uri: redirect(),
        code_verifier: verifier,
      },
      signal,
    );
  } finally {
    server.close();
  }
}

export function databricksProvider(): Provider {
  const models = (provider: "anthropic" | "openai") =>
    getBuiltinModels(provider)
      .filter((model) => MODELS.has(model.id))
      .map(
        (model): Model<Api> => ({
          ...model,
          id: `databricks-${model.id.replaceAll(".", "-")}`,
          provider: "databricks",
          baseUrl: "",
        }),
      );
  return createProvider({
    id: "databricks",
    name: "Databricks",
    baseUrl: "",
    auth: {
      oauth: {
        name: "Databricks",
        login,
        refresh: (old, signal) =>
          credential(
            old.host as string,
            { grant_type: "refresh_token", refresh_token: old.refresh },
            signal,
            old.refresh,
          ),
        toAuth: async ({ host, access }) => ({
          baseUrl: host as string,
          headers: { Authorization: `Bearer ${access}` },
        }),
      },
    },
    models: [...models("anthropic"), ...models("openai")],
    api: {
      "anthropic-messages": under(
        anthropicMessagesApi(),
        "/ai-gateway/anthropic",
      ),
      "openai-responses": under(openAIResponsesApi(), "/ai-gateway/openai/v1"),
    },
  });
}

/** Buzz calls this with nothing, for its `providers`; `pi` calls it with its
 * extension API, which signs in only to a provider registered there. */
export default (pi?: { registerProvider(provider: Provider): void }) => {
  const provider = databricksProvider();
  pi?.registerProvider(provider);
  return { providers: [provider] };
};
