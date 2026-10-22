// One Amp turn: an `amp` process in execute mode that runs one message in an
// Amp thread and exits. Amp prints Claude Code's stream-json format. The Buzz
// tools are a loopback HTTP MCP server the app answers for that turn, so the
// process holds no Buzz key.
import type {
  HostMcpServer,
  HostProcess,
  HostProcessOptions,
  McpHandler,
} from "../../features/host/service";

export type Spawn = (
  id: string,
  options?: HostProcessOptions,
) => Promise<HostProcess>;
export type ServeMcp = (handler: McpHandler) => Promise<HostMcpServer>;
export type AmpHost = Readonly<{ spawn: Spawn; serve: ServeMcp }>;

/** Answers one MCP message of the turn's Buzz tools with its JSON-RPC response. */
export type ToolServer = (
  message: Readonly<{ id: string | number; method: string; params?: unknown }>,
) => Promise<unknown>;

export const TOOL_SERVER = "buzz";
/** The Buzz tools that answer where people see it. */
const ANSWERS = new Set(["send", "edit", "react"]);
/** Amp's own plumbing for reaching MCP tools, not steps worth showing. */
const PLUMBING = new Set(["tool_search", "code_exec"]);
const STEP_KEYS = ["path", "cmd", "command", "pattern", "query", "url"];
const WRITTEN_LIMIT = 20_000;
const STDERR_LIMIT = 4_000;

export const ENV: Readonly<Record<string, string | null>> = {
  // Amp plugins that mirror sessions to Buzz, such as amp-buzz, stay out of
  // a turn Buzz already holds.
  BUZZ_MANAGED_AGENT: "1",
};

export const MODES = ["low", "medium", "high", "ultra"] as const;

export type TurnLaunch = Readonly<{
  /** An absolute directory or one under home written `~/…`. */
  cwd: string;
  prompt: string;
  /** The Amp thread to continue; absent starts one. */
  thread?: string;
  /** A new thread is kept for later turns; otherwise Amp archives it. */
  keep?: boolean;
  title?: string;
  /** An Amp agent mode; absent is Amp's default. */
  mode?: string;
  tools: ToolServer;
  signal?: AbortSignal;
  step?(tool: string, target?: string): void;
}>;

export type TurnOutcome = Readonly<{
  ok: boolean;
  /** The Amp thread the turn ran in, once Amp named it. */
  thread?: string;
  error?: string;
  /** What Amp wrote, when it answered nowhere in Buzz. */
  text?: string;
  /** The owner stopped it. */
  stopped?: true;
  /** It failed before Amp opened the thread, such as one that cannot be
   * continued. */
  unopened?: true;
}>;

type Wire = {
  id?: string | number | null;
  method?: string;
  params?: unknown;
  error?: unknown;
  result?: { isError?: unknown };
};
type Line = Record<string, unknown> & {
  type?: string;
  subtype?: string;
  session_id?: unknown;
  is_error?: unknown;
  result?: unknown;
  message?: { content?: unknown };
};

export function ampArgs(
  launch: Pick<TurnLaunch, "thread" | "keep" | "title" | "mode">,
  server: Pick<HostMcpServer, "url" | "headers">,
) {
  const headers = Object.fromEntries(
    server.headers.map(({ name, value }) => [name, value]),
  );
  return [
    ...(launch.thread ? ["threads", "continue", launch.thread] : []),
    "--execute",
    "--stream-json",
    "--dangerously-allow-all",
    "--no-ide",
    "--no-notifications",
    "--no-color",
    "--mcp-config",
    JSON.stringify({ [TOOL_SERVER]: { url: server.url, headers } }),
    ...(launch.mode ? ["--mode", launch.mode] : []),
    ...(launch.thread
      ? []
      : [
          ...(launch.keep ? ["--no-archive-after-execute"] : []),
          ...(launch.title ? ["--title", launch.title] : []),
        ]),
  ];
}

/** Runs one turn and settles once `amp` exits. Never rejects. */
export async function runTurn(
  host: AmpHost,
  launch: TurnLaunch,
): Promise<TurnOutcome> {
  let answered = false;
  // Continuing a thread, Amp connects to the Buzz tools as it starts, drops
  // that connection as the thread loads, and connects again. The host's
  // server admits one session and stops at a second `initialize`, so until
  // Amp reports the thread open, an `initialize` is refused; Amp retries.
  let opened = false;
  let server: HostMcpServer;
  try {
    server = await host.serve(async (message) => {
      const { id, method = "", params } = (message ?? {}) as Wire;
      if (id === undefined || id === null) return undefined;
      if (method === "initialize" && launch.thread && !opened)
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32000, message: "Not ready; connect again" },
        };
      const response = (await launch.tools({ id, method, params })) as Wire;
      const name = String((params as { name?: unknown } | undefined)?.name);
      if (
        method === "tools/call" &&
        !response.error &&
        !response.result?.isError
      ) {
        launch.step?.(name);
        if (ANSWERS.has(name)) answered = true;
      }
      return response;
    });
  } catch (error) {
    return { ok: false, error: message(error) };
  }
  let thread = launch.thread;
  let result: Line | undefined;
  let stderr = "";
  let buffer = "";
  const read = (line: string) => {
    let parsed: Line;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof parsed.session_id === "string") {
      thread = parsed.session_id;
      opened = true;
    }
    if (parsed.type === "result") result = parsed;
    if (parsed.type === "assistant") stepsOf(parsed, launch.step);
  };
  try {
    let process: HostProcess;
    try {
      process = await host.spawn("amp", {
        args: ampArgs(launch, server),
        cwd: launch.cwd,
        env: ENV,
        onStdout: (data) => {
          buffer += data;
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) if (line.trim()) read(line);
        },
        onStderr: (data) => {
          stderr = (stderr + data).slice(-STDERR_LIMIT);
        },
      });
    } catch (error) {
      return {
        ok: false,
        error: `Could not start Amp (${message(error)}). Install it from https://ampcode.com, then run \`amp login\`.`,
      };
    }
    const stop = () => void process.kill().catch(() => undefined);
    if (launch.signal?.aborted) stop();
    launch.signal?.addEventListener("abort", stop, { once: true });
    try {
      await process.end(launch.prompt);
      const code = await process.exited;
      if (buffer.trim()) read(buffer);
      if (launch.signal?.aborted)
        return { ok: true, stopped: true, ...(thread ? { thread } : {}) };
      const done = result && result.is_error !== true;
      if (done) {
        const text =
          typeof result?.result === "string" ? result.result.trim() : "";
        return {
          ok: true,
          ...(thread ? { thread } : {}),
          ...(!answered && text ? { text: text.slice(0, WRITTEN_LIMIT) } : {}),
        };
      }
      const error =
        (typeof result?.result === "string" && result.result.trim()) ||
        stderr
          .trim()
          .split("\n")
          .at(-1)
          ?.replace(/^Error:\s*/, "") ||
        `Amp exited (${code ?? "signal"})`;
      return {
        ok: false,
        error,
        ...(thread ? { thread } : {}),
        ...(!opened ? { unopened: true as const } : {}),
      };
    } finally {
      launch.signal?.removeEventListener("abort", stop);
    }
  } finally {
    void server.close().catch(() => undefined);
  }
}

function stepsOf(line: Line, step: TurnLaunch["step"]) {
  if (!step) return;
  const content = line.message?.content;
  if (!Array.isArray(content)) return;
  for (const block of content as Record<string, unknown>[]) {
    if (block.type !== "tool_use" || typeof block.name !== "string") continue;
    if (PLUMBING.has(block.name)) continue;
    const input = (block.input ?? {}) as Record<string, unknown>;
    const target = STEP_KEYS.map((key) => input[key]).find(
      (value): value is string => typeof value === "string" && !!value,
    );
    if (target) step(block.name, shortTarget(target));
    else step(block.name);
  }
}

function shortTarget(value: string) {
  return value.startsWith("/") ? (value.split("/").at(-1) ?? value) : value;
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
