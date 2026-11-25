// What goose's live tests share: a host `spawn` that runs a real `goose-acp`,
// and a loopback HTTP MCP server that follows the app's native one.
import { spawn as spawnChild } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import {
  answerMcp,
  type HostProcessOptions,
} from "../../features/host/service";
import type { ServeMcp, Spawn } from "./goose";

export const liveSpawn =
  (bin: string | undefined): Spawn =>
  async (_id, options: HostProcessOptions = {}) => {
    const env: Record<string, string | undefined> = { ...process.env };
    for (const [key, value] of Object.entries(options.env ?? {}))
      if (value === null) delete env[key];
      else env[key] = value;
    const child = spawnChild(bin ?? "goose-acp", [], {
      cwd: options.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8").on("data", (data) => {
      if (process.env.GOOSE_ACP_DEBUG) process.stderr.write(`<< ${data}`);
      options.onStdout?.(data);
    });
    child.stderr.setEncoding("utf8").on("data", (data) => {
      if (process.env.GOOSE_ACP_DEBUG) process.stderr.write(data);
      options.onStderr?.(data);
    });
    const exited = new Promise<number | null>((resolve) =>
      child.on("exit", (code) => resolve(code)),
    );
    return {
      write: (data) =>
        new Promise<void>((resolve, reject) =>
          child.stdin.write(data, (error) =>
            error ? reject(error) : resolve(),
          ),
        ),
      end: async (data) => {
        child.stdin.end(data);
      },
      kill: async () => {
        child.kill();
      },
      exited,
    };
  };

/** The HTTP requests the MCP servers received, by method and status. */
export const hits: { method: string; status: number }[] = [];

const method = (body: string): unknown => {
  try {
    return (JSON.parse(body) as { method?: unknown } | null)?.method;
  } catch {
    return undefined;
  }
};

/** What the app's native listener does: a token per server, 404 for a wrong
 * one, 405 for `GET`, and a JSON reply or 202 for each `POST /mcp`. An
 * `initialize` that succeeds claims the server's one session, and later
 * requests must name it; before it, only discovery and `ping` are answered. A
 * second `initialize` stops the server. */
export const serve: ServeMcp = async (handler) => {
  const token = randomBytes(32).toString("base64url");
  const session = randomBytes(32).toString("base64url");
  let claim: "unclaimed" | "claiming" | "claimed" = "unclaimed";
  const server = createServer((request, response) => {
    let joined = false;
    const end = (status: number, body?: string) => {
      hits.push({ method: request.method ?? "", status });
      response.writeHead(status, {
        ...(joined && (status === 200 || status === 202)
          ? { "Mcp-Session-Id": session }
          : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      });
      response.end(body);
    };
    if (
      request.url?.split("?")[0] !== "/mcp" ||
      request.headers.authorization !== `Bearer ${token}`
    )
      return end(404);
    if (request.method !== "POST") return end(405);
    const named = request.headers["mcp-session-id"];
    if (named !== undefined && (named !== session || claim !== "claimed"))
      return end(404);
    let body = "";
    request.setEncoding("utf8").on("data", (data) => (body += data));
    request.on("end", async () => {
      const kind = method(body);
      const claiming = named === undefined && kind === "initialize";
      if (claiming) {
        if (claim !== "unclaimed") {
          server.close();
          return end(404);
        }
        claim = "claiming";
      } else if (named === undefined) {
        // goose first asks `server/discover`.
        if (
          claim === "claimed" ||
          (kind !== "server/discover" && kind !== "ping")
        )
          return end(404);
      } else joined = true;
      const reply = await answerMcp(handler, body);
      if (claiming) {
        joined =
          (reply as { result?: unknown } | undefined)?.result !== undefined;
        claim = joined ? "claimed" : "unclaimed";
      }
      end(reply === undefined ? 202 : 200, JSON.stringify(reply));
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const closed = new Promise<void>((resolve) =>
    server.on("close", () => resolve()),
  );
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    headers: [{ name: "Authorization", value: `Bearer ${token}` }],
    close: async () => {
      server.closeAllConnections();
      server.close();
    },
    closed,
  };
};
