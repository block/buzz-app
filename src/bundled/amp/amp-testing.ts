// A fake desktop host for Amp tests: each `amp` it starts runs `script` with
// its arguments, its prompt and the turn's MCP handler, and prints what that
// returns.
import type {
  HostMcpServer,
  HostProcess,
  HostProcessOptions,
  McpHandler,
} from "../../features/host/service";
import type { AmpHost } from "./amp";

export type Script = (
  run: Readonly<{
    args: readonly string[];
    prompt: string;
    mcp: McpHandler;
    killed: Promise<void>;
  }>,
) => Promise<Readonly<{ stdout?: string[]; stderr?: string; code?: number }>>;

export type Started = {
  args: readonly string[];
  cwd?: string;
  env?: HostProcessOptions["env"];
  prompt?: string;
  killed: boolean;
};

export const line = (value: unknown) => JSON.stringify(value);
export const init = (thread: string) =>
  line({ type: "system", subtype: "init", session_id: thread });
export const result = (thread: string, text: string, isError = false) =>
  line({
    type: "result",
    subtype: isError ? "error" : "success",
    is_error: isError,
    result: text,
    session_id: thread,
  });

export function fakeAmp(script: Script) {
  const started: Started[] = [];
  const servers: { closed: boolean }[] = [];
  let handler: McpHandler = async () => undefined;
  const host: AmpHost = {
    serve: async (next) => {
      handler = next;
      const server = { closed: false };
      servers.push(server);
      return {
        url: "http://127.0.0.1:1/mcp",
        headers: [{ name: "Authorization", value: "Bearer token" }],
        close: async () => {
          server.closed = true;
        },
        closed: new Promise(() => {}),
      } satisfies HostMcpServer;
    },
    spawn: async (_id, options = {}) => {
      const run: Started = {
        args: options.args ?? [],
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.env ? { env: options.env } : {}),
        killed: false,
      };
      started.push(run);
      const mcp = handler;
      let kill = () => {};
      const killed = new Promise<void>((resolve) => {
        kill = resolve;
      });
      let input: (prompt: string) => void = () => {};
      const prompt = new Promise<string>((resolve) => {
        input = resolve;
      });
      const exited = prompt.then(async (text) => {
        const output: Awaited<ReturnType<Script>> = await Promise.race([
          script({ args: run.args, prompt: text, mcp, killed }),
          killed.then(() => ({ code: 143 })),
        ]);
        for (const item of output.stdout ?? []) options.onStdout?.(`${item}\n`);
        if (output.stderr) options.onStderr?.(output.stderr);
        return output.code ?? 0;
      });
      return {
        write: async () => {},
        end: async (data = "") => {
          run.prompt = data;
          input(data);
        },
        kill: async () => {
          run.killed = true;
          kill();
        },
        exited,
      } satisfies HostProcess;
    },
  };
  return { host, started, servers };
}

/** A `tools/call` of the Buzz tool `name`, as Amp sends one. */
export const call = (mcp: McpHandler, name: string, id = 1) =>
  mcp({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: {} },
  });
