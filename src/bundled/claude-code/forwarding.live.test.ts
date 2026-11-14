// @vitest-environment node
// The exact native CLI: a forwarded process's flag settings outrank the
// person's own settings that turn on another provider, and a proxy in its
// environment never gets its generation's requests.
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ClaudeProcess, type Spawn } from "./claude";

const binary = process.env.CLAUDE_FORWARD_BINARY;

/** A server that answers every model request with one short reply. */
async function model() {
  const paths: string[] = [];
  const server = createServer(async (req, res) => {
    for await (const _ of req);
    paths.push(req.url ?? "");
    if (req.url?.includes("count_tokens")) {
      res.end('{"input_tokens":1}');
      return;
    }
    const events: [string, Record<string, unknown>][] = [
      [
        "message_start",
        {
          message: {
            id: "msg_1",
            type: "message",
            role: "assistant",
            content: [],
            model: "claude-sonnet-4-6",
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
      ],
      [
        "content_block_start",
        { index: 0, content_block: { type: "text", text: "" } },
      ],
      [
        "content_block_delta",
        { index: 0, delta: { type: "text_delta", text: "done" } },
      ],
      ["content_block_stop", { index: 0 }],
      [
        "message_delta",
        {
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 1 },
        },
      ],
      ["message_stop", {}],
    ];
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const [type, value] of events)
      res.write(
        `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`,
      );
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  return { server, paths, url: `http://127.0.0.1:${address.port}` };
}

const nativeSpawn =
  (home: string, inherited: NodeJS.ProcessEnv = {}): Spawn =>
  async (_id, options = {}) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...inherited,
      CLAUDE_CONFIG_DIR: home,
      ANTHROPIC_API_KEY: "fixture",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    };
    for (const [key, value] of Object.entries(options.env ?? {}))
      if (value === null) delete env[key];
      else env[key] = value;
    // Buzz clears the shell's key; the fixture's stands in for a sign-in.
    env.ANTHROPIC_API_KEY = "fixture";
    const child = spawn(binary ?? "", options.args ?? [], {
      cwd: home,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.on("data", (data) => options.onStdout?.(String(data)));
    child.stderr.on("data", (data) => options.onStderr?.(String(data)));
    return {
      write: (data) =>
        new Promise<void>((resolve, reject) =>
          child.stdin.write(data, (error) =>
            error ? reject(error) : resolve(),
          ),
        ),
      end: async () => void child.stdin.end(),
      kill: async () => void child.kill("SIGKILL"),
      exited: new Promise<number | null>((resolve) =>
        child.on("exit", resolve),
      ),
    };
  };

it.skipIf(!binary)(
  "sends a forwarded turn to its generation over the person's settings that turn on Bedrock",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "buzz-claude-forward-"));
    const generation = await model();
    const bedrock = await model();
    const servers: Server[] = [generation.server, bedrock.server];
    try {
      // The person's own settings: Bedrock, at an endpoint of their own.
      await writeFile(
        join(home, "settings.json"),
        JSON.stringify({
          env: {
            CLAUDE_CODE_USE_BEDROCK: "1",
            CLAUDE_CODE_SKIP_BEDROCK_AUTH: "1",
            ANTHROPIC_BEDROCK_BASE_URL: bedrock.url,
            ANTHROPIC_BASE_URL: bedrock.url,
          },
        }),
      );
      const run = async (forward?: { url: string; noProxy: string }) => {
        const claude = await ClaudeProcess.start(nativeSpawn(home), {
          cwd: home,
          systemPrompt: "Reply briefly.",
          model: "claude-sonnet-4-6",
          ...(forward ? { forward } : {}),
        });
        try {
          return await claude.send("hi");
        } finally {
          await claude.kill();
        }
      };
      // Unforwarded, those settings apply: the fixture really moves Claude.
      await run();
      expect(bedrock.paths.some((path) => path.includes("/model/"))).toBe(true);
      expect(generation.paths).toEqual([]);
      bedrock.paths.length = 0;
      expect(
        await run({ url: generation.url, noProxy: "127.0.0.1,localhost" }),
      ).toEqual({ ok: true });
      expect(
        generation.paths.some((path) => path.startsWith("/v1/messages")),
      ).toBe(true);
      expect(bedrock.paths).toEqual([]);
    } finally {
      for (const server of servers) server.close();
      await rm(home, { recursive: true, force: true });
    }
  },
  60_000,
);

/** The proxy variables each case names, all at a proxy that takes nothing. */
const PROXIES = [
  ["HTTP(S)_PROXY", ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]],
  ["ALL_PROXY", ["ALL_PROXY", "all_proxy"]],
] as const;

for (const [label, names] of PROXIES)
  it.skipIf(!binary)(
    `keeps a forwarded turn off a proxy the app's environment names in ${label}`,
    async () => {
      const home = await mkdtemp(join(tmpdir(), "buzz-claude-proxy-"));
      const generation = await model();
      // A proxy that takes nothing: a request sent to it never arrives.
      const proxy = await model();
      proxy.server.close();
      const dead = proxy.url;
      try {
        const claude = await ClaudeProcess.start(
          nativeSpawn(home, {
            ...Object.fromEntries(names.map((name) => [name, dead])),
            NO_PROXY: "corp.example",
          }),
          {
            cwd: home,
            systemPrompt: "Reply briefly.",
            model: "claude-sonnet-4-6",
            forward: {
              url: generation.url,
              noProxy: "corp.example,127.0.0.1,localhost",
            },
          },
        );
        try {
          expect(await claude.send("hi")).toEqual({ ok: true });
        } finally {
          await claude.kill();
        }
        expect(
          generation.paths.some((path) => path.startsWith("/v1/messages")),
        ).toBe(true);
      } finally {
        generation.server.close();
        await rm(home, { recursive: true, force: true });
      }
    },
    60_000,
  );
