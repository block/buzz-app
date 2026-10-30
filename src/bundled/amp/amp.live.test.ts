// @vitest-environment node
// Drives the real `amp` on PATH, signed in as `amp login` left it: run with
// AMP_LIVE=1. The Buzz tools are listed as the app lists them, from a loopback
// HTTP MCP server that follows the app's native one; their calls are recorded,
// not sent to a relay. Each run uses Amp credits.
import { spawn as spawnChild } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { respond } from "../../buzz-mcp/rpc";
import { answerMcp } from "../../features/host/service";
import { systemPrompt } from "../claude-code/prompt";
import { type AmpHost, runTurn, type ToolServer } from "./amp";

const LIVE = process.env.AMP_LIVE === "1";

const spawn: AmpHost["spawn"] = async (_id, options = {}) => {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const [key, value] of Object.entries(options.env ?? {}))
    if (value === null) delete env[key];
    else env[key] = value;
  const child = spawnChild("amp", [...(options.args ?? [])], {
    cwd: options.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout
    .setEncoding("utf8")
    .on("data", (data) => options.onStdout?.(data));
  child.stderr
    .setEncoding("utf8")
    .on("data", (data) => options.onStderr?.(data));
  const exited = new Promise<number | null>((resolve) =>
    child.on("exit", (code) => resolve(code)),
  );
  return {
    write: (data) =>
      new Promise<void>((resolve, reject) =>
        child.stdin.write(data, (error) => (error ? reject(error) : resolve())),
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
const hits: { method: string; rpc: unknown; status: number }[] = [];

/** What the app's native listener does: a token per server, 404 for a wrong
 * one, 405 for `GET`, and a JSON reply or 202 for each `POST /mcp`. The first
 * `initialize` answered with a result claims the server's one session, which
 * later requests name; another after that stops the server. */
const serve: AmpHost["serve"] = async (handler) => {
  const token = randomBytes(32).toString("base64url");
  const session = randomBytes(32).toString("base64url");
  let claim: "unclaimed" | "claiming" | "claimed" = "unclaimed";
  let stopped = false;
  const server = createServer((request, response) => {
    let rpc: unknown;
    const end = (status: number, body?: string) => {
      hits.push({ method: request.method ?? "", rpc, status });
      response.writeHead(status, {
        ...(claim === "claimed" && (status === 200 || status === 202)
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
      try {
        rpc = (JSON.parse(body) as { method?: unknown }).method;
      } catch {}
      if (stopped) return end(404);
      if (named === undefined) {
        if (rpc !== "initialize") return end(404);
        if (claim !== "unclaimed") {
          stopped = true;
          return end(404);
        }
        claim = "claiming";
      }
      const reply = await answerMcp(handler, body);
      if (claim === "claiming")
        claim =
          (reply as { result?: unknown } | undefined)?.result === undefined
            ? "unclaimed"
            : "claimed";
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

type Send = { name?: string; arguments?: { text?: string } };

describe.skipIf(!LIVE)("amp, live", () => {
  it("answers with the Buzz tools, then continues its thread", {
    timeout: 300_000,
  }, async () => {
    const sends: Send[] = [];
    const tools: ToolServer = async (message) => {
      if (message.method === "tools/call") {
        sends.push(message.params as Send);
        return {
          jsonrpc: "2.0",
          id: message.id,
          result: { content: [{ type: "text", text: "sent 1234" }] },
        };
      }
      return respond(undefined, {}, message);
    };
    const cwd = mkdtempSync(join(tmpdir(), "buzz-amp-"));
    const system = systemPrompt({ scope: "thread", cwd });
    const first = await runTurn(
      { spawn, serve },
      {
        cwd,
        prompt: `<buzz-system-prompt>\n${system}\n</buzz-system-prompt>\n\nRemember the word "heron". Reply in Buzz with send, audience "everyone", text "ready", final true.`,
        keep: true,
        title: "Buzz live test",
        mode: "low",
        tools,
      },
    );
    expect(first).toMatchObject({ ok: true });
    expect(first.text).toBeUndefined();
    expect(sends.at(-1)).toMatchObject({
      name: "send",
      arguments: { text: "ready" },
    });
    // Amp opens one MCP session and never claims the server twice.
    expect(
      hits.filter((hit) => hit.rpc === "initialize" && hit.status === 200),
    ).toHaveLength(1);
    expect(hits.filter((hit) => hit.status === 404)).toEqual([]);

    const second = await runTurn(
      { spawn, serve },
      {
        cwd,
        prompt:
          'Which word did I ask you to remember? Reply with send, audience "everyone", the word as text, final true.',
        ...(first.thread ? { thread: first.thread } : {}),
        mode: "low",
        tools,
      },
    );
    expect(second).toMatchObject({ ok: true, thread: first.thread });
    expect(sends.at(-1)?.arguments?.text?.toLowerCase()).toContain("heron");
  });
});
