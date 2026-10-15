// One ACP harness process, driven over line-delimited JSON-RPC. Each
// conversation is one ACP session in it. Each session gets its own loopback
// HTTP MCP server for its agent's Buzz tools, which the app serves and
// answers: the harness is given its address and token in `session/new`, never
// a Buzz key. What a harness adds to plain ACP comes from its `AcpHooks`.
import type { HostMcpServer, HostProcess } from "../../host/service";
import { AcpSession } from "./session";
import { allow, errorMessage } from "./steps";
import type {
  AcpHooks,
  Choice,
  McpServer,
  ServeMcp,
  Spawn,
  ToolServer,
} from "./types";

/** The Buzz tools that answer where people see it. A read, or a send that
 * failed, still leaves the harness's text to post. */
const ANSWERS = new Set(["send", "edit", "react"]);
const STOPPED =
  "Buzz stopped this session's tools: another program used their token";

/** How long a harness has to answer a request that starts it or opens or
 * closes a session. One that does not is stopped. A turn's prompt is never
 * timed. */
export const REQUEST_TIMEOUT_MS = 60_000;

/** The HTTP MCP server every session declares; its tools are named
 * `buzz__<name>`. */
export const TOOL_SERVER = "buzz";

const STDERR_LIMIT = 4_000;

/** The hooks every harness on this client provides so far. One without them
 * is not supported yet. */
export type Hooks = Required<AcpHooks>;

type Wire = {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message: string; data?: unknown };
};
type Pending = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
};

export class AcpProcess {
  readonly exited: Promise<number | null>;
  private readonly sessions = new Map<string, AcpSession>();
  private readonly calls = new Map<number, Pending>();
  private requests = 0;
  private buffer = "";
  private stderr = "";
  private alive = true;
  private capabilities: Readonly<Record<string, unknown>> = {};

  private constructor(
    private readonly process: HostProcess,
    readonly hooks: Hooks,
    private readonly serve: ServeMcp | undefined,
  ) {
    this.exited = process.exited.then((code) => {
      this.alive = false;
      const error = new Error(
        this.stderr.trim().split("\n").at(-1) ||
          `${hooks.label} exited (${code ?? "signal"})`,
      );
      for (const call of this.calls.values()) call.reject(error);
      this.calls.clear();
      for (const session of this.sessions.values()) {
        session.fail(error.message);
        void session.server?.close();
      }
      this.sessions.clear();
      return code;
    });
  }

  /** Starts the harness and checks it can reach the Buzz tools. Sessions
   * with tools need `serve`, which starts their MCP server. */
  static async start(
    spawn: Spawn,
    hooks: AcpHooks,
    launch: Readonly<{
      cwd: string;
      env?: Readonly<Record<string, string | null>>;
      serve?: ServeMcp;
    }>,
  ) {
    const supported = supportedHooks(hooks);
    let acp: AcpProcess | undefined;
    const early: string[] = [];
    const process = await spawn(hooks.program, {
      cwd: launch.cwd,
      env: { ...hooks.env, ...launch.env },
      onStdout: (data) => (acp ? acp.read(data) : early.push(data)),
      onStderr: (data) => acp?.readError(data),
    }).catch((error: unknown) => {
      throw /os error 2|no such file|not found/i.test(errorMessage(error))
        ? new Error(hooks.missing)
        : error;
    });
    acp = new AcpProcess(process, supported, launch.serve);
    for (const data of early) acp.read(data);
    try {
      const init = (await acp.request(
        "initialize",
        {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: "buzz", version: "1" },
        },
        REQUEST_TIMEOUT_MS,
      )) as {
        agentCapabilities?: Record<string, unknown> & {
          mcpCapabilities?: { http?: boolean };
        };
      };
      acp.capabilities = init.agentCapabilities ?? {};
      if (!init.agentCapabilities?.mcpCapabilities?.http)
        throw new Error(
          `This ${hooks.label} cannot reach Buzz tools (no HTTP MCP support)`,
        );
    } catch (error) {
      void process.kill();
      throw error;
    }
    return acp;
  }

  get running() {
    return this.alive;
  }
  get busy() {
    return [...this.sessions.values()].some((session) => session.busy);
  }
  /** The `agentCapabilities` the harness answered `initialize` with. */
  get agentCapabilities() {
    return this.capabilities;
  }

  /** Opens a new session in `cwd`, named `title`, whose system prompt has
   * `systemPrompt` appended. `tools` answers its Buzz tools; without them it
   * has no tools at all. Each turn runs on the provider and model `choice`
   * gives as it starts. */
  async open(
    launch: Readonly<{
      cwd: string;
      systemPrompt: string;
      title?: string;
      tools?: ToolServer;
      choice?: () => Choice;
    }>,
  ): Promise<AcpSession> {
    const { hooks } = this;
    const provider = launch.choice?.().provider ?? "";
    let server: HostMcpServer | undefined;
    // The harness connects while it opens the session, before it is known here.
    let session: AcpSession | undefined;
    const { tools } = launch;
    if (tools) {
      if (!this.serve)
        throw new Error(`This ${hooks.label} serves no Buzz tools`);
      server = await this.serve((message) => this.mcp(tools, session, message));
    }
    const buzz: McpServer | undefined = server && {
      type: "http",
      name: TOOL_SERVER,
      url: server.url,
      headers: server.headers,
    };
    // The host stops a server whose token a second client used, so the
    // session's tools may be someone else's. A session closed here has
    // already left `sessions`.
    let stopped = false;
    void server?.closed.then(() => {
      stopped = true;
      if (session && this.sessions.get(session.id) === session) {
        session.fail(STOPPED);
        void this.close(session);
      }
    });
    let sessionId: string;
    try {
      ({ sessionId } = (await this.request(
        "session/new",
        {
          cwd: launch.cwd,
          mcpServers: buzz ? [buzz] : [],
          _meta: hooks.newSessionMeta(buzz, {
            ...(launch.title ? { title: launch.title } : {}),
            provider,
          }),
        },
        REQUEST_TIMEOUT_MS,
      )) as { sessionId: string });
    } catch (error) {
      void server?.close();
      throw error;
    }
    session = new AcpSession(this, sessionId, server, launch.choice, {
      provider,
      model: "",
    });
    this.sessions.set(sessionId, session);
    if (stopped) {
      void this.close(session);
      throw new Error(STOPPED);
    }
    try {
      if (launch.systemPrompt)
        await hooks.systemPrompt(this, sessionId, launch.systemPrompt);
    } catch (error) {
      void this.close(session);
      throw error;
    }
    return session;
  }

  /** Ends a session. Its turn, if any, is cancelled first. */
  async close(session: AcpSession) {
    if (!this.sessions.delete(session.id)) return;
    session.fail("The session was closed");
    void session.server?.close();
    if (!this.alive) return;
    this.notify("session/cancel", { sessionId: session.id });
    await this.request(
      "session/close",
      { sessionId: session.id },
      REQUEST_TIMEOUT_MS,
    ).catch((error) =>
      console.warn(`${this.hooks.label} did not close a session`, error),
    );
  }

  kill() {
    return this.process.kill();
  }

  /** Sends a request and resolves with its result. When the harness does not
   * answer within `timeout` ms it is stopped, which fails its sessions. */
  request(method: string, params: Record<string, unknown>, timeout?: number) {
    const { label } = this.hooks;
    if (!this.alive)
      return Promise.reject(new Error(`${label} is not running`));
    const id = ++this.requests;
    const answer = new Promise<unknown>((resolve, reject) => {
      if (timeout === undefined) return this.calls.set(id, { resolve, reject });
      const timer = setTimeout(() => {
        this.calls.delete(id);
        reject(
          new Error(
            `${label} did not answer ${method} in ${Math.round(timeout / 1000)}s`,
          ),
        );
        void this.kill();
      }, timeout);
      this.calls.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
    this.write({ jsonrpc: "2.0", id, method, params }).catch((error) => {
      this.calls.get(id)?.reject(new Error(String(error)));
      this.calls.delete(id);
    });
    return answer;
  }
  notify(method: string, params: Record<string, unknown>) {
    void this.write({ jsonrpc: "2.0", method, params }).catch(() => undefined);
  }

  private write(message: Wire) {
    return this.process.write(`${JSON.stringify(message)}\n`);
  }
  private readError(data: string) {
    this.stderr = (this.stderr + data).slice(-STDERR_LIMIT);
  }
  private read(data: string) {
    this.buffer += data;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf("\n");
      if (!line) continue;
      let message: Wire;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      this.handle(message);
    }
  }
  private handle(message: Wire) {
    const { id, method } = message;
    if (method === undefined) {
      if (typeof id !== "number") return;
      const call = this.calls.get(id);
      this.calls.delete(id);
      if (message.error) call?.reject(new Error(errorMessage(message.error)));
      else call?.resolve(message.result);
      return;
    }
    if (id === undefined || id === null) {
      if (method === "session/update") this.update(message.params ?? {});
      return;
    }
    void this.answer(id, method, message.params ?? {});
  }
  private update(params: Record<string, unknown>) {
    const session = this.sessions.get(String(params.sessionId));
    const update = params.update as Record<string, unknown> | undefined;
    if (session && update) session.update(update);
  }
  /** Answers what the harness asks its client: since tools run without
   * asking, any permission prompt with allow. */
  private async answer(
    id: number | string,
    method: string,
    params: Record<string, unknown>,
  ) {
    let reply: Wire;
    if (method === "session/request_permission")
      reply = { jsonrpc: "2.0", id, result: { outcome: allow(params) } };
    else
      reply = {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Buzz does not handle ${method}` },
      };
    return this.write(reply).catch(() => undefined);
  }
  /** One MCP message for a session's Buzz tools, answered with its JSON-RPC
   * response; a notification gets none. A final `send` that succeeded ends
   * its turn. The host answers a throw with an internal error. */
  private async mcp(
    tools: ToolServer,
    session: AcpSession | undefined,
    message: unknown,
  ): Promise<Wire | undefined> {
    const { id, method = "", params } = (message ?? {}) as Wire;
    if (id === undefined || id === null) return undefined;
    const response = (await tools(session?.conversation, {
      id,
      method,
      params,
    })) as Wire;
    const call = (params ?? {}) as {
      name?: unknown;
      arguments?: { final?: unknown };
    };
    const worked =
      method === "tools/call" &&
      !response.error &&
      !(response.result as { isError?: unknown } | undefined)?.isError;
    if (worked && ANSWERS.has(String(call.name))) session?.answered();
    if (worked && call.name === "send" && call.arguments?.final === true)
      session?.finished();
    return response;
  }
}

/** `hooks`, once it has every hook: a harness that lacks one is not
 * supported yet. */
function supportedHooks(hooks: AcpHooks): Hooks {
  const { newSessionMeta, systemPrompt, steering, select } = hooks;
  if (!newSessionMeta || !systemPrompt || !steering || !select)
    throw new Error(`${hooks.label} is unsupported: it lacks an ACP hook`);
  return { ...hooks, newSessionMeta, systemPrompt, steering, select };
}
