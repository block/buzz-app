// Buzz's Pi host: Pi durable for this computer's Pi agents, driven by the Pi
// plugin over stdio, one JSON message a line. Each agent has its own Harness
// in its own SQLite file, and each Buzz conversation is one Pi conversation
// in it, found again through the `buzz.places` document. The Buzz tools run
// in the app, which holds the agent's key: a call to one here is a request
// back to the plugin. `pi.sh` runs this with Node in the folder its packages
// are installed in.
import { readFileSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { homedir } from "node:os";
import { realpathSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  awaitWithContext,
  BACKGROUND_CONTEXT,
  withTelemetry,
} from "@earendil-works/chord/context";
import {
  clampThinkingLevel,
  createModels,
  createProvider,
  formatUserAgent,
  getSupportedThinkingLevels,
  getSystemMessageText,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { lazyStream } from "@earendil-works/pi-ai/api/lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
  AssistantEntry,
  createRegistry,
  defineDoc,
  defineExtension,
  defineTool,
  Harness,
  hook,
  ToolTask,
  ProviderDoc,
  ResetEntry,
  SessionFailed,
  section,
  UsageDoc,
  watchEvents,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import lockfile from "proper-lockfile";

/** Protected Pi uses the same snapshots for review and execution. The model
 * barrier is inside Models.applyAuth, before every provider dispatch, including
 * compaction and retry/recovery paths. Unsupported payload hooks fail closed. */
export function protectModels(models, inspect, conversationFor) {
  const requests = new Set([
    "stream",
    "complete",
    "streamSimple",
    "completeSimple",
    "generateImages",
    "classify",
  ]);
  const deferred = new Set([
    "streamDeferred",
    "fetchDeferred",
    "cancelDeferred",
  ]);
  return new Proxy(models, {
    get(target, name) {
      if (deferred.has(name))
        return () => {
          throw new Error(
            "Protected Pi does not support deferred provider requests",
          );
        };
      const method = Reflect.get(target, name);
      if (!requests.has(name))
        return typeof method === "function" ? method.bind(target) : method;
      return (model, input, options = {}) => {
        if (
          options.onPayload ||
          options.transformHeaders ||
          options.samplingParams ||
          options.deferred ||
          model.samplingParams ||
          model.samplingParamsByThinkingLevel
        )
          throw new Error(
            "Protected Pi cannot review this provider payload override",
          );
        const selected = structuredClone(model),
          content = structuredClone(input);
        // Telemetry spans hold functions and only observe the request.
        const { signal, apiKey, headers, env, telemetry, ...data } = options;
        const settings = structuredClone(data);
        return method.call(target, selected, content, {
          ...settings,
          signal,
          telemetry,
          apiKey,
          headers: structuredClone(headers),
          env: structuredClone(env),
          transformHeaders: async (assembled) => {
            signal?.throwIfAborted();
            const session = await conversationFor(settings.sessionId);
            if (!Array.isArray(content.messages))
              throw new Error(
                "Protected Pi requires explicit conversation messages",
              );
            // Provider settings and tool schemas are not conversation text.
            // Keep dynamic instructions and every native message as distinct sources.
            for (const [source, value] of [
              ["instructions", content.systemPrompt ?? ""],
              ...content.messages.map((message) => [
                "message",
                message.role === "system"
                  ? { role: "system", content: getSystemMessageText(message) }
                  : message,
              ]),
            ]) {
              await inspect(
                {
                  kind: "context",
                  session: String(session),
                  content: { source, value },
                },
                signal,
              );
            }
            signal?.throwIfAborted();
            return assembled;
          },
        });
      };
    },
  });
}

/** the model gateway: the provider an agent eligible for gateway mode
 * uses, in place of every other. Each model keeps the one protocol it was
 * verified with (README: "gateway mode"); nothing retries on another. */
export const GATEWAY = "buzz-gateway";
const PROTOCOLS = {
  "anthropic/v1/messages": {
    api: "anthropic-messages",
    path: "anthropic",
    compat: { sendSessionAffinityHeaders: true },
  },
  "openai/v1/responses": { api: "openai-responses", path: "openai/v1" },
  // Databricks rejects `store` and `max_completion_tokens` on this protocol.
  "mlflow/v1/chat/completions": {
    api: "openai-completions",
    path: "mlflow/v1",
    compat: {
      sendSessionAffinityHeaders: true,
      supportsStore: false,
      maxTokensField: "max_tokens",
    },
  },
};
/** The protocol each model family is verified on; others use mlflow's. */
const NATIVE = {
  claude: "anthropic/v1/messages",
  gpt: "openai/v1/responses",
};
/** A header name as the gateway compares it: ASCII lowercase, `_` as `-`. */
const fold = (name) => name.toLowerCase().replaceAll("_", "-");
/** Whether only Buzz may set `name` under the build's header profile: one
 * of its context headers, or a name under one of its reserved prefixes. */
const reserved = (profile, name) => {
  const folded = fold(name);
  return (
    Object.values(profile.headers).includes(folded) ||
    profile.reserved_prefixes.some((prefix) => folded.startsWith(prefix))
  );
};
/** Headers the gateway takes a session from ahead of, or as, the affinity
 * one: any other value would attribute the request to another session. */
const CORRELATION =
  /^(?:x-session-affinity|x-litellm-(?:session|trace)-id|agent-session-id|session-id|x-.+-session-id)$/i;
/** The gateway's own credential stands in for this placeholder. */
const GATEWAY_KEY = "buzz-gateway";

/** What every gateway model has: what a run sizes its context by. */
const GATEWAY_LIMITS = {
  reasoning: false,
  contextWindow: 128_000,
  maxTokens: 16_384,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
/** The api of a held gateway model, which no provider serves. */
const HELD = "buzz-held";

/** The gateway's models as `current()` has them now. Gateway runs left by
 * an earlier host continue as soon as Pi is asked anything, and Pi fails a
 * run whose model it can't find for good. So while `current().held` waits
 * for the route they need, their models are held: found by id, with
 * requests that wait for that route's models, and fail only if it has none
 * by that id. */
function heldModels(current) {
  const request =
    (name) =>
    (model, context, options = {}) => {
      if (model.api !== HELD)
        return current().catalog[name](model, context, options);
      return lazyStream(model, async () => {
        const hold = current().held?.promise;
        // Ended by the run's cancellation, which nothing is sent after.
        if (hold) await awaitWithContext(hold, { abortSignal: options.signal });
        const { catalog } = current();
        const found = catalog.getModel(model.provider, model.id);
        if (!found)
          throw new Error(
            `Model ${model.provider}/${model.id} is not available`,
          );
        return catalog[name](found, context, options);
      });
    };
  const held = {
    getModel: (provider, id) =>
      current().catalog.getModel(provider, id) ??
      (current().held && provider === GATEWAY
        ? {
            ...GATEWAY_LIMITS,
            id,
            name: id,
            api: HELD,
            provider,
            baseUrl: "",
            input: ["text"],
          }
        : undefined),
    stream: request("stream"),
    streamSimple: request("streamSimple"),
    complete: (...args) => held.stream(...args).result(),
    completeSimple: (...args) => held.streamSimple(...args).result(),
  };
  return new Proxy(held, {
    get: (target, name) => {
      if (Object.hasOwn(target, name)) return target[name];
      const { catalog } = current();
      const value = Reflect.get(catalog, name);
      return typeof value === "function" ? value.bind(catalog) : value;
    },
  });
}

/** The gateway's root for Pi: its origin and the build's Pi upstream base,
 * ahead of the vendor's public API paths. */
const rootOf = (route) => `${route.gatewayOrigin}${route.base}`;

/** The gateway's models for its serving endpoints under `root`: each served
 * by the protocol its family is verified on, when the endpoint offers it. */
export function gatewayModels(root, endpoints) {
  const models = [];
  for (const endpoint of endpoints) {
    const served = endpoint.config?.served_entities?.[0]?.foundation_model;
    const types = served?.api_types ?? [];
    const protocol = [
      NATIVE[served?.model_class],
      "mlflow/v1/chat/completions",
    ].find((type) => type && types.includes(type));
    if (
      !protocol ||
      endpoint.state?.ready !== "READY" ||
      endpoint.capabilities?.function_calling !== true
    )
      continue;
    const { api, path, compat } = PROTOCOLS[protocol];
    models.push({
      id: endpoint.name,
      name: served.display_name || endpoint.name,
      api,
      provider: GATEWAY,
      baseUrl: `${root}/ai-gateway/${path}`,
      input: endpoint.capabilities.image_input ? ["text", "image"] : ["text"],
      ...GATEWAY_LIMITS,
      ...(compat ? { compat } : {}),
    });
  }
  const provider = createProvider({
    id: GATEWAY,
    name: "Model gateway",
    auth: {
      apiKey: {
        name: "Model gateway",
        resolve: async () => ({
          auth: { apiKey: GATEWAY_KEY },
          source: "gateway",
        }),
      },
    },
    models,
    api: {
      "anthropic-messages": anthropicMessagesApi(),
      "openai-responses": openAIResponsesApi(),
      "openai-completions": openAICompletionsApi(),
    },
  });
  const catalog = createModels();
  catalog.setProvider(provider);
  return catalog;
}

/** A gateway response that drops the access a request was admitted with. */
const refused = (response) =>
  response.status === 401 || response.status === 403;

/** The gateway's serving endpoints under `root`, as the agent's route may
 * see them. A refusal is told to `denied` before it fails. */
export async function discoverGateway(root, headers, signal, denied) {
  const response = await fetch(`${root}/api/2.0/serving-endpoints`, {
    headers: {
      ...headers,
      authorization: `Bearer ${GATEWAY_KEY}`,
      "user-agent": formatUserAgent(),
    },
    signal,
  });
  if (refused(response)) await denied?.();
  if (!response.ok)
    throw new Error(
      `The model gateway did not list models (HTTP ${response.status})`,
    );
  return (await response.json()).endpoints ?? [];
}

/** The final request headers: native ones, less any name the build's
 * header `profile` reserves to Buzz, with the run's own context and the
 * native session for affinity. A conflicting session would win over
 * affinity at the gateway: refused. */
export function composeGateway(profile, assembled, bundle, session) {
  if (typeof session !== "string" || !session)
    throw new Error("Gateway model request has no session");
  if (!profile) throw new Error("Gateway model request has no header profile");
  const names = Object.values(profile.headers);
  for (const name of Object.keys(bundle ?? {}))
    if (!names.includes(name))
      throw new Error(
        "A gateway bundle may only set the profile's context headers",
      );
  const headers = {};
  for (const [name, value] of Object.entries(assembled ?? {})) {
    if (reserved(profile, name)) continue;
    if (CORRELATION.test(name)) {
      if (value != null && value !== session)
        throw new Error(
          `Gateway model request has a conflicting ${name.toLowerCase()} header`,
        );
      continue;
    }
    headers[name] = value;
  }
  return { ...headers, ...bundle, "x-session-affinity": session };
}

const REQUEST = Symbol("buzz.request");
/** The Buzz request a context's durable work serves, if it carries one. */
export const requestOf = (telemetry) => telemetry?.[REQUEST];
/** Telemetry that records nothing and carries only a Buzz request. Pi keeps
 * the carrier in each submission's and task's trace and gives every model
 * call its task's context, so a request's work, its compactions and retries,
 * queued or continued after a restart, carries that request. An input's
 * admission, whose parent is the root, takes its caller's request from its
 * first link only: a later one, as a steer's to its run, never replaces it. */
export function requestTelemetry(request) {
  const propagation = {
    inject: (telemetry) => {
      const carried = requestOf(telemetry);
      return carried === undefined ? undefined : { buzz: carried };
    },
    extract: (carrier) =>
      context(typeof carrier?.buzz === "string" ? carrier.buzz : undefined),
  };
  const context = (request, admission = false) => {
    let linked = false;
    return {
      get [REQUEST]() {
        return request;
      },
      propagation,
      startSpan: async (options, callback) =>
        callback(
          context(
            request,
            request === undefined && options.name === "pi.durable.submit",
          ),
        ),
      addLink(link) {
        if (admission && !linked) request = requestOf(link?.context);
        linked = true;
      },
      addEvent() {},
      setAttributes() {},
      setStatus() {},
    };
  };
  return context(request);
}

/** Models that send every request with its run's Buzz context, after any
 * caller's header transform (protection's review). Requests the gateway's
 * protocols do not cover fail closed. `contextFor` admits each request, at
 * an eligibility revision: a 401 or 403 for it is told to `denied` with
 * that revision before its client sees the response. */
export function routeModels(models, contextFor, denied) {
  const requests = new Set([
    "stream",
    "complete",
    "streamSimple",
    "completeSimple",
  ]);
  const unsupported = new Set([
    "streamDeferred",
    "fetchDeferred",
    "cancelDeferred",
    "generateImages",
    "classify",
  ]);
  return new Proxy(models, {
    get(target, name) {
      if (unsupported.has(name))
        return () => {
          throw new Error(`Gateway mode does not support ${String(name)}`);
        };
      const method = Reflect.get(target, name);
      if (!requests.has(name))
        return typeof method === "function" ? method.bind(target) : method;
      return (model, input, options = {}) => {
        const caller = options.transformHeaders;
        /** The revision this call was admitted at. */
        let revision;
        return method.call(target, model, input, {
          ...options,
          transformHeaders: async (assembled) => {
            const headers = caller ? await caller(assembled) : assembled;
            const admitted = await contextFor(
              options.sessionId,
              options.telemetry,
              options.signal,
            );
            revision = admitted.revision;
            return composeGateway(
              admitted.profile,
              headers,
              admitted.bundle,
              options.sessionId,
            );
          },
          // This call's own: the caller's fetch, else the global one as the
          // client would use it, with the response untouched.
          fetch: async (input, init) => {
            const response = await (options.fetch ?? globalThis.fetch)(
              input,
              init,
            );
            if (refused(response) && revision !== undefined)
              await denied(revision);
            return response;
          },
        });
      };
    },
  });
}

/** Hold all native tool output until reviewed, including streaming progress,
 * diagnostics and thrown errors. Wrapping execute also covers safe replay. */
export function protectTool(tool, inspect, preceding = async () => []) {
  return {
    ...tool,
    async execute(original, api, signalled) {
      const args = structuredClone(original);
      const session = String(api.conversationId);
      const signal = signalled.abortSignal;
      const conversation = structuredClone(await preceding(api, signalled));
      await inspect(
        {
          kind: "tool",
          session,
          content: { title: tool.name, arguments: args, conversation },
          ...(typeof args.command === "string"
            ? { command: args.command }
            : {}),
        },
        signal,
      );
      const decoder = new TextDecoder();
      let text = "",
        bytes = 0,
        details;
      const diagnostics = [];
      const bound = (value) => {
        bytes += Buffer.byteLength(
          typeof value === "string" ? value : JSON.stringify(value),
        );
        if (bytes > 256 * 1024)
          throw new Error("Protected Pi tool output exceeds the review limit");
      };
      let result;
      try {
        result = await tool.execute(
          args,
          {
            ...api,
            outputWindow: undefined,
            output(chunk, skipped) {
              if (skipped)
                throw new Error("Protected Pi cannot review omitted output");
              const value =
                typeof chunk === "string"
                  ? decoder.decode() + chunk
                  : decoder.decode(chunk, { stream: true });
              bound(value);
              text += value;
            },
            retainedOutput: () => ({ text, truncated: false }),
            diagnostic(value) {
              const copy = structuredClone(value);
              bound(copy);
              diagnostics.push(copy);
            },
            async details(value) {
              const copy = structuredClone(value);
              bound(copy);
              details = copy;
            },
          },
          signalled,
        );
        text += decoder.decode();
        result = {
          ...result,
          output: result.output ?? (text ? [{ type: "text", text }] : []),
          diagnostics: [...diagnostics, ...(result.diagnostics ?? [])],
          ...(result.details !== undefined
            ? { details: result.details }
            : details !== undefined
              ? { details }
              : {}),
        };
      } catch (error) {
        if (signal?.aborted)
          throw new Error("Protected Pi action was cancelled");
        result = {
          isError: true,
          output: [
            {
              type: "text",
              text: error instanceof Error ? error.message : String(error),
            },
          ],
        };
      }
      result = structuredClone(result);
      await inspect({ kind: "tool-result", session, content: result }, signal);
      signal?.throwIfAborted();
      return result;
    },
  };
}

const context = BACKGROUND_CONTEXT;
/** Stores a document whole after this many changes, so reading it replays
 * a bounded number of them, as Pi's own Code Mode documents do. */
const checkpointWhen = (_value, _ops, { deltasSinceBase }) =>
  deltasSinceBase >= 64;
/** Each Buzz conversation key's Pi conversation, the tools' default
 * destination for it, and the newest message it has been shown. */
const Places = defineDoc({
  kind: "buzz.places",
  version: 1,
  scope: "session",
  initial: () => ({}),
  checkpointWhen,
});
/** An Attention wake's reply destination belongs to its request, independently
 * of the conversation's tool defaults. Recorded before submission for recovery. */
const Replies = defineDoc({
  kind: "buzz.replies",
  version: 1,
  scope: "session",
  initial: () => ({}),
  checkpointWhen,
});
/** How a request ran, by its request id, for its conversation's transcript:
 * a wake the runner sent without the gateway, which no request row notes.
 * Display only, never model context; recorded before submission. */
const Notices = defineDoc({
  kind: "buzz.notices",
  version: 1,
  scope: "session",
  initial: () => ({}),
  checkpointWhen,
});
/** The entry a noted turn that failed before Pi placed its prompt leaves in
 * its conversation: the notice and that failure. Pi shows a model nothing of
 * an entry of only a kind and data. */
const NOTICE_ENTRY = "buzz.notice";
/** gateway mode: each conversation key's session binding; each key's reset
 * intent, until its next binding replaces it; and each request's Buzz
 * context, recorded before it is submitted, so its work dispatches with it,
 * also continued after a restart. */
const GatewayRuns = defineDoc({
  kind: "buzz.gateway",
  version: 1,
  scope: "session",
  initial: () => ({ places: {}, resets: {}, requests: {} }),
  checkpointWhen,
});
/** Why a request in a conversation Pi parked a task of is unanswered. */
const PARKED = {
  status: "unanswered",
  reason: "restart_limit",
  detail:
    "Pi stopped this turn because it crashed partway through it several times in a row.",
};
/** Messages that arrive while Pi works join its run at the next boundary. */
const SETTINGS = { steeringMode: "all" };
/** Pi's own default thinking level, for a model that thinks. */
const THINKING = "medium";
/** A lock left by a host that was killed is taken over after this long. */
const STALE_MS = 30_000;
const TEST_TIMEOUT_MS = 30_000;
/** How long a gateway refusal waits for the plugin to take it. */
const DENY_MS = 5_000;
/** Entries a transcript reads at a time. */
const PAGE = 200;
/** Buzz tools are `buzz_<name>`, apart from Pi's own `read` and `edit`. */
const PREFIX = "buzz_";
/** The prompt section of the agent's `core` memory. */
const CORE = "core-memory";
const TOOL_NAMES = `The Buzz tools are named \`${PREFIX}<name>\`: where your instructions name a Buzz tool such as \`send\` or \`read\`, call \`${PREFIX}send\` or \`${PREFIX}read\`. The unprefixed \`read\`, \`write\`, \`edit\` and \`bash\` work on files in the workspace.`;

/** A membership key: an agent's pubkey, alone or with its community's
 * percent-encoded host. Mirrors `AGENT_KEY` in features/agents/membership.ts,
 * which this file cannot import. The characters are safe in a file name. */
const AGENT_KEY = /^[0-9a-f]{64}(?:@[A-Za-z0-9._~%-]{1,512})?$/;

/** Pi's folder, shared with the `pi` command: its keys and settings. */
const piDir = () => {
  const dir = process.env.PI_CODING_AGENT_DIR;
  return dir
    ? dir.replace(/^~(?=$|[\\/])/, homedir())
    : join(homedir(), ".pi", "agent");
};

/** Pi's `auth.json`, read and written as the `pi` command does, under the
 * same lock, so keys saved in either work in both. */
export class AuthFile {
  constructor(path) {
    this.path = path;
  }
  async load() {
    let text;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return {};
      throw error;
    }
    const parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error(`${this.path} is not a JSON object`);
    return parsed;
  }
  /** Every entry, read under the lock: `pi` rewrites the file in place. */
  all() {
    return this.locked((all) => all, false);
  }
  async read(id) {
    const credential = (await this.all())[id];
    return credential?.type === "api_key" && credential.key
      ? { ...credential, key: this.resolve(credential.key) }
      : credential;
  }
  async list() {
    return Object.entries(await this.all()).map(([providerId, value]) => ({
      providerId,
      type: value.type,
    }));
  }
  /** As pi-ai's stores do: a change that returns nothing, such as a refresh
   * another process already made, leaves the entry. */
  modify(id, change) {
    return this.locked(async (all) => {
      const next = await change(all[id]);
      if (next !== undefined) all[id] = next;
      return all[id];
    });
  }
  async delete(id) {
    await this.locked((all) => {
      delete all[id];
    });
  }
  /** A key `pi` gets some other way is not used here: a `!command` key would
   * hold every agent the one host serves while it runs, and a `$NAME` or
   * `${NAME}` key reads an environment the desktop app often doesn't have. */
  resolve(key) {
    if (/^(?:!|\$(?:\{\w+\}|\w+)$)/.test(key))
      throw new Error(
        "Buzz doesn't use `!command` or `$NAME` keys from Pi's auth.json. Enter the key in Buzz's Provider and model dialog instead.",
      );
    return key;
  }
  async locked(change, save = true) {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await writeFile(this.path, "{}", { flag: "wx", mode: 0o600 }).catch(
      (error) => {
        if (error.code !== "EEXIST") throw error;
      },
    );
    const release = await lockfile.lock(this.path, {
      realpath: false,
      stale: STALE_MS,
      retries: { retries: 30, minTimeout: 20, maxTimeout: 2_000 },
    });
    try {
      const all = await this.load();
      const result = await change(all);
      if (save)
        await writeFile(this.path, `${JSON.stringify(all, null, 2)}\n`, {
          mode: 0o600,
        });
      return result;
    } finally {
      await release();
    }
  }
}

/** Why a provider that neither Pi nor a Pi package Buzz loaded has can't
 * run, with each package that didn't load. */
const unknownProvider = (id, errors) =>
  [
    `${id} isn't one of Pi's built-in providers, and no Pi package Buzz loaded adds it.`,
    ...errors.map(
      ({ source, error }) =>
        `Pi could not load the package ${source}: ${error.replace(/\.?$/, ".")}`,
    ),
    "Buzz loads the packages in Pi's settings when it starts. Choose another provider in the agent's Identity tab.",
  ].join(" ");

/** The default provider, model and thinking level in Pi's settings. */
async function piDefaults(dir) {
  try {
    const settings = JSON.parse(
      await readFile(join(dir, "settings.json"), "utf8"),
    );
    const text = (value) =>
      typeof value === "string" && value ? value : undefined;
    return {
      provider: text(settings.defaultProvider),
      model: text(settings.defaultModel),
      thinking: text(settings.defaultThinkingLevel),
    };
  } catch {
    return {};
  }
}

/** How long a package has to load before it's left out, so one that hangs
 * doesn't keep every Pi agent from starting. */
const PACKAGE_MS = 30_000;

/** The Pi packages in Pi's settings that have parts for Pi durable: a
 * package lists them as `"pi": { "durable": ["./durable.ts"] }` in its
 * package.json, which the `pi` command ignores. Each one's default export
 * returns the `extensions` every agent runs with and the `providers` added
 * to Pi's. A package that fails is left out, and said why. Only packages in
 * a local folder load for now. */
export async function loadPackages(dir, limit = PACKAGE_MS) {
  const loaded = { extensions: [], providers: [], errors: [] };
  let settings;
  try {
    // As Pi does, with the BOM an editor may save.
    settings = JSON.parse(
      (await readFile(join(dir, "settings.json"), "utf8")).replace(
        /^\uFEFF/,
        "",
      ),
    );
  } catch {
    return loaded;
  }
  const sources = Array.isArray(settings?.packages) ? settings.packages : [];
  if (sources.length) hookPackages();
  // The extensions are checked against what every agent installs, so one
  // that can't install is left out instead of stopping every agent opening.
  // Buzz's own goes in last, under `buzz`.
  const registry = createRegistry();
  registry.install(CodingTools);
  registry.install(createToolSearchExtension());
  for (const item of sources) {
    const source = typeof item === "string" ? item : item?.source;
    const installed = [];
    try {
      if (typeof source !== "string" || /^(?:npm|git|https?|ssh):/.test(source))
        throw new Error("Buzz loads only Pi packages in a local folder");
      const root = resolvePath(dir, source.replace(/^~(?=$|[\\/])/, homedir()));
      // A timer the host waits for: a setup that never settles may hold
      // nothing else that keeps Node running.
      let timer;
      const { extensions, providers } = await Promise.race([
        loadPackage(root),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`It took over ${limit / 1000} seconds`)),
            limit,
          );
        }),
      ]).finally(() => clearTimeout(timer));
      for (const extension of extensions) {
        if (typeof extension?.name !== "string")
          throw new Error("An extension it returns has no name");
        if (
          extension.name === "buzz" ||
          registry.snapshot().extension(extension.name)
        )
          throw new Error(`Another extension is named ${extension.name}`);
        registry.install(extension);
        installed.push(extension);
      }
      if (!providers.every(isProvider))
        throw new Error(
          "A provider it returns needs an id, name, auth and getModels",
        );
      // The host never refreshes models, so a provider whose models come
      // only from `fetchModels` would be missing from the list unexplained.
      const empty = providers.find((provider) => !provider.getModels().length);
      if (empty)
        throw new Error(
          `Provider ${empty.id} lists no models, and Buzz doesn't fetch a provider's models`,
        );
      loaded.extensions.push(...extensions);
      loaded.providers.push(...providers);
    } catch (error) {
      for (const extension of installed) registry.uninstall(extension);
      loaded.errors.push({
        source: String(source),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return loaded;
}

/** Whether a provider has what listing Pi's providers reads, which one made
 * without pi-ai's `createProvider` may lack: without it, the list fails for
 * every agent. */
const isProvider = (provider) =>
  typeof provider?.id === "string" &&
  typeof provider.name === "string" &&
  Boolean(provider.auth?.apiKey || provider.auth?.oauth) &&
  typeof provider.getModels === "function";

/** What the package in a folder adds, from each of its durable entries. */
async function loadPackage(root) {
  const manifest = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  const entries = manifest.pi?.durable ?? [];
  if (!Array.isArray(entries))
    throw new Error('"pi.durable" in its package.json must list files');
  const made = { extensions: [], providers: [] };
  for (const entry of entries) {
    const { default: setup } = await import(
      pathToFileURL(resolvePath(root, entry)).href
    );
    const { extensions = [], providers = [] } = (await setup()) ?? {};
    made.extensions.push(...extensions);
    made.providers.push(...providers);
  }
  return made;
}

/** Packages get Pi's own packages from the host, so what they define is
 * what the host runs, and may be TypeScript, also under `node_modules`,
 * where Node doesn't strip types itself. */
let hooked = false;
function hookPackages() {
  if (hooked) return;
  hooked = true;
  const here = import.meta.url;
  registerHooks({
    resolve(specifier, context, next) {
      if (specifier.startsWith("@earendil-works/"))
        try {
          return next(specifier, { ...context, parentURL: here });
        } catch {}
      return next(specifier, context);
    },
    load(url, context, next) {
      if (!/^file:.*\/node_modules\/.*\.m?ts$/.test(url))
        return next(url, context);
      return {
        format: "module",
        source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), "utf8")),
        shortCircuit: true,
      };
    },
  });
}

/** A message as a transcript and usage show it: no image data or
 * signatures. */
const slim = (message) =>
  Array.isArray(message.content)
    ? {
        ...message,
        content: message.content.map((part) =>
          part.type === "image"
            ? { type: "image" }
            : part.type === "thinking"
              ? { type: "thinking", thinking: part.thinking }
              : part,
        ),
      }
    : message;

const textOf = (message) =>
  (message?.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();

/** What a step shows of a tool call, as Claude's steps do. */
const TARGETS = ["path", "file_path", "pattern", "url", "query", "command"];
const targetOf = (args) => {
  const value = TARGETS.map((key) => args?.[key]).find(
    (item) => typeof item === "string" && item,
  );
  return value && /^(?:\/|[A-Za-z]:[\\/])/.test(value)
    ? value.split(/[\\/]/).at(-1)
    : value;
};

/** Serves the plugin on `input` and `output` until `input` closes. */
export function serve({
  data,
  models,
  packages = { extensions: [], errors: [] },
  protectedAgent,
  dir = piDir(),
  input = process.stdin,
  output = process.stdout,
  exit = () => process.exit(0),
}) {
  /** Each agent's open Harness, by membership key. */
  const agents = new Map();
  /** Agents whose storage failed and that nothing has opened again. */
  const failed = new Set();
  const calls = new Map();
  const reviews = new Map();
  let called = 0;
  const write = (message) => output.write(`${JSON.stringify(message)}\n`);
  const notify = (method, params) => write({ method, params });
  /** Tells the plugin the gateway refused one of the agent's requests at
   * `revision`, waiting for it only so long: the request fails either way. */
  const deny = (agent, revision) =>
    call(
      "gateway",
      { op: "deny", agent, revision },
      AbortSignal.timeout(DENY_MS),
    ).catch((error) =>
      console.error("Pi could not report a gateway refusal", error),
    );
  /** Agents whose refused listing dropped their route's access, until one
   * is listed. A route probed ready again while the gateway still refuses
   * its listing then fails to list, rather than being dropped and probed
   * without end. A late refusal from an older revision drops nothing. */
  const refusals = new Set();
  /** The gateway's models for an agent's eligible route; a refusal is told
   * with the route's revision. */
  const discover = async (agent, route) => {
    const endpoints = await discoverGateway(
      rootOf(route),
      route.discovery,
      AbortSignal.timeout(TEST_TIMEOUT_MS),
      async () => {
        if (refusals.has(agent)) return;
        if ((await deny(agent, route.revision))?.applied === true)
          refusals.add(agent);
      },
    );
    refusals.delete(agent);
    return endpoints;
  };
  const call = (method, params, signal) =>
    new Promise((resolve, reject) => {
      signal?.throwIfAborted();
      const id = `h${++called}`;
      const cancel = () => {
        calls.delete(id);
        write({ method: "security_cancel", params: { id } });
        reject(new Error("Protected Pi action was cancelled"));
      };
      const clear = () => signal?.removeEventListener("abort", cancel);
      calls.set(id, {
        resolve: (value) => {
          clear();
          resolve(value);
        },
        reject: (error) => {
          clear();
          reject(error);
        },
      });
      signal?.addEventListener("abort", cancel, { once: true });
      write({ id, method, params });
    });

  /** The model a turn runs on: the owner's pick, the agent's, or else Pi's
   * default; from the gateway's `catalog` for a turn bound to it, else from
   * Pi's own providers. */
  async function choose({ provider, model, thinking, pick = {} }, catalog) {
    const defaults = await piDefaults(dir);
    const id = provider || defaults.provider;
    const modelId =
      pick.model ||
      model ||
      (id === defaults.provider ? defaults.model : undefined);
    // Never another provider in gateway mode, nor another model.
    if (catalog && id !== GATEWAY)
      throw new Error(
        `${models.getProvider(id)?.name ?? id ?? "Pi's default provider"} is unavailable in gateway mode. Choose a gateway model in the agent's Identity tab.`,
      );
    // A turn the runner sent without the gateway, on a gateway-only model.
    // Pending a product decision: fails visibly, never another model.
    if (!catalog && id === GATEWAY)
      throw new Error(
        "This agent's model is available only through the model gateway, which this turn ran without. Choose another model in its Identity tab, or try again later.",
      );
    catalog ??= models;
    if (id && !catalog.getProvider(id))
      throw new Error(unknownProvider(id, packages.errors));
    if (!id || !modelId)
      throw new Error(
        "This agent has no model. Choose a provider and model in its Identity tab.",
      );
    const found = catalog.getModel(id, modelId);
    if (!found) throw new Error(`Pi has no model ${modelId} from ${id}`);
    return {
      found,
      model: { provider: id, modelId },
      thinkingLevel: clampThinkingLevel(
        found,
        pick.thinking || thinking || defaults.thinking || THINKING,
      ),
    };
  }

  /** Takes the route the plugin resolved for the agent, in place: its
   * conversations, and the runs in them on Pi's own providers, carry on.
   * Its gateway models change only with the route's kind and gateway. With
   * no route, an open agent keeps its own; ordinary work needs none. */
  async function routeTo(opened, route) {
    if (!route) {
      // Nor while another open takes one, or its left gateway runs wait for
      // one.
      if (opened.route || opened.taking || opened.held) return;
      route = { kind: "external" };
    }
    const key =
      route.kind === "external"
        ? "external"
        : `${route.kind} ${route.gatewayOrigin} ${route.identity?.community_id ?? ""}`;
    if (opened.route && opened.routeKey === key) {
      opened.route = route;
      return;
    }
    const taking = Symbol(key);
    opened.taking = taking;
    try {
      const catalog =
        route.kind === "eligible"
          ? gatewayModels(rootOf(route), await discover(opened.agent, route))
          : createModels();
      // Another open took a route while this one discovered.
      if (opened.taking !== taking)
        throw new Error("This agent's model route changed. Try again.");
      opened.catalog = catalog;
      opened.route = route;
      opened.routeKey = key;
      opened.held?.resolve();
      opened.held = undefined;
    } finally {
      if (opened.taking === taking) opened.taking = undefined;
    }
  }

  async function open(agent, lost) {
    if (!AGENT_KEY.test(agent)) throw new Error("Not an agent key");
    if (protectedAgent && agent !== protectedAgent)
      throw new Error("This protected host belongs to another agent");
    const path = join(data, "agents", `${agent}.sqlite`);
    // An agent's storage holds its conversations: only its owner may read
    // it, however an earlier build made it.
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await chmod(dirname(path), 0o700);
    // One host at a time per agent, across every Buzz build here. A lock that
    // a killed host left is taken over once it is stale.
    const release = await lockfile
      .lock(path, {
        realpath: false,
        stale: STALE_MS,
        retries: { retries: 12, minTimeout: 1_000, maxTimeout: 5_000 },
        onCompromised: (error) => {
          console.error("Pi lost its lock on an agent's storage", error);
          lost();
        },
      })
      .catch((error) => {
        throw error.code === "ELOCKED"
          ? new Error("This agent is open in another Buzz app on this computer")
          : error;
      });
    try {
      // SQLite gives the -wal and -shm files it makes the database's mode.
      await writeFile(path, "", { flag: "a", mode: 0o600 });
      for (const file of [path, `${path}-wal`, `${path}-shm`])
        await chmod(file, 0o600).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
      if (
        protectedAgent &&
        (packages.extensions.length || packages.providers?.length)
      )
        throw new Error("Protected Pi does not load user packages");
      const registry = createRegistry();
      const inspect = async (action, signal) => {
        if (
          process.env[
            {
              context: "BUZZ_SECURITY_CONTEXT",
              tool: "BUZZ_SECURITY_TOOL",
              "tool-result": "BUZZ_SECURITY_TOOL_RESULT",
            }[action.kind]
          ] === "0"
        )
          action = {
            kind: action.kind,
            session: action.session,
            content: null,
          };
        const result = await call("security", { agent, action }, signal);
        if (result !== true)
          throw new Error("Pi action denied by its protection policy");
      };
      const install = (extension) => {
        if (
          protectedAgent &&
          (extension.tasks?.length ||
            extension.hooks?.length ||
            extension.wraps?.length)
        )
          throw new Error("Unsupported protected Pi extension");
        registry.install(
          protectedAgent
            ? {
                ...extension,
                tools: extension.tools?.map((tool) =>
                  protectTool(tool, inspect, async (api, context) => {
                    const conversation = await harness.conversation(
                      api.conversationId,
                      context,
                    );
                    if (!conversation)
                      throw new Error(
                        "The tool's preceding conversation is unavailable",
                      );
                    return (await conversation.context(context)).messages;
                  }),
                ),
              }
            : extension,
        );
      };
      const conversations = new Set();
      const sessions = new Map();
      let harness;
      const conversationFor = async (sessionId) => {
        if (typeof sessionId !== "string" || !sessionId)
          throw new Error("Pi model request has no session");
        if (!sessions.has(sessionId)) {
          for (const conversation of conversations) {
            const document = await harness.snapshot(
              ProviderDoc,
              conversation,
              context,
            );
            if (document?.sessionId)
              sessions.set(document.sessionId, conversation);
          }
        }
        if (!sessions.has(sessionId))
          throw new Error("Pi model request has an unknown session");
        return sessions.get(sessionId);
      };
      /** A gateway mode request's Buzz context: that of the Buzz request its
       * durable task serves, as the task's trace carries it, recorded before
       * that request was submitted. Only while the plugin still admits the
       * binding it was made with. */
      const contextFor = async (sessionId, telemetry, signal) => {
        const conversation = await conversationFor(sessionId);
        const request = requestOf(telemetry);
        const record =
          request !== undefined &&
          (await harness.snapshot(GatewayRuns, context))?.requests?.[request];
        if (!record)
          throw new Error("Gateway model request has no Buzz context");
        if (record.conversation !== conversation)
          throw new Error(
            "Gateway model request has another conversation's Buzz context",
          );
        const admitted = await call(
          "gateway",
          { op: "admit", agent, binding: record.binding },
          signal,
        );
        if (admitted?.ok !== true)
          throw new Error(
            admitted?.message || "This agent can't use the model gateway now",
          );
        // The build's profile, which the route this host took carries.
        const profile =
          opened.route?.kind === "eligible" ? opened.route.profile : undefined;
        return { bundle: record.bundle, revision: admitted.revision, profile };
      };
      let opened = { catalog: createModels() };
      const viaGateway = routeModels(
        heldModels(() => opened),
        contextFor,
        (revision) => deny(agent, revision),
      );
      // Only the gateway's provider carries a run's Buzz context; every
      // other is Pi's own, as a turn sent without the gateway runs it.
      const routed = new Proxy(
        {},
        {
          get: (_, name) => {
            const value = Reflect.get(models, name);
            if (typeof value !== "function") return value;
            return (...args) => {
              const [first] = args;
              const target =
                (typeof first === "string" ? first : first?.provider) ===
                GATEWAY
                  ? viaGateway
                  : models;
              return Reflect.get(target, name).apply(target, args);
            };
          },
        },
      );
      install(CodingTools);
      // Loads the Buzz tools that are deferred when the model asks for them.
      install(createToolSearchExtension());
      for (const extension of packages.extensions) install(extension);
      /** Conversations with a task Pi parked, which the next wait stops. */
      const parked = new Set();
      const storage = await openNodeSqliteStorage(path);
      harness = await Harness.open(
        storage,
        {
          models: protectedAgent
            ? protectModels(routed, inspect, conversationFor)
            : routed,
          registry,
          settings: SETTINGS,
          telemetry: requestTelemetry(),
          env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? homedir() }),
          onReport: (error, info) => {
            console.error(`Pi reported ${info.type}`, error);
            // Cut off by crashes too often, a task waits for a retry that
            // Buzz has no way to ask for, and its run would never end.
            if (info.type === "task_parked")
              parked.add(info.task.conversationId);
          },
        },
        context,
      );
      opened = {
        agent,
        harness,
        /** The route the plugin resolved, and the gateway's models for it. */
        route: undefined,
        routeKey: undefined,
        catalog: opened.catalog,
        storage,
        registry,
        install,
        conversations,
        release,
        tools: "",
        /** Each conversation's `core` memory as its latest turn read it,
         * and the note that it has none: its section and the placeholder's.
         * None when that read failed. */
        cores: new Map(),
        /** Each conversation's tool context, for runs resumed after a restart. */
        contexts: new Map(),
        /** Each watched conversation, and whether a run is in it. */
        watched: new Map(),
        /** Deliveries to each conversation key, one after another. */
        queues: new Map(),
        /** Why each request withdrawn with a failed run is unanswered. */
        failed: new Map(),
        parked,
        closing: false,
      };
      const places = (await harness.snapshot(Places, context)) ?? {};
      for (const place of Object.values(places)) {
        conversations.add(place.conversation);
        opened.contexts.set(place.conversation, place.context);
      }
      const live = await harness.inspect(context);
      for (const submission of live.submissions)
        conversations.add(submission.conversationId);
      await prune(harness, live);
      // Read before Pi has scheduled any of them.
      if ((await gatewayWorkOf(harness, live.submissions)).conversations.length)
        opened.held = Promise.withResolvers();
      return opened;
    } catch (error) {
      await release().catch(() => undefined);
      throw error;
    }
  }

  /** The agent's storage, opened once. */
  function opening(agent) {
    let started = agents.get(agent);
    if (!started) {
      // A host that took the storage over runs it now: this one stops, and
      // leaves its runs to it. Opening again says the agent is open there.
      const opened = open(agent, () => {
        forget();
        void opened
          .then(shut, () => undefined)
          .catch((error) =>
            console.error(
              "Pi could not close after losing storage custody",
              error,
            ),
          );
      });
      started = opened;
      failed.delete(agent);
      agents.set(agent, opened);
      const forget = () => {
        if (agents.get(agent) === opened) agents.delete(agent);
      };
      // Storage that fails closes its Harness for good: the next request
      // opens it again.
      void opened.then(
        (ready) =>
          ready.harness.closed.then((end) => {
            if (end.reason !== "failed") return;
            console.error("Pi's storage failed for an agent", end.error);
            if (agents.get(agent) === opened) failed.add(agent);
            forget();
            void shut(ready).catch((error) =>
              console.error("Pi could not close an agent", error),
            );
          }),
        forget,
      );
    }
    return started;
  }

  /** An open agent's gateway models, listed again, when its route is
   * eligible; none when it runs Pi's own providers. */
  async function listed(agent) {
    const opened = await agentOf(agent);
    if (!opened.route)
      throw new Error("This agent's model route is not known yet");
    if (opened.route.kind !== "eligible") return;
    opened.catalog = gatewayModels(
      rootOf(opened.route),
      await discover(agent, opened.route),
    );
    return opened.catalog;
  }

  async function agentOf(agent) {
    const opened = await agents.get(agent);
    if (!opened || opened.closing) throw new Error("The agent is not open");
    return opened;
  }

  /** The agent's Buzz tools, served by the plugin. Those it lists to load on
   * search are deferred: the model finds them with `tool_search`, which
   * `hint` says what it can find with. */
  function buzz(opened, tools, hint) {
    const text = hint ? `${TOOL_NAMES} ${hint}` : TOOL_NAMES;
    return defineExtension({
      name: "buzz",
      sections: [
        section("buzz-tools", () => text),
        // The agent's `core` memory as its conversation was first shown it,
        // so a memory edit sends nothing and its prompt stays as providers
        // cached it, as a Claude session keeps the memory it started with. A
        // compaction shows the memory as it is then, as does a conversation
        // shown none yet or only the note that it has none. Always present,
        // even empty, so it keeps its place before the instructions.
        section(
          CORE,
          ({ conversationId, shown }) => {
            const kept = shown[CORE];
            const core = opened.cores.get(conversationId);
            return kept && kept !== core?.placeholder
              ? kept
              : (core?.text ?? kept ?? "");
          },
          { tag: false },
        ),
      ],
      hooks: protectedAgent
        ? []
        : [
            hook(ToolTask, {
              beforeTool: (input, api, context) =>
                awaitWithContext(
                  call("hook", {
                    agent: opened.agent,
                    conversation: api.conversationId,
                    event: "beforeTool",
                    input,
                  }),
                  context,
                ).then((value) => value ?? undefined),
              afterTool: (input, result, api, context) =>
                awaitWithContext(
                  call("hook", {
                    agent: opened.agent,
                    conversation: api.conversationId,
                    event: "afterTool",
                    input: { call: input, result },
                  }),
                  context,
                ).then((value) => value ?? undefined),
            }),
          ],
      tools: tools.map((tool) =>
        defineTool({
          name: `${PREFIX}${tool.name}`,
          description: tool.description ?? "",
          parameters: tool.inputSchema ?? { type: "object" },
          ...(tool.load === "search" ? { deferred: true } : {}),
          async execute(args, api, signalled) {
            // Given up when the run is stopped, so closing the agent does
            // not wait on Buzz.
            const result = await awaitWithContext(
              call(
                "tool",
                {
                  agent: opened.agent,
                  conversation: api.conversationId,
                  context: opened.contexts.get(api.conversationId) ?? {},
                  name: tool.name,
                  arguments: args,
                },
                signalled.abortSignal,
              ),
              signalled,
            );
            return {
              output: (result.content ?? []).map((part) =>
                part.type === "image" || part.type === "text"
                  ? part
                  : { type: "text", text: JSON.stringify(part) },
              ),
              ...(result.isError ? { isError: true } : {}),
              // A final message answered the run; Pi ends it without another
              // model call, and starts a new one for what arrived meanwhile.
              ...(result.final ? { control: { terminate: true } } : {}),
            };
          },
        }),
      ),
    });
  }

  /** Watches a conversation for its steps, whether it is working, and when
   * each request joins its run. */
  async function watch(opened, conversation) {
    const watched = opened.watched.get(conversation);
    if (watched) return watched;
    const stream = await watchEvents(opened.harness, conversation, context);
    const state = { busy: Boolean(stream.snapshot.run), stream, idle: [] };
    opened.watched.set(conversation, state);
    const send = (event) =>
      notify("event", { agent: opened.agent, conversation, ...event });
    stream.start(async (events) => {
      for (const event of events)
        if (event.type === "run_start") state.busy = true;
        else if (event.type === "run_end") {
          state.busy = false;
          for (const resolve of state.idle.splice(0)) resolve();
        } else if (
          event.type === "submission" &&
          event.record.status === "placed" &&
          event.record.requestId
        )
          send({
            type: "placed",
            request: event.record.requestId,
            entry: event.record.entry,
          });
        else if (event.type === "tool_execution_start")
          send({
            type: "step",
            tool: event.toolName.startsWith(PREFIX)
              ? event.toolName.slice(PREFIX.length)
              : event.toolName,
            target: targetOf(event.args),
          });
        else if (event.type === "message_update")
          for (const change of event.changes)
            if (change.type === "thinking_start")
              send({ type: "step", tool: "Thinking" });
            else if (change.type === "text_start")
              send({ type: "step", tool: "Writing reply" });
    });
    return state;
  }

  async function settle(opened, id) {
    let record;
    try {
      await unpark(opened);
      const submission = await opened.harness.submission(id, context);
      if (!submission) throw new Error("Pi has no record of this request");
      record = await submission.wait(context);
    } catch (error) {
      // Storage that failed closed the Harness, with the run in it: the
      // plugin opens the agent again, and waits for the run there.
      if (error instanceof SessionFailed) {
        await opened.harness.closed;
        return { status: "reopen" };
      }
      if (opened.closing) return { status: "closed" };
      throw error;
    }
    // A one-off turn's conversation, with no place, is not used again.
    if (!opened.contexts.has(record.conversationId))
      opened.cores.delete(record.conversationId);
    if (record.status !== "done") {
      const failed = opened.failed.get(id) ?? {
        status: "unanswered",
        reason: record.reason,
        ...(record.detail ? { detail: String(record.detail) } : {}),
      };
      opened.failed.delete(id);
      if (record.reason !== "aborted")
        await withdraw(opened, record.conversationId, failed);
      return failed;
    }
    const entry = await opened.harness.commit(
      (tx) => tx.entry(AssistantEntry, record.answer),
      context,
    );
    return {
      status: "done",
      answer: record.answer,
      text: textOf(entry?.model?.at(-1)),
    };
  }

  /** Stops the conversations Pi parked a task of: each of their requests
   * fails, saying why. Not waited for, as their tasks run only once a wait
   * asks Pi for progress. */
  async function unpark(opened) {
    if (!opened.parked.size) return;
    const conversations = [...opened.parked];
    opened.parked.clear();
    const { submissions } = await opened.harness.inspect(context);
    for (const { id, conversationId } of submissions)
      if (conversations.includes(conversationId)) opened.failed.set(id, PARKED);
    for (const id of conversations)
      void opened.harness
        .conversation(id, context)
        .then((conversation) =>
          conversation?.abort(context, { background: true }),
        )
        .catch((error) =>
          console.error("Pi could not stop a parked run", error),
        );
  }

  /** A failed run leaves what was queued for it waiting for a later request:
   * it is withdrawn instead, unanswered for the same reason. */
  async function withdraw(opened, conversation, failed) {
    const { submissions } = await opened.harness.inspect(context);
    for (const { id, status, conversationId } of submissions) {
      if (status !== "queued" || conversationId !== conversation) continue;
      opened.failed.set(id, failed);
      const result = await opened.harness.abortSubmission(
        id,
        context,
        conversation,
      );
      if (result !== "aborted") opened.failed.delete(id);
    }
  }

  /** The session `conversation` is in at entry `at`, or now: the id of the
   * reset that began it, or 0 before any reset. Read from Pi's own head
   * markers, so it always agrees with the history: a compaction's marker
   * leads back to the one before it. Only markers are read, never the
   * history between them. */
  async function sessionOf(storage, conversation, at) {
    let head = await storage.findLatestHeadMarker(conversation, at, context);
    while (head && head.kind !== "pi.reset")
      head = await storage.findLatestHeadMarker(
        conversation,
        head.head,
        context,
      );
    return head?.id ?? 0;
  }
  /** Whether the next turn is its session's first: no compaction since the
   * session began, no prompt in it, and none queued. A prompt follows its
   * reset closely, so only the entries before the first one are read. */
  async function firstTurn({ harness, storage }, conversation) {
    const head = await storage.findLatestHeadMarker(
      conversation,
      undefined,
      context,
    );
    if (head && head.kind !== "pi.reset") return false;
    const query = { conversationId: conversation, order: "ascending" };
    if (head) query.minEntryId = head.head;
    let cursor;
    do {
      const page = await storage.scanEntries(query, 20, cursor, context);
      if (page.items.some((entry) => entry.kind === "pi.user")) return false;
      cursor = page.next;
    } while (cursor);
    const { submissions } = await harness.inspect(context);
    return !submissions.some((s) => s.conversationId === conversation);
  }

  /** Records a gateway mode request's binding and Buzz context before it is
   * submitted, with its reply destination, in one commit. One already
   * recorded, by a host that stopped before submitting it, is kept. A
   * `manual` request, an owner's compaction, binds its key's session as it
   * is and changes nothing of the key's. */
  async function bind(
    opened,
    turn,
    { key, fresh, gatewayTurn, reply, notice, conversation, manual },
  ) {
    const { request } = turn;
    const { harness } = opened;
    const doc = (await harness.snapshot(GatewayRuns, context)) ?? {};
    let reset = key && !manual && doc.resets?.[key];
    let persist;
    // A request asked again keeps the mode it was bound in: one bound to the
    // gateway never runs without it.
    let record = doc.requests?.[request];
    if (record && reset) {
      // A reset since it was recorded makes it the reset's first request,
      // unless Pi has it already: its run keeps its binding, and the reset
      // waits for the next.
      if (
        await opened.storage.submissionByRequest(conversation, request, context)
      )
        reset = undefined;
      else record = undefined;
    }
    // Only a turn the runner sent through the gateway binds.
    if (gatewayTurn && !record) {
      if (opened.route?.kind !== "eligible")
        throw new Error("This agent's model route changed. Try again.");
      // A model gateway mode refuses binds nothing; an owner's compaction
      // keeps the model its conversation has.
      if (!manual) await choose(turn, opened.catalog);
      const bound = await call("gateway", {
        op: "bind",
        agent: opened.agent,
        event:
          !key && !manual
            ? "standalone"
            : fresh
              ? "new_generation"
              : reset
                ? "reset"
                : "resume",
        saved: key ? doc.places?.[key] : undefined,
        turn: gatewayTurn,
      });
      if (bound?.ok !== true)
        throw new Error(
          bound?.message || "This agent can't use the model gateway now",
        );
      record = {
        conversation,
        binding: bound.binding,
        bundle: bound.bundle,
        ...(manual ? { manual } : {}),
      };
      // The key's session from now on; a record kept from before has its
      // own, which its first commit published with it.
      if (key && !manual && bound.persist) persist = bound.binding;
    }
    // A reset is done once its key has the binding that replaces it: a turn
    // without the gateway binds nothing, and leaves it for the next.
    if (!record) reset = undefined;
    if (!record && !reply && !notice) return false;
    await harness.commit(async (tx) => {
      const doc = await tx.doc(GatewayRuns);
      if (record) {
        if (persist) doc.places[key] = persist;
        doc.requests[request] = record;
      }
      if (reset) delete doc.resets[key];
      if (reply) (await tx.doc(Replies))[request] = reply;
      if (notice) (await tx.doc(Notices))[request] = { conversation, notice };
    }, context);
    return Boolean(record);
  }

  /** The conversations of these unfinished submissions that run through the
   * gateway, and the requests in them. */
  async function gatewayWorkOf(harness, submissions) {
    const conversations = new Map();
    const requests = [];
    for (const { conversationId, requestId } of submissions) {
      if (!conversations.has(conversationId)) {
        const found = await harness.conversation(conversationId, context);
        conversations.set(
          conversationId,
          Boolean(found && (await gatewayRun(found))),
        );
      }
      if (conversations.get(conversationId) && requestId)
        requests.push(requestId);
    }
    return {
      conversations: [...conversations]
        .filter(([, gateway]) => gateway)
        .map(([id]) => id),
      requests,
    };
  }

  /** Forgets the Buzz context of requests no durable work carries any
   * longer, read from a complete picture of that work taken before Pi has
   * scheduled any: a submitted request's once its submission settled and no
   * task's trace has it, a manual one's once none has it. One not yet
   * submitted, by a host that stopped before submitting it, is kept. */
  async function prune(harness, { scheduling, tasks, submissions }) {
    if (scheduling !== "paused") return;
    const carried = new Set();
    for (const { record } of tasks)
      for (const trace of [record.trace, ...(record.links ?? [])])
        if (typeof trace?.buzz === "string") carried.add(trace.buzz);
    for (const submission of submissions) {
      if (submission.requestId) carried.add(submission.requestId);
      if (typeof submission.trace?.buzz === "string")
        carried.add(submission.trace.buzz);
    }
    const { requests } = (await harness.snapshot(GatewayRuns, context)) ?? {};
    if (!requests) return;
    const stale = Object.keys(requests).filter((r) => !carried.has(r));
    if (!stale.length) return;
    await harness.commit(async (tx) => {
      const doc = await tx.doc(GatewayRuns);
      for (const request of stale) {
        const record = doc.requests[request];
        if (
          record &&
          (!record.conversation ||
            record.manual ||
            (await tx.submissionByRequest(record.conversation, request)))
        )
          delete doc.requests[request];
      }
    }, context);
  }

  /** Completes a key's `new` session: its reset intent's write, submitted
   * once by its request id, so asking again submits nothing more. The
   * intent stays until the key's next binding replaces it. */
  async function resetPending(harness, conversation, key) {
    const reset = (await harness.snapshot(GatewayRuns, context))?.resets?.[key];
    if (!reset) return;
    await conversation.submit(
      {
        type: "write",
        entry: { kind: ResetEntry.kind, head: "self" },
        requestId: reset.request,
      },
      context,
    );
  }

  /** Whether the conversation's runs go through the gateway: its model is
   * the gateway's, as each turn not steering configures it. */
  async function gatewayRun(conversation) {
    return (await conversation.agent(context)).model?.provider === GATEWAY;
  }

  /** Waits until the conversation holds no unfinished input in the other
   * mode than `bound`, read from Pi's storage; whether it holds any, in the
   * same mode, decides that the turn steers. A waiter is listed before each
   * read, so a run that ends during it still wakes it; a closing agent ends
   * the wait. */
  async function settledMode(opened, conversation, state, bound) {
    for (;;) {
      const ended = new Promise((resolve) => state.idle.push(resolve));
      if (opened.closing) throw new Error("This agent was closed.");
      const { submissions } = await opened.harness.inspect(context);
      const busy = submissions.some(
        (s) => s.type === "input" && s.conversationId === conversation.id,
      );
      if (!busy || (await gatewayRun(conversation)) === bound) return busy;
      await ended;
    }
  }

  /** Starts a request in a conversation configured for this turn. One that
   * steers a run working in it, `busy`, changes only what its owner picked,
   * as in Claude. The agent's `core` memory read for it is the
   * conversation's latest; a failed read shows it none if not yet shown. */
  async function submit(opened, conversation, turn, busy, bound, refresh) {
    opened.cores.set(conversation.id, turn.core);
    const steers = busy && turn.steer;
    const chosen = await choose(turn, bound ? opened.catalog : undefined);
    const change = steers
      ? {
          ...(turn.pick?.model ? { model: chosen.model } : {}),
          ...(turn.pick?.thinking
            ? { thinkingLevel: chosen.thinkingLevel }
            : {}),
        }
      : {
          model: chosen.model,
          thinkingLevel: chosen.thinkingLevel,
          instructions: turn.instructions,
          cwd: turn.cwd.replace(/^~(?=$|[\\/])/, homedir()),
        };
    if (Object.keys(change).length)
      await conversation.configure(change, context);
    if (refresh) {
      const prompt = await refresh();
      if (!prompt) return;
      turn = { ...turn, ...prompt };
    }
    // Its work carries its request: see `requestTelemetry`.
    const submission = await conversation.submit(
      {
        type: "input",
        content: steers ? turn.steer : turn.text,
        whenBusy: "steer",
        requestId: turn.request,
      },
      withTelemetry(requestTelemetry(turn.request), context),
    );
    return { submission: submission.id, conversation: conversation.id };
  }

  const methods = {
    async review(turn) {
      if (protectedAgent)
        throw new Error("Security inference runs outside requesting workers");
      if (
        typeof turn.id !== "string" ||
        reviews.has(turn.id) ||
        reviews.size >= 16 ||
        !turn.prompt ||
        typeof turn.prompt.system !== "string" ||
        typeof turn.prompt.input !== "string" ||
        Buffer.byteLength(JSON.stringify(turn.prompt)) > 768 * 1024
      )
        throw new Error("Invalid security review request");
      const controller = new AbortController();
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(TEST_TIMEOUT_MS),
      ]);
      reviews.set(turn.id, controller);
      try {
        const { found, model } = await choose(turn);
        signal.throwIfAborted();
        const reply = await models.completeSimple(
          found,
          {
            // Pi's models have no response-format option and cannot be made to
            // call a tool, so the schema can only be stated in the prompt.
            systemPrompt: turn.prompt.outputSchema
              ? `${turn.prompt.system}\n\nReply with only JSON that matches this JSON Schema, and no other text:\n${JSON.stringify(turn.prompt.outputSchema)}`
              : turn.prompt.system,
            messages: [
              {
                role: "user",
                content: turn.prompt.input,
                timestamp: Date.now(),
              },
            ],
          },
          { maxTokens: 1024, maxRetries: 0, signal },
        );
        signal.throwIfAborted();
        if (reply.stopReason === "error" || reply.stopReason === "aborted")
          throw new Error(
            reply.errorMessage || "Security model did not answer",
          );
        return {
          text: reply.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join(""),
          model: { provider: model.provider, id: model.modelId },
        };
      } finally {
        reviews.delete(turn.id);
      }
    },
    "cancel-review"({ id }) {
      reviews.get(id)?.abort();
    },
    runtime() {
      if (protectedAgent)
        throw new Error("Protected hosts cannot bootstrap another host");
      const file = fileURLToPath(import.meta.url),
        node = realpathSync(process.execPath);
      return {
        file,
        node,
        codeRoot: dirname(dirname(file)),
        nodeRoot: dirname(dirname(node)),
        data,
        auth: dir,
      };
    },
    /** Pi's providers; for an agent in gateway mode, the gateway's, with every
     * other one listed as unavailable. */
    async providers({ agent } = {}) {
      const gated = agent && (await listed(agent));
      const providers = [];
      if (gated)
        providers.push({
          id: GATEWAY,
          name: "Model gateway",
          key: false,
          signsIn: false,
          configured: "gateway",
        });
      for (const provider of models.getProviders()) {
        if (!models.getModels(provider.id).length) continue;
        const auth = await models.checkAuth(provider.id).catch(() => undefined);
        providers.push({
          id: provider.id,
          name: provider.name,
          key: Boolean(provider.auth.apiKey),
          signsIn: Boolean(provider.auth.oauth),
          ...(auth ? { configured: auth.source ?? auth.type } : {}),
          ...(gated ? { unavailable: "Unavailable in gateway mode" } : {}),
        });
      }
      // The gateway, the only one a gated agent may use, first; then by name.
      providers.sort(
        (a, b) =>
          Number(a.id !== GATEWAY) - Number(b.id !== GATEWAY) ||
          a.name.localeCompare(b.name),
      );
      return { providers, defaults: await piDefaults(dir) };
    },
    /** What Pi's settings pick now, which the `pi` command changes. */
    defaults() {
      return piDefaults(dir);
    },
    async models({ provider, agent }) {
      const gated = agent && (await listed(agent));
      if (gated && provider !== GATEWAY) return [];
      return (gated || models).getModels(provider).map((model) => ({
        id: model.id,
        name: model.name,
        thinking: getSupportedThinkingLevels(model),
      }));
    },
    /** Saves a key with Pi's own login for the provider, which takes only a
     * key here: one that asks for more is set up with `pi`. */
    async login({ provider, key }) {
      const name = models.getProvider(provider)?.name ?? provider;
      let given = false;
      await models.login(provider, "api_key", {
        signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
        notify() {},
        async prompt(prompt) {
          if (prompt.type === "secret" && !given) {
            given = true;
            return key;
          }
          throw new Error(
            `${name} needs more than an API key. Set it up with the pi command's /login, then choose it here.`,
          );
        },
      });
    },
    /** Asks the model for one short reply. */
    async test(turn) {
      if (protectedAgent)
        throw new Error(
          "Test providers in Pi setup, outside the protected worker",
        );
      const { found, model } = await choose(turn);
      const reply = await models.completeSimple(
        found,
        {
          messages: [
            { role: "user", content: "Reply with OK.", timestamp: Date.now() },
          ],
        },
        {
          maxTokens: 32,
          maxRetries: 0,
          signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
        },
      );
      return reply.stopReason === "error" || reply.stopReason === "aborted"
        ? {
            ok: false,
            message: reply.errorMessage || "The provider did not answer",
          }
        : { ok: true, message: `Connected to ${model.modelId}` };
    },
    /** Opens the agent's storage, once, with its Buzz tools as they are now. */
    async open({ agent, tools, hint, route }) {
      const opened = await opening(agent);
      await routeTo(opened, route);
      // Held for runs that have since ended.
      if (opened.held) {
        const { submissions } = await opened.harness.inspect(context);
        if (
          !(await gatewayWorkOf(opened.harness, submissions)).conversations
            .length
        ) {
          opened.held.resolve();
          opened.held = undefined;
        }
      }
      const listed = JSON.stringify([tools, hint]);
      if (opened.tools !== listed) {
        opened.install(buzz(opened, tools, hint));
        opened.tools = listed;
      }
      // Whether it has the gateway's models, which its gateway runs need,
      // and whether runs it left wait for them.
      return {
        gateway: opened.route?.kind === "eligible",
        held: Boolean(opened.held),
      };
    },
    /** The agent's Buzz conversations: each key's Pi conversation, and the
     * newest message it has been shown. Storage opened only to be read runs
     * nothing: Pi durable resumes work only when asked for progress. */
    async places({ agent }) {
      const { harness } = await opening(agent);
      const places = (await harness.snapshot(Places, context)) ?? {};
      return {
        places: Object.entries(places).map(([key, place]) => ({
          key,
          conversation: place.conversation,
          seen: place.seen,
        })),
      };
    },
    /** The unfinished work running through the gateway: its conversations,
     * and the requests in them, which a route change ends. */
    async gatewayWork({ agent }) {
      const opened = await agents.get(agent)?.catch(() => undefined);
      if (!opened || opened.closing) return { conversations: [], requests: [] };
      const { submissions } = await opened.harness.inspect(context);
      return gatewayWorkOf(opened.harness, submissions);
    },
    /** A page of a conversation's entries, newest first, as a transcript
     * shows them. */
    async entries({ agent, conversation, cursor }) {
      const { harness, storage } = await opening(agent);
      const found = await harness.conversation(conversation, context);
      if (!found) return { entries: [] };
      const page = await found.entries({}, PAGE, cursor, context);
      const oldest = page.items.at(-1);
      // Each noted request's own prompt entry, once Pi placed it.
      const noted = new Map();
      const notices = (await harness.snapshot(Notices, context)) ?? {};
      for (const [request, { conversation: id, notice }] of Object.entries(
        notices,
      )) {
        if (id !== found.id) continue;
        const submission = await storage.submissionByRequest(
          found.id,
          request,
          context,
        );
        if (submission?.entry !== undefined)
          noted.set(submission.entry, notice);
      }
      return {
        // The session the page's oldest entry is in, however old its reset.
        ...(oldest
          ? { session: await sessionOf(storage, found.id, oldest.id) }
          : {}),
        entries: page.items.map(({ id, kind, model, data }) => ({
          id,
          kind,
          ...(noted.has(id) && { notice: noted.get(id) }),
          ...(kind === NOTICE_ENTRY && {
            notice: data.notice,
            error: data.error,
            at: data.at,
          }),
          // Pi writes this result itself for a call an abort cut off.
          ...(data?.diagnostics?.some?.((d) => d.code === "aborted") && {
            aborted: true,
          }),
          // System entries hold every tool's schema; a transcript shows none.
          ...(model && kind !== "pi.system" ? { model: model.map(slim) } : {}),
        })),
        ...(page.next ? { next: page.next } : {}),
      };
    },
    /** The native conversation snapshot used for a final publication review. */
    async protectionContext({ agent, conversation }) {
      const { harness } = await agentOf(agent);
      const found = await harness.conversation(conversation, context);
      if (!found) throw new Error("The protected conversation is unavailable");
      return structuredClone((await found.context(context)).messages);
    },
    /** The usage Pi recorded for a conversation, by `<provider>/<model>`:
     * its answers', and the requests that left no answer, such as
     * compaction's. */
    async recorded({ agent, conversation }) {
      const { harness } = await opening(agent);
      const state = await harness.snapshot(UsageDoc, conversation, context);
      return { models: state?.models ?? {} };
    },
    /** The newest message a conversation key's Pi conversation has been
     * shown; 0 when it has none yet. */
    async place({ agent, key }) {
      const { harness } = await agentOf(agent);
      const place = (await harness.snapshot(Places, context))?.[key];
      return {
        seen:
          place && (await harness.conversation(place.conversation, context))
            ? place.seen
            : 0,
      };
    },
    /** A turn for a conversation key: its Pi conversation, made the first
     * time, takes the request, or steers its run if one is working. */
    async deliver({
      agent,
      key,
      at,
      context: tools,
      reply,
      notice,
      refresh,
      gatewayTurn,
      ...turn
    }) {
      const opened = await agentOf(agent);
      const prior = opened.queues.get(key);
      const delivered = (async () => {
        await prior?.catch(() => undefined);
        const { harness } = opened;
        const place = (await harness.snapshot(Places, context))?.[key];
        let conversation =
          place && (await harness.conversation(place.conversation, context));
        const fresh = !conversation;
        if (!conversation) {
          conversation = await harness.createConversation(
            { ownership: { kind: "ownerless" } },
            context,
          );
          // Recorded before it has the turn, so a host that stops before it
          // answers leaves the next one the conversation to find the turn in,
          // by its request, when it is asked again.
          await harness.commit(async (tx) => {
            const places = await tx.doc(Places);
            places[key] = {
              conversation: conversation.id,
              context: tools,
              seen: 0,
            };
          }, context);
        }
        opened.conversations.add(conversation.id);
        opened.contexts.set(conversation.id, tools);
        const state = await watch(opened, conversation.id);
        // Recorded once Pi has the turn: one that could not start leaves the
        // messages it would have been shown for the next.
        const placed = async (submitted) => {
          await harness.commit(async (tx) => {
            const places = await tx.doc(Places);
            places[key] = {
              conversation: conversation.id,
              context: tools,
              seen: Math.max(at, places[key]?.seen ?? 0),
            };
          }, context);
          return submitted;
        };
        // A request Pi has already is answered by its own submission, in the
        // mode it ran in: asked again, it binds and configures nothing. Its
        // run, continuing, reads the memory and messages it was given.
        const held = await opened.storage.submissionByRequest(
          conversation.id,
          turn.request,
          context,
        );
        if (held) {
          opened.cores.set(conversation.id, turn.core);
          return placed({ submission: held.id, conversation: conversation.id });
        }
        try {
          await resetPending(harness, conversation, key);
          const taken = opened.routeKey;
          const bound = await bind(opened, turn, {
            key,
            fresh,
            gatewayTurn,
            reply,
            notice,
            conversation: conversation.id,
          });
          // A run steers only with a turn of its own mode: one through the
          // gateway, or not, starts once Pi holds no work in the other mode.
          // What Pi holds is read from its storage, not from the runs it has
          // been seen to start, which a turn just dispatched may not be yet.
          const busy = await settledMode(opened, conversation, state, bound);
          // Bound on a route the agent left while it waited: never sent. Its
          // record keeps it in the gateway's mode if it is asked again.
          if (bound && opened.routeKey !== taken)
            throw new Error("This agent's model route changed. Try again.");
          // Read before the turn is submitted: what Pi then holds decides it.
          const session =
            !busy && (await firstTurn(opened, conversation.id))
              ? await sessionOf(opened.storage, conversation.id)
              : undefined;
          const submitted = await submit(
            opened,
            conversation,
            turn,
            busy,
            bound,
            refresh
              ? () => call("prompt", { agent, request: turn.request })
              : undefined,
          );
          if (!submitted) {
            // Withdrawn before Pi had it: nothing will dispatch for it.
            await harness.commit(async (tx) => {
              delete (await tx.doc(GatewayRuns)).requests[turn.request];
              delete (await tx.doc(Notices))[turn.request];
            }, context);
            return false;
          }
          if (session !== undefined) Object.assign(submitted, { session });
          return placed(submitted);
        } catch (error) {
          // A noted turn that failed before Pi placed its prompt shows its
          // notice beside that failure, in an entry no model sees.
          if (notice)
            await conversation
              .submit(
                {
                  type: "write",
                  entry: {
                    kind: NOTICE_ENTRY,
                    data: {
                      notice,
                      error: error?.message ?? String(error),
                      at: Date.now(),
                    },
                  },
                },
                context,
              )
              .catch(() => undefined);
          throw error;
        }
      })();
      opened.queues.set(key, delivered);
      const done = () => {
        if (opened.queues.get(key) === delivered) opened.queues.delete(key);
      };
      void delivered.then(done, done);
      return delivered;
    },
    /** A one-off turn in a conversation of its own, with no default
     * destination for its tools. Nothing watches it: it has no other
     * requests, and no Activity. */
    async once({ agent, gatewayTurn, ...turn }) {
      const opened = await agentOf(agent);
      const conversation = await opened.harness.createConversation(
        { ownership: { kind: "ownerless" } },
        context,
      );
      const bound = await bind(opened, turn, {
        gatewayTurn,
        conversation: conversation.id,
      });
      opened.conversations.add(conversation.id);
      return submit(opened, conversation, turn, false, bound);
    },
    /** The requests of runs Pi has not finished, with where each one's tools
     * default to when the agent has a place for its conversation; a one-off
     * turn's has none. A host that stopped leaves them; a later delivery or
     * wait, for any conversation, continues all of them. */
    async unfinished({ agent }) {
      const opened = await agentOf(agent);
      const { submissions } = await opened.harness.inspect(context);
      const replies = (await opened.harness.snapshot(Replies, context)) ?? {};
      return {
        submissions: submissions.flatMap(
          ({ id, type, conversationId, requestId }) => {
            const place = opened.contexts.get(conversationId);
            // A reset intent's write has a request id too.
            return requestId && type === "input"
              ? [
                  {
                    submission: id,
                    conversation: conversationId,
                    request: requestId,
                    ...(replies[requestId]
                      ? { reply: replies[requestId] }
                      : {}),
                    ...(place ? { context: place } : {}),
                  },
                ]
              : [];
          },
        ),
      };
    },
    /** Ends runs without continuing them, and without running any of Pi's
     * work first, as aborting a conversation would: a queued request is
     * withdrawn, and a placed one's run is marked aborted, which it ends with
     * once Pi runs again. */
    async drop({ agent, submissions }) {
      const { harness } = await agentOf(agent);
      const { tasks } = await harness.inspect(context);
      for (const { submission, conversation } of submissions) {
        const result = await harness.abortSubmission(
          submission,
          context,
          conversation,
        );
        if (result !== "already_placed") continue;
        for (const { record } of tasks)
          if (
            record.conversationId === conversation &&
            !record.owner &&
            !record.background
          )
            await harness.abortTask(record.id, context);
      }
    },
    /** How a request settled: its answer's text, or why it has none. */
    async wait({ agent, submission, request }) {
      // Its run is in Pi's storage: the plugin opens the agent again.
      if (failed.has(agent)) return { status: "reopen" };
      const opened = await agentOf(agent);
      const result = await settle(opened, submission);
      if (
        request &&
        (result.status === "done" || result.status === "unanswered")
      ) {
        try {
          // Its Buzz context stays while its work may still dispatch, as a
          // compaction it left: `prune` forgets it.
          await opened.harness.commit(async (tx) => {
            delete (await tx.doc(Replies))[request];
          }, context);
        } catch (error) {
          console.warn("Pi could not clear a wake's reply destination", error);
        }
      }
      return result;
    },
    async abort({ agent, conversation }) {
      const { harness } = await agentOf(agent);
      await (await harness.conversation(conversation, context))?.abort(context);
    },
    /** A session control on a conversation key's Pi conversation, if it has
     * one: `interrupt` aborts its run and any compaction, `compact` summarizes
     * it and settles once the summary is placed, and `new` starts a new
     * context, shown the whole Buzz conversation at its next turn. */
    async session({ agent, key, action, gatewayTurn }) {
      const opened = await agentOf(agent);
      const { harness } = opened;
      const find = async () => {
        const place = (await harness.snapshot(Places, context))?.[key];
        return (
          place && (await harness.conversation(place.conversation, context))
        );
      };
      if (action === "interrupt") return (await find())?.abort(context);
      // After the key's deliveries, so none binds across the reset, and
      // one making its conversation has.
      const prior = opened.queues.get(key);
      const acted = (async () => {
        await prior?.catch(() => undefined);
        const conversation = await find();
        if (!conversation) return;
        if (action === "new") {
          // Intended in one commit with what the next turn is shown, then
          // done: a host that stops between them does it at the next.
          await harness.commit(async (tx) => {
            const places = await tx.doc(Places);
            if (places[key]) places[key] = { ...places[key], seen: 0 };
            (await tx.doc(GatewayRuns)).resets[key] = {
              request: `reset/${randomUUID()}`,
            };
          }, context);
          return resetPending(harness, conversation, key);
        }
        await resetPending(harness, conversation, key);
        // The compaction's own request, which its task's trace carries.
        const request = `manual/${randomUUID()}`;
        await bind(
          opened,
          { request },
          { key, gatewayTurn, conversation: conversation.id, manual: true },
        );
        return conversation.compact(
          undefined,
          withTelemetry(requestTelemetry(request), context),
        );
      })();
      opened.queues.set(key, acted);
      const done = () => {
        if (opened.queues.get(key) === acted) opened.queues.delete(key);
      };
      void acted.then(done, done);
      const task = await acted;
      if (action === "new" || task === undefined) return;
      const { outcome } = (await harness.waitForTask(task, context)).state;
      if (outcome.status === "failed") throw new Error(outcome.error.message);
      if (outcome.status !== "completed") return;
      const { submissionId } = outcome.result;
      if (submissionId !== undefined)
        await (await harness.submission(submissionId, context))?.wait(context);
    },
    /** Closes the agent's storage. Unfinished runs stay, and continue when it
     * opens again. */
    async close({ agent }) {
      const opening = agents.get(agent);
      await shut(await opening?.catch(() => undefined));
      agents.delete(agent);
      failed.delete(agent);
    },
  };

  async function shut(opened) {
    if (!opened) return;
    if (!opened.closing)
      opened.closing = (async () => {
        for (const { stream, idle } of opened.watched.values()) {
          for (const resolve of idle.splice(0)) resolve();
          await stream.stop();
        }
        await opened.harness.close(context);
        // A compromised lock may already be released. Native execution has
        // ended above; releasing ownership is cleanup, not its acknowledgement.
        await opened.release().catch(() => undefined);
      })();
    await opened.closing;
  }

  async function handle({ id, method, params }) {
    try {
      const run = methods[method];
      if (!run) throw new Error(`Unknown method ${method}`);
      write({ id, result: (await run(params ?? {})) ?? {} });
    } catch (error) {
      write({
        id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  let stopping;
  const stop = () => {
    for (const review of reviews.values()) review.abort();
    stopping ??= Promise.allSettled(
      [...agents.values()].map((opening) =>
        opening.then(shut, () => undefined),
      ),
    ).finally(exit);
    return stopping;
  };
  const lines = createInterface({ input });
  lines.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.method) void handle(message);
    else {
      const pending = calls.get(message.id);
      calls.delete(message.id);
      if (message.error) pending?.reject(new Error(message.error));
      else pending?.resolve(message.result);
    }
  });
  // The plugin closes stdin to stop the host; each agent's storage closes
  // first, so the next host can open it at once.
  lines.on("close", stop);
  notify("ready", {});
  return { stop };
}

if (process.env.BUZZ_PI_HOST === "1") {
  const dir = piDir();
  const models = builtinModels({
    credentials: new AuthFile(join(dir, "auth.json")),
  });
  const packages = await loadPackages(dir);
  for (const provider of packages.providers) models.setProvider(provider);
  for (const { source, error } of packages.errors)
    console.error(`Pi could not load the package ${source}: ${error}`);
  const { stop } = serve({ data: process.argv[1], models, packages, dir });
  process.on("SIGTERM", stop);
}
