// The shared ACP client driving a plain-ACP harness, one without hooks.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fakeSpawn as fakeGoose,
  flush,
} from "../../../bundled/goose/goose-testing";
import { SharedProcess } from "../../../bundled/goose/sessions";
import type {
  HostMcpServer,
  HostProcess,
  HostProcessOptions,
} from "../../host/service";
import { AgentSessions, ServerPool, SHARED_POOL } from "./agent-sessions";
import { AcpProcess, REQUEST_TIMEOUT_MS } from "./process";
import type { AcpHooks, ToolServer } from "./types";

type Message = {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
};

const HOOKS: AcpHooks = {
  label: "Harness",
  program: "harness",
  missing: "Install the harness CLI.",
  env: { HOOK: "hook", SHARED: "hook" },
};

const tools: ToolServer = async (_conversation, message) => ({
  jsonrpc: "2.0",
  id: message.id,
  result: {},
});

/** A plain-ACP harness: `capabilities` is what `initialize` advertises. */
function fakeHarness(
  options: Readonly<{
    capabilities?: Record<string, unknown>;
    /** Requests it never answers. */
    silent?: readonly string[];
    /** Exits with this code as soon as it starts, as `env` does for a
     * missing program. */
    exitCode?: number;
    /** Turns stay open until finished. */
    hold?: boolean;
  }> = {},
) {
  const started: { options: HostProcessOptions; killed: boolean }[] = [];
  const received: Message[] = [];
  const turns: { sessionId: string; text: string; finish(): void }[] = [];
  let servers = 0;
  const serve = async (): Promise<HostMcpServer> => {
    const index = ++servers;
    let stopped!: () => void;
    const closed = new Promise<void>((resolve) => (stopped = resolve));
    return {
      url: `http://127.0.0.1:${40_000 + index}/mcp`,
      headers: [{ name: "Authorization", value: `Bearer token-${index}` }],
      close: async () => stopped(),
      closed,
    };
  };
  const spawn = async (
    _id: string,
    process: HostProcessOptions = {},
  ): Promise<HostProcess> => {
    let exit!: (code: number | null) => void;
    const exited = new Promise<number | null>((resolve) => (exit = resolve));
    let alive = true;
    const record = { options: process, killed: false };
    started.push(record);
    const reply = (id: Message["id"], result: unknown) =>
      queueMicrotask(() => {
        if (alive)
          process.onStdout?.(
            `${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`,
          );
      });
    const end = (code: number | null) => {
      if (!alive) return;
      alive = false;
      exit(code);
    };
    if (options.exitCode !== undefined) {
      const code = options.exitCode;
      queueMicrotask(() => {
        process.onStderr?.("env: harness: No such file or directory\n");
        end(code);
      });
    }
    let sessions = 0;
    return {
      write: async (data) => {
        if (!alive) throw new Error("Broken pipe");
        for (const line of data.split("\n").filter(Boolean)) {
          const message = JSON.parse(line) as Message;
          received.push(message);
          const { id, method, params = {} } = message;
          if (!method || options.silent?.includes(method)) continue;
          if (method === "initialize")
            reply(id, {
              protocolVersion: 1,
              agentCapabilities: options.capabilities ?? {
                mcpCapabilities: { http: true },
              },
            });
          else if (method === "session/new")
            reply(id, { sessionId: `session-${++sessions}` });
          else if (method === "session/close") reply(id, {});
          else if (method === "session/prompt") {
            const text = (params.prompt as { text: string }[])[0]?.text ?? "";
            const finish = () => reply(id, { stopReason: "end_turn" });
            turns.push({ sessionId: String(params.sessionId), text, finish });
            if (!options.hold) finish();
          }
        }
      },
      end: async () => undefined,
      kill: async () => {
        record.killed = true;
        end(null);
      },
      exited,
    };
  };
  const sent = (method: string) =>
    received.filter((message) => message.method === method);
  return { spawn, serve, started, received, turns, sent };
}

const start = (
  harness: ReturnType<typeof fakeHarness>,
  launch: Partial<Parameters<typeof AcpProcess.start>[2]> = {},
  hooks: AcpHooks = HOOKS,
) =>
  AcpProcess.start(harness.spawn, hooks, {
    cwd: "/work",
    serve: harness.serve,
    ...launch,
  });

afterEach(() => {
  vi.useRealTimers();
});

describe("starting a harness", () => {
  it("passes the plugin's argv unchanged, with the Buzz identity removed last", async () => {
    const harness = fakeHarness();
    await start(harness, {
      args: ["cursor-agent", "acp", "--model", "x y"],
      env: {
        SHARED: "launch",
        BUZZ_PRIVATE_KEY: "nsec1leak",
        BUZZ_RELAY_URL: "wss://leak",
      },
    });
    const options = harness.started[0]?.options;
    expect(options?.args).toEqual(["cursor-agent", "acp", "--model", "x y"]);
    expect(options?.env).toEqual({
      HOOK: "hook",
      SHARED: "launch",
      BUZZ_PRIVATE_KEY: null,
      BUZZ_AUTH_TAG: null,
      BUZZ_RELAY_URL: null,
    });
  });

  it("refuses a harness that cannot take Buzz tools over HTTP MCP", async () => {
    for (const http of [false, undefined, "yes"]) {
      const harness = fakeHarness({
        capabilities: { mcpCapabilities: { http } },
      });
      await expect(start(harness)).rejects.toThrow(
        "This Harness cannot reach Buzz tools (no HTTP MCP support)",
      );
      expect(harness.started[0]?.killed).toBe(true);
    }
  });

  it("names the install hint when the program is missing or cannot run", async () => {
    for (const exitCode of [127, 126]) {
      const harness = fakeHarness({ exitCode });
      await expect(start(harness)).rejects.toThrow("Install the harness CLI.");
    }
  });

  it("reports another early exit as itself", async () => {
    const harness = fakeHarness({ exitCode: 1 });
    await expect(start(harness)).rejects.toThrow(
      "env: harness: No such file or directory",
    );
  });

  it("stops a harness that never answers initialize", async () => {
    vi.useFakeTimers();
    const harness = fakeHarness({ silent: ["initialize"] });
    const starting = start(harness);
    const failed = expect(starting).rejects.toThrow(
      "Harness did not answer initialize in 60s",
    );
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    await failed;
    expect(harness.started[0]?.killed).toBe(true);
  });

  it("stops the harness when cancelled while it starts", async () => {
    const harness = fakeHarness({ silent: ["initialize"] });
    const controller = new AbortController();
    const starting = start(harness, { signal: controller.signal });
    await flush();
    controller.abort(new Error("Check was cancelled"));
    await expect(starting).rejects.toThrow("Check was cancelled");
    expect(harness.started[0]?.killed).toBe(true);
  });

  it("starts nothing when already cancelled", async () => {
    const harness = fakeHarness();
    const controller = new AbortController();
    controller.abort(new Error("Removed"));
    await expect(start(harness, { signal: controller.signal })).rejects.toThrow(
      "Removed",
    );
    expect(harness.started).toEqual([]);
  });

  it("stops within its time limit, for a check that opens no session", async () => {
    const harness = fakeHarness();
    const acp = await start(harness);
    expect(acp.agentCapabilities).toEqual({ mcpCapabilities: { http: true } });
    await acp.stop();
    expect(harness.started[0]?.killed).toBe(true);
    expect(acp.running).toBe(false);
  });
});

describe("a session without hooks", () => {
  it("leads the first prompt with the instructions, once, when ACP's systemPrompt is not advertised", async () => {
    const harness = fakeHarness();
    const acp = await start(harness);
    const session = await acp.open({ cwd: "/work", systemPrompt: "Be Buzz." });
    const [opened] = harness.sent("session/new");
    expect(opened?.params).not.toHaveProperty("systemPrompt");
    expect(opened?.params).not.toHaveProperty("_meta");
    await session.send("first");
    await session.send("second");
    expect(harness.turns.map((turn) => turn.text)).toEqual([
      "Be Buzz.\n\nfirst",
      "second",
    ]);
  });

  it("sends the instructions as ACP's systemPrompt when advertised", async () => {
    const harness = fakeHarness({
      capabilities: {
        mcpCapabilities: { http: true },
        sessionCapabilities: { systemPrompt: {} },
      },
    });
    const acp = await start(harness);
    const session = await acp.open({ cwd: "/work", systemPrompt: "Be Buzz." });
    expect(harness.sent("session/new")[0]?.params?.systemPrompt).toEqual({
      mode: "append",
      content: [{ type: "text", text: "Be Buzz." }],
    });
    await session.send("first");
    expect(harness.turns.map((turn) => turn.text)).toEqual(["first"]);
  });

  it("queues a message sent mid-turn as the next turn", async () => {
    const harness = fakeHarness({ hold: true });
    const acp = await start(harness);
    const session = await acp.open({ cwd: "/work", systemPrompt: "" });
    const first = session.send("first");
    await flush();
    const second = session.send("second");
    await flush();
    expect(harness.turns.map((turn) => turn.text)).toEqual(["first"]);
    harness.turns[0]?.finish();
    await flush();
    expect(harness.turns.map((turn) => turn.text)).toEqual(["first", "second"]);
    harness.turns[1]?.finish();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { ok: true },
      { ok: true },
    ]);
  });

  it("asks the harness to close a session only when it advertises close", async () => {
    for (const close of [undefined, {}]) {
      const harness = fakeHarness({
        capabilities: {
          mcpCapabilities: { http: true },
          sessionCapabilities: close ? { close } : {},
        },
      });
      const acp = await start(harness);
      const session = await acp.open({ cwd: "/work", systemPrompt: "" });
      await acp.close(session);
      expect(harness.sent("session/cancel")).toHaveLength(1);
      expect(harness.sent("session/close")).toHaveLength(close ? 1 : 0);
      expect(session.open).toBe(false);
    }
  });
});

describe("the shared server pool", () => {
  it("is used by every agent's sessions unless one is given", async () => {
    const harness = fakeHarness();
    const acp = await start(harness);
    const sessions = new AgentSessions({
      label: "Harness",
      spawn: harness.spawn,
      tools,
      process: { get: async () => acp },
      launch: async () => ({ workspace: "/work", systemPrompt: "" }),
      choice: () => ({ provider: "", model: "" }),
      fingerprint: () => "",
    });
    const before = SHARED_POOL.size;
    await sessions.deliver("conversation", "hello", 1);
    expect(SHARED_POOL.size).toBe(before + 1);
    sessions.dispose();
    await flush();
    expect(SHARED_POOL.size).toBe(before);
  });

  it("closes the idle session of either plugin to make room for the other", async () => {
    const pool = new ServerPool(1);
    const goose = fakeGoose({ home: "/home/test" });
    const harness = fakeHarness();
    const launch = async () => ({ workspace: "/work", systemPrompt: "" });
    const choice = () => ({ provider: "", model: "" });
    const gooseSessions = new AgentSessions({
      label: "goose",
      spawn: goose.spawn,
      tools,
      process: new SharedProcess(goose.spawn, goose.serve),
      pool,
      launch,
      choice,
      fingerprint: () => "",
    });
    const acp = await start(harness);
    const genericSessions = new AgentSessions({
      label: "Harness",
      spawn: harness.spawn,
      tools,
      process: { get: async () => acp },
      pool,
      launch,
      choice,
      fingerprint: () => "",
    });

    await gooseSessions.deliver("goose chat", "hello", 1);
    expect(gooseSessions.snapshot().map((item) => item.key)).toEqual([
      "goose chat",
    ]);
    await genericSessions.deliver("generic chat", "hello", 1);
    expect(gooseSessions.snapshot()).toEqual([]);
    expect(genericSessions.snapshot().map((item) => item.key)).toEqual([
      "generic chat",
    ]);
    expect(goose.geese[0]?.closed).toEqual(["session-1"]);

    await gooseSessions.deliver("goose chat", "again", 2);
    expect(genericSessions.snapshot()).toEqual([]);
    expect(pool.size).toBe(1);
    gooseSessions.dispose();
    genericSessions.dispose();
  });
});
