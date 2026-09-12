// ACP presentation adapter, adapted from block/buzz@9bab300 examples/realtime-audio/server.mjs.
// Apache-2.0. Buzz owns provider protocol, tools and permission decisions.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { getPublicKey } from "nostr-tools";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createBestieIdentity } from "./bestie-identity.mjs";
import { relayOrigin } from "../src/features/communities/destination.ts";

const FRAME_BYTES = 2 * 1024 * 1024;
const REQUEST_BYTES = 256 * 1024;
const THINKING = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const MEDIA = "_buzz/unstable/realtime/";
const METHODS = new Set([
  "initialize",
  "session/new",
  "session/prompt",
  "session/cancel",
  ...["append", "playback", "interrupt", "close"].map((name) => MEDIA + name),
]);

export function validateRealtimeEndpoint(value) {
  try {
    if (typeof value !== "string" || value.length > 4096 || /\s/.test(value))
      throw Error();
    const url = new URL(value);
    if (
      !["ws:", "wss:"].includes(url.protocol) ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.hash
    )
      throw Error();
    return url.href;
  } catch {
    throw Error(
      "BUZZ_REALTIME_ENDPOINT must be a ws:// or wss:// URL without credentials or a fragment.",
    );
  }
}

function json(res, status, data) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}

async function write(stream, bytes) {
  if (stream.destroyed || stream.writableEnded) throw Error("Stream closed");
  if (stream.write(bytes)) return;
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      stream.off("drain", drained);
      stream.off("close", closed);
      stream.off("error", closed);
    };
    const drained = () => {
      cleanup();
      resolve();
    };
    const closed = () => {
      cleanup();
      reject(Error("Stream closed"));
    };
    const timer = setTimeout(closed, 2000);
    stream.once("drain", drained);
    stream.once("close", closed);
    stream.once("error", closed);
  });
}

function callToken(value) {
  return typeof value === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
      value,
    )
    ? value.toLowerCase()
    : undefined;
}

const requestId = (value) => Number.isSafeInteger(value) && value >= 0;
const permissionId = (value) =>
  requestId(value) || (typeof value === "string" && value.length <= 128);

/** Called only behind the relay broker's same-origin and registered-community guards. */
export function createBestieRealtime({
  endpoint,
  apiKey = "",
  model = "realtime",
  agentPath = "buzz-agent",
  mcpPath = "buzz-dev-mcp",
  ownerKey,
  stateDirectory = join(homedir(), ".buzz", "bestie"),
  identity = createBestieIdentity({
    ownerKey,
    directory: join(stateDirectory, "identities"),
  }),
  spawnAgent = spawn,
  stopTimeoutMs = 2000,
  callTimeoutMs = 60 * 60 * 1000,
} = {}) {
  const provider = validateRealtimeEndpoint(endpoint);
  const viewer = getPublicKey(ownerKey);
  if (!model || model.length > 256 || /[\r\n\0]/.test(model))
    throw Error("Invalid realtime model configuration.");
  let active;
  let closed = false;
  const retired = new Set();
  const authorizations = new Map();
  const live = (entry) => !closed && active === entry && !entry.stopping;

  function stop(entry) {
    if (entry.stopping) return entry.stopping;
    clearTimeout(entry.timer);
    entry.permissions.clear();
    entry.pending.clear();
    retired.add(entry.token);
    if (retired.size > 256) retired.delete(retired.values().next().value);
    entry.res.end();
    entry.stopping = new Promise((resolve) => {
      const child = entry.child;
      if (!child) {
        resolve();
        return;
      }
      const signal = (name) => {
        try {
          // A detached Unix process group contains the agent and its MCP children.
          if (process.platform !== "win32" && child.pid)
            process.kill(-child.pid, name);
          else child.kill(name);
        } catch {
          /* Already exited. */
        }
      };
      child.stdin.end();
      signal("SIGTERM");
      const kill = setTimeout(() => signal("SIGKILL"), stopTimeoutMs);
      const deadline = setTimeout(finish, stopTimeoutMs + 1000);
      function finish() {
        clearTimeout(kill);
        clearTimeout(deadline);
        child.off("close", childClosed);
        resolve();
      }
      function childClosed() {
        // The leader closing its pipes does not establish that MCP descendants
        // exited. Keep escalation armed while its process group still exists.
        if (process.platform !== "win32" && child.pid) {
          try {
            process.kill(-child.pid, 0);
            return;
          } catch {
            /* Group exited. */
          }
        }
        finish();
      }
      child.once("close", childClosed);
    }).finally(() => {
      if (active === entry) active = undefined;
    });
    return entry.stopping;
  }

  function input(entry, event) {
    if (event?.jsonrpc !== "2.0" || typeof event !== "object") throw Error();
    if (!Object.hasOwn(event, "method")) {
      if (
        Object.hasOwn(event, "error") ||
        !permissionId(event.id) ||
        !entry.permissions.has(event.id)
      )
        throw Error();
      const outcome = event.result?.outcome;
      const permission = entry.permissions.get(event.id);
      if (
        outcome?.outcome !== "selected" ||
        permission.responding ||
        !permission.options.has(outcome.optionId)
      )
        throw Error();
      permission.responding = true;
      return {
        jsonrpc: "2.0",
        id: event.id,
        result: {
          outcome: { outcome: "selected", optionId: outcome.optionId },
        },
      };
    }
    if (
      !METHODS.has(event.method) ||
      (event.id !== undefined && !requestId(event.id))
    )
      throw Error();
    if (event.method !== "session/cancel" && event.id === undefined)
      throw Error();
    if (entry.pending.size >= 64 || entry.pending.has(event.id)) throw Error();
    let params = event.params;
    if (event.method === "initialize") {
      if (entry.initializing) throw Error();
      entry.initializing = true;
      params = {
        protocolVersion: 1,
        clientCapabilities: { _meta: { buzz: { realtimeAudio: 1 } } },
      };
    } else if (event.method === "session/new") {
      if (!entry.initialized || entry.creating) throw Error();
      entry.creating = true;
      params = {
        cwd: entry.workspace,
        mcpServers: [{ name: "dev", command: mcpPath, args: [], env: [] }],
      };
    } else {
      if (!entry.session || params?.sessionId !== entry.session) throw Error();
      if (
        event.method.startsWith(MEDIA) &&
        (!entry.stream || params.streamId !== entry.stream)
      )
        throw Error();
      if (event.method === "session/prompt") {
        if (
          entry.prompting ||
          !Array.isArray(params.prompt) ||
          params.prompt.length > 8 ||
          params.prompt.some(
            (item) =>
              item?.type !== "text" ||
              typeof item.text !== "string" ||
              item.text.length > 32000,
          )
        )
          throw Error();
        entry.prompting = true;
        params = {
          sessionId: entry.session,
          prompt: params.prompt.map(({ text }) => ({ type: "text", text })),
          _meta: { buzz: { realtimeAudio: 1 } },
        };
      } else if (event.method === "session/cancel") {
        entry.permissions.clear();
        params = { sessionId: entry.session };
      }
      if (
        event.method === `${MEDIA}interrupt` ||
        event.method === `${MEDIA}close`
      )
        entry.permissions.clear();
    }
    if (event.id !== undefined) entry.pending.set(event.id, event.method);
    return {
      jsonrpc: "2.0",
      ...(event.id !== undefined ? { id: event.id } : {}),
      method: event.method,
      params,
    };
  }

  function output(entry, event) {
    if (event?.jsonrpc !== "2.0") throw Error();
    if (event.method === "session/request_permission") {
      if (
        event.params?.sessionId !== entry.session ||
        !permissionId(event.id) ||
        entry.permissions.size >= 1 ||
        !Array.isArray(event.params.options)
      )
        throw Error();
      const options = event.params.options.filter(
        (option) =>
          typeof option.optionId === "string" &&
          ["allow_once", "reject_once"].includes(option.kind),
      );
      if (!options.length || entry.permissions.has(event.id)) throw Error();
      const tool = event.params.subject?.toolCall ?? event.params.toolCall;
      if (
        typeof tool?.toolCallId !== "string" ||
        !tool.toolCallId ||
        tool.toolCallId.length > 256
      )
        throw Error();
      entry.permissions.set(event.id, {
        options: new Set(options.map((option) => option.optionId)),
        toolCallId: tool.toolCallId,
        responding: false,
      });
      if (entry.approval === "auto") {
        const allow = options.find((option) => option.kind === "allow_once");
        if (!allow) throw Error();
        // ACP clients apply policy; buzz-agent always retains its permission gate.
        // Reuse the same correlation and serialized writer as manual decisions.
        void send(entry, {
          jsonrpc: "2.0",
          id: event.id,
          result: {
            outcome: { outcome: "selected", optionId: allow.optionId },
          },
        }).catch(() => {});
        return;
      }
    } else if (event.id !== undefined) {
      const method = entry.pending.get(event.id);
      if (!method) throw Error();
      entry.pending.delete(event.id);
      if (method === "initialize" && event.result) entry.initialized = true;
      if (method === "session/new" && event.result) {
        if (
          typeof event.result.sessionId !== "string" ||
          event.result.sessionId.length > 256
        )
          throw Error();
        entry.session = event.result.sessionId;
      }
    } else if (
      event.method === `${MEDIA}update` ||
      event.method === "session/update"
    ) {
      if (!entry.session || event.params?.sessionId !== entry.session)
        throw Error();
      if (
        event.method === `${MEDIA}update` &&
        event.params.update?.type === "ready"
      )
        entry.stream = event.params.streamId;
      const update = event.params.update;
      if (
        event.method === `${MEDIA}update` &&
        ["speech_started", "closed"].includes(update?.type)
      )
        entry.permissions.clear();
      if (
        update?.sessionUpdate === "tool_call_update" &&
        ["completed", "failed"].includes(update.status)
      ) {
        for (const [id, permission] of entry.permissions)
          if (permission.toolCallId === update.toolCallId)
            entry.permissions.delete(id);
      }
    } else throw Error();
    const wire = JSON.stringify(event, (_key, value) =>
      typeof value === "string"
        ? entry.secrets.reduce(
            (text, secret) => text.replaceAll(secret, "[redacted]"),
            value,
          )
        : value,
    );
    return `data: ${wire}\n\n`;
  }

  function send(entry, raw) {
    const permission =
      raw && !Object.hasOwn(raw, "method")
        ? entry.permissions.get(raw.id)
        : undefined;
    const event = input(entry, raw);
    entry.writes = entry.writes
      .catch(() => {})
      .then(async () => {
        if (!live(entry)) throw Error();
        if (permission) {
          if (entry.permissions.get(event.id) !== permission)
            throw Error("Permission expired");
          entry.permissions.delete(event.id);
        }
        try {
          await write(entry.child.stdin, `${JSON.stringify(event)}\n`);
        } catch {
          void stop(entry);
          throw Error("Agent input unavailable");
        }
      });
    return entry.writes.then(() => event);
  }

  async function events(req, res, scope, token, thinking, approval) {
    const workspace = join(
      stateDirectory,
      "workspaces",
      viewer,
      createHash("sha256").update(scope.relay).digest("hex"),
    );
    const entry = {
      token,
      ...scope,
      res,
      pending: new Map(),
      permissions: new Map(),
      writes: Promise.resolve(),
      secrets: [],
      uploads: 0,
      workspace,
      approval,
    };
    active = entry;
    res.once("close", () => void stop(entry));
    try {
      const credentials = await identity.credentials();
      await mkdir(workspace, { recursive: true, mode: 0o700 });
      if (!live(entry) || req.aborted || res.destroyed) {
        await stop(entry);
        return;
      }
      entry.secrets = [
        credentials.privateKey,
        credentials.authTag,
        apiKey,
        provider,
      ].filter(Boolean);
      const policy =
        approval === "auto"
          ? "The user has enabled automatic tool approval for this call."
          : "Tool calls require the user's approval for this call.";
      const system = `You are Bestie, the user's companion in Buzz. Keep voice replies concise and natural. Your public key is ${credentials.pubkey}. Your owner is ${viewer}. This conversation is bound to ${scope.relay}. Use the dev MCP tools and its buzz CLI for Buzz operations in this community. ${policy} Do not assume private channel membership from ownership. Only create or update your profile, join channels, or publish messages when the user requests it. Prefix messages you publish with 🤖 to identify them as agent-authored.`;
      const env = {
        PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
        HOME: workspace,
        ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
        LANG: "en_US.UTF-8",
        BUZZ_AGENT_PROVIDER: "openai",
        OPENAI_COMPAT_API: "realtime",
        OPENAI_COMPAT_MODEL: model,
        OPENAI_COMPAT_BASE_URL: provider,
        OPENAI_COMPAT_API_KEY: apiKey || "local-realtime",
        BUZZ_AGENT_THINKING_EFFORT: thinking,
        BUZZ_AGENT_SYSTEM_PROMPT: system,
        BUZZ_AGENT_MAX_SESSIONS: "1",
        // Use the harness's own scheduling for the single approval card.
        BUZZ_AGENT_MAX_PARALLEL_TOOLS: "1",
        BUZZ_AGENT_MAX_PENDING_PERMISSIONS: "1",
        BUZZ_AGENT_NO_HINTS: "1",
        BUZZ_AGENT_REALTIME_OUTPUT: "audio",
        BUZZ_ACP_DISPLAY_NAME: "Bestie",
        BUZZ_PRIVATE_KEY: credentials.privateKey,
        BUZZ_AUTH_TAG: credentials.authTag,
        BUZZ_RELAY_URL: scope.relay.replace(/^https:/, "wss:"),
      };
      const child = spawnAgent(agentPath, [], {
        cwd: workspace,
        env,
        stdio: ["pipe", "pipe", "ignore"],
        detached: process.platform !== "win32",
      });
      entry.child = child;
      child.stdin.on("error", () => void stop(entry));
      child.once("error", () => void stop(entry));
      child.once("exit", () => void stop(entry));
      entry.timer = setTimeout(() => void stop(entry), callTimeoutMs);
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store, no-transform",
        "X-Content-Type-Options": "nosniff",
      });
      res.flushHeaders();
      await write(
        res,
        `data: ${JSON.stringify({ jsonrpc: "2.0", method: "bestie/ready" })}\n\n`,
      );
      void (async () => {
        let buffer = "";
        child.stdout.setEncoding("utf8");
        for await (const chunk of child.stdout) {
          buffer += chunk;
          if (Buffer.byteLength(buffer) > FRAME_BYTES) throw Error();
          for (;;) {
            const index = buffer.indexOf("\n");
            if (index < 0) break;
            const line = buffer.slice(0, index);
            buffer = buffer.slice(index + 1);
            if (!live(entry)) return;
            const wire = output(entry, JSON.parse(line));
            if (wire) await write(res, wire);
          }
        }
        await stop(entry);
      })().catch(() => stop(entry));
    } catch {
      json(res, 503, {
        error:
          "Bestie could not start. Check the host's realtime configuration and installed agent tools.",
      });
      await stop(entry);
    }
  }

  async function handle(req, res, scope) {
    if (closed) return json(res, 503, { error: "Bestie is unavailable." });
    let relay;
    try {
      relay = relayOrigin(scope.relay);
    } catch {
      return json(res, 403, { error: "Community rejected." });
    }
    if (scope.viewer !== viewer)
      return json(res, 403, { error: "Account rejected." });
    const url = new URL(req.url, "http://localhost");
    const op = url.searchParams.get("op");
    if (op === "status" && req.method === "GET")
      return json(res, 200, { available: true, busy: Boolean(active) });
    let token = callToken(
      req.headers.authorization?.match(/^Bearer (.+)$/i)?.[1],
    );
    for (const [ticket, grant] of authorizations)
      if (grant.expires <= Date.now()) authorizations.delete(ticket);
    if (
      op === "events" &&
      req.method === "GET" &&
      url.searchParams.has("ticket")
    ) {
      const ticket = callToken(url.searchParams.get("ticket"));
      const grant = authorizations.get(ticket);
      const name = `bestie-${ticket}`;
      const cookie = req.headers.cookie
        ?.split(/;\s*/)
        .find((part) => part.startsWith(`${name}=`))
        ?.slice(name.length + 1);
      if (
        !grant ||
        cookie !== grant.token ||
        grant.relay !== relay ||
        grant.path !== url.pathname
      )
        return json(res, 403, {
          error: "Call authorization expired or rejected.",
        });
      token = grant.token;
      authorizations.delete(ticket);
      res.setHeader(
        "Set-Cookie",
        `${name}=; Path=${url.pathname}; HttpOnly; SameSite=Strict; Max-Age=0`,
      );
    }
    if (!token) return json(res, 403, { error: "Call credential required." });
    if (op === "authorize" && req.method === "POST") {
      if (/[;,\s]/.test(url.pathname))
        return json(res, 400, { error: "Invalid call path." });
      if (active || retired.has(token))
        return json(res, 409, {
          error: "A call is active or this call has ended.",
        });
      if (authorizations.size >= 32)
        return json(res, 429, {
          error: "Too many pending calls. Try again shortly.",
        });
      const ticket = randomUUID();
      authorizations.set(ticket, {
        token,
        relay,
        path: url.pathname,
        expires: Date.now() + 60000,
      });
      // The public ticket selects this call's cookie; it is not a credential.
      res.setHeader(
        "Set-Cookie",
        `bestie-${ticket}=${token}; Path=${url.pathname}; HttpOnly; SameSite=Strict; Max-Age=60`,
      );
      return json(res, 200, { ticket });
    }
    if (op === "events" && req.method === "GET") {
      const thinking = url.searchParams.get("thinking") || "none";
      const approval = url.searchParams.get("approval") || "auto";
      if (!THINKING.has(thinking))
        return json(res, 400, { error: "Invalid thinking level." });
      if (!["auto", "ask"].includes(approval))
        return json(res, 400, { error: "Invalid tool approval mode." });
      if (active || retired.has(token))
        return json(res, 409, {
          error: "A call is active or this call has ended.",
        });
      return events(req, res, { relay, viewer }, token, thinking, approval);
    }
    const entry = active;
    if (op !== "rpc" || req.method !== "POST")
      return json(res, 404, { error: "Unknown Bestie operation." });
    if (
      !entry ||
      !live(entry) ||
      !entry.child ||
      entry.token !== token ||
      entry.relay !== relay
    )
      return json(res, 409, {
        error: "This call is no longer active in this community.",
      });
    if (entry.uploads >= 8)
      return json(res, 429, { error: "Bestie request capacity reached." });
    entry.uploads++;
    const uploadDeadline = setTimeout(() => req.destroy(), 10000);
    try {
      let bytes = 0;
      const chunks = [];
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > REQUEST_BYTES) throw Error();
        chunks.push(chunk);
      }
      if (!live(entry)) throw Error();
      const event = await send(entry, JSON.parse(Buffer.concat(chunks)));
      res.writeHead(204).end();
      if (event.method === "session/cancel") void stop(entry);
    } catch {
      json(res, 400, { error: "Invalid or expired Bestie request." });
    } finally {
      clearTimeout(uploadDeadline);
      entry.uploads--;
    }
  }
  return {
    handle,
    async close() {
      closed = true;
      authorizations.clear();
      identity.dispose();
      if (active) await stop(active);
    },
  };
}
