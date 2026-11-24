// @vitest-environment node
// Drives a real `goose-acp` against a scripted local model: run with
// GOOSE_ACP_BIN=/path/to/goose-acp. The owner's goose lives in a temporary
// GOOSE_PATH_ROOT whose saved permissions always allow the shell.
import { execFileSync, spawn as spawnChild } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HostProcessOptions } from "../../features/host/service";
import { nativeToolAllowed } from "../../features/agents/tool-access";
import { respond } from "../../buzz-mcp/rpc";
import { GooseProcess, type Spawn, type ToolServer } from "./goose";
import { serve } from "./live-testing";
import manifest from "./manifest.json";
import { ownerAllows, type GooseRoot } from "./permissions";

const BIN = process.env.GOOSE_ACP_BIN;
const SCRIPT = manifest.host.processes.find((item) => item.id === "goose-root")
  ?.args?.[1] as string;

const spawnWith =
  (env: Record<string, string>): Spawn =>
  async (_id, options: HostProcessOptions = {}) => {
    const merged: Record<string, string | undefined> = {
      ...process.env,
      ...env,
    };
    for (const [key, value] of Object.entries(options.env ?? {}))
      if (value === null) delete merged[key];
      else merged[key] = value;
    const child = spawnChild(BIN ?? "goose-acp", [], {
      cwd: options.cwd,
      env: merged,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8").on("data", (data) => {
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

/** A model that runs each queued shell command in turn, then says done. */
function scriptedModel() {
  const commands: string[] = [];
  let shell = "";
  const server = createServer(async (request, response) => {
    if (request.method === "GET") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({ object: "list", data: [{ id: "gpt-4o" }] }),
      );
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body) as {
      tools?: { function: { name: string } }[];
    };
    shell ||=
      input.tools
        ?.map((tool) => tool.function.name)
        .find((name) => /(^|__)shell$/.test(name)) ?? "";
    const command = commands.shift();
    const delta = command
      ? {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: `call-${commands.length}-${Date.now()}`,
              type: "function",
              function: { name: shell, arguments: JSON.stringify({ command }) },
            },
          ],
        }
      : { role: "assistant", content: "done" };
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const choice of [
      { index: 0, delta, finish_reason: null },
      { index: 0, delta: {}, finish_reason: command ? "tool_calls" : "stop" },
    ])
      response.write(
        `data: ${JSON.stringify({ id: "r", object: "chat.completion.chunk", created: 1, model: "gpt-4o", choices: [choice] })}\n\n`,
      );
    response.end("data: [DONE]\n\n");
  });
  return { server, commands, shellName: () => shell };
}

describe.skipIf(!BIN)("goose-acp with saved permissions", () => {
  const base = mkdtempSync(join(tmpdir(), "buzz-goose-permissions-"));
  const owner = join(base, "owner");
  const work = join(base, "work");
  const ownerPermissions = join(owner, "config", "permission.yaml");
  const model = scriptedModel();
  let env: Record<string, string>;
  let root: GooseRoot;
  /** Saves the owner's goose permissions as goose writes them. */
  const saved = (level: "always_allow" | "ask_before" | "never_allow") =>
    writeFileSync(
      ownerPermissions,
      ["always_allow", "ask_before", "never_allow"]
        .map((key) =>
          key === level
            ? `  ${key}:\n  - ${model.shellName()}\n`
            : `  ${key}: []\n`,
        )
        .reduce((text, line) => text + line, "user:\n"),
    );
  const read = async (path: string) => new Uint8Array(readFileSync(path));

  beforeAll(async () => {
    mkdirSync(join(owner, "config"), { recursive: true });
    mkdirSync(work, { recursive: true });
    writeFileSync(
      join(owner, "config", "config.yaml"),
      "GOOSE_TELEMETRY_ENABLED: false\n",
    );
    await new Promise<void>((resolve) =>
      model.server.listen(0, "127.0.0.1", resolve),
    );
    const address = model.server.address();
    if (!address || typeof address === "string") throw new Error("No port");
    env = {
      OPENAI_API_KEY: "local-test-only",
      OPENAI_HOST: `http://127.0.0.1:${address.port}`,
      OPENAI_BASE_PATH: "v1/chat/completions",
      GOOSE_DISABLE_SESSION_NAMING: "true",
      GOOSE_DISABLE_KEYRING: "1",
    };
    const [path, permissions] = execFileSync(
      "/bin/sh",
      ["-c", SCRIPT, "buzz-goose-root", "agent-a"],
      {
        env: { ...process.env, GOOSE_PATH_ROOT: owner, XDG_DATA_HOME: base },
        encoding: "utf8",
      },
    ).split("\n") as [string, string];
    root = { root: path, permissions };
  });
  afterAll(
    () => new Promise<void>((resolve) => model.server.close(() => resolve())),
  );

  /** Runs one turn of `commands` with `permits` deciding each tool call. */
  async function turn(
    commands: readonly string[],
    gooseRoot: string,
    permits: (name: string) => Promise<boolean>,
    load?: string,
  ) {
    model.commands.push(...commands);
    const tools: ToolServer = async (_conversation, message) =>
      respond(undefined, {}, message);
    const goose = await GooseProcess.start(spawnWith(env), {
      cwd: work,
      serve,
      env: { GOOSE_PATH_ROOT: gooseRoot },
      permits,
    });
    try {
      const session = await goose.open({
        cwd: work,
        systemPrompt: "",
        tools,
        choice: () => ({ provider: "openai", model: "gpt-4o" }),
        ...(load ? { load } : {}),
      });
      const result = await session.send("Run the commands.");
      expect(result.ok).toBe(true);
      return session.id;
    } finally {
      await goose.kill();
    }
  }
  const marker = (name: string) => join(work, name);
  const decide = (config: () => unknown) => (name: string) =>
    Promise.resolve(
      nativeToolAllowed(name, config()) &&
        ownerAllows(read, root.permissions, name),
    ).then((allowed) => allowed);

  it("shows the owner's saved allowance skipping Buzz without isolation", {
    timeout: 120_000,
  }, async () => {
    await turn(["true"], owner, async () => true);
    expect(model.shellName()).toMatch(/shell$/);
    saved("always_allow");
    const asked: string[] = [];
    await turn(["touch unisolated"], owner, async (name) => {
      asked.push(name);
      return false;
    });
    expect(asked).toEqual([]);
    expect(existsSync(marker("unisolated"))).toBe(true);
  });

  it("refuses the next call once the role tightens mid-turn, despite the saved allowance", {
    timeout: 120_000,
  }, async () => {
    const before = readFileSync(ownerPermissions, "utf8");
    expect(before).toContain(`always_allow:\n  - ${model.shellName()}`);
    let config: unknown = { toolPreset: "coder" };
    const asked: string[] = [];
    const id = await turn(
      ["touch first", "touch second"],
      root.root,
      async (name) => {
        asked.push(name);
        const allowed = await decide(() => config)(name);
        config = { toolPreset: "reviewer" };
        return allowed;
      },
    );
    expect(asked).toHaveLength(2);
    expect(existsSync(marker("first"))).toBe(true);
    expect(existsSync(marker("second"))).toBe(false);
    expect(readFileSync(ownerPermissions, "utf8")).toBe(before);
    expect(existsSync(join(root.root, "config", "permission.yaml.lock"))).toBe(
      false,
    );

    // The saved session resumes from the owner's linked data, still decided
    // by the current role.
    await turn(
      ["touch resumed"],
      root.root,
      decide(() => config),
      id,
    );
    expect(existsSync(marker("resumed"))).toBe(false);
  });

  it("keeps an owner denial added while the agent runs, even when Custom allows the tool", {
    timeout: 120_000,
  }, async () => {
    const custom = { toolPreset: "custom", toolAllow: "native:shell" };
    let calls = 0;
    await turn(["touch allowed", "touch denied"], root.root, async (name) => {
      if (++calls === 2) saved("never_allow");
      return decide(() => custom)(name);
    });
    expect(existsSync(marker("allowed"))).toBe(true);
    expect(existsSync(marker("denied"))).toBe(false);
    saved("ask_before");
    await turn(
      ["touch asked"],
      root.root,
      decide(() => custom),
    );
    expect(existsSync(marker("asked"))).toBe(false);
  });

  it("gives each agent its own root that links everything but the permission file", () => {
    const other = execFileSync(
      "/bin/sh",
      ["-c", SCRIPT, "buzz-goose-root", "agent-b"],
      {
        env: { ...process.env, GOOSE_PATH_ROOT: owner, XDG_DATA_HOME: base },
        encoding: "utf8",
      },
    ).split("\n")[0] as string;
    expect(other).not.toBe(root.root);
    for (const path of [root.root, other]) {
      expect(existsSync(join(path, "config", "config.yaml"))).toBe(true);
      expect(existsSync(join(path, "config", "permission.yaml"))).toBe(false);
      expect(existsSync(join(path, "data"))).toBe(true);
    }
  });
});
