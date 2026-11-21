// The shared ACP client driving a plain-ACP harness, one without hooks.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fakeSpawn as fakeGoose,
  flush,
} from "../../../bundled/goose/goose-testing";
import { GOOSE } from "../../../bundled/goose/goose";
import { AgentProcess } from "../../../bundled/goose/sessions";
import type {
  HostMcpServer,
  HostProcess,
  HostProcessOptions,
} from "../../host/service";
import {
  AgentSessions,
  association,
  digest,
  type Exclusive,
  type SavedConversation,
  savedConversation,
  ServerPool,
  SHARED_POOL,
} from "./agent-sessions";
import { AcpProcess, REQUEST_TIMEOUT_MS, TOOL_SERVER } from "./process";
import { AcpSession } from "./session";
import { readTranscript } from "./transcript";
import type { AcpHooks, Mark, Pinned, ToolServer } from "./types";

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
    /** `session/close` waits in `closes` until called. */
    holdClose?: boolean;
    /** Requests it answers with an error. */
    refuse?: readonly string[];
    /** Exits with this code as soon as it starts, as `env` does for a
     * missing program. */
    exitCode?: number;
    /** Turns stay open until finished. */
    hold?: boolean;
    /** Session ids name their process, and a cancel ends its session's turn. */
    cancels?: boolean;
    /** Kill asks it to stop, and it never exits. */
    holdExit?: boolean;
    /** Rejects this many prompts first, as a harness signed out does. */
    rejectPrompts?: number;
    /** Every prompt is answered with this error. */
    promptError?: { code: number; message: string };
    /** Why a turn that ran ends. */
    stopReason?: string;
    /** The option state sessions open, resume and load with. */
    configOptions?: Record<string, unknown>[];
    /** Updates `session/load` replays before it answers. */
    replay?: Record<string, unknown>[];
    /** What `session/load` and `session/resume` answer, instead of the
     * option state. */
    reopened?: Record<string, unknown>;
    /** `session/load` and `session/resume` wait in `reopens` until called. */
    holdReopen?: boolean;
    /** Every `session/load` is answered with this error. */
    loadError?: { code: number; message: string };
    /** Every `session/load` is answered with this result; `{}` by default. */
    loadResult?: unknown;
    /** Every `session/close` is answered with this error. */
    closeError?: { code: number; message: string };
  }> = {},
) {
  const started: {
    options: HostProcessOptions;
    killed: boolean;
    kills: number;
  }[] = [];
  const received: Message[] = [];
  const turns: {
    sessionId: string;
    text: string;
    steered: string[];
    finish(
      error?: { code: number; message: string },
      stopReason?: string,
    ): void;
  }[] = [];
  const reopens: (() => void)[] = [];
  // Only a fake set up to reopen answers `session/load` as one; the rest
  // replay as goose does.
  const reopening =
    options.replay !== undefined ||
    options.reopened !== undefined ||
    options.holdReopen === true ||
    options.configOptions !== undefined;
  const closes: (() => void)[] = [];
  let servers = 0;
  let rejectPrompts = options.rejectPrompts ?? 0;
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
    const record = { options: process, killed: false, kills: 0 };
    started.push(record);
    const send = (message: Record<string, unknown>) =>
      queueMicrotask(() => {
        if (alive)
          process.onStdout?.(
            `${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`,
          );
      });
    const reply = (id: Message["id"], result: unknown) => send({ id, result });
    /** Each session's running turn. */
    const running = new Map<string, (typeof turns)[number]>();
    const run = (sessionId: string, runId: string | null) =>
      send({
        method: "session/update",
        params: { sessionId, update: { sessionUpdate: "run", runId } },
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
          if (options.refuse?.includes(method)) {
            send({ id, error: { code: -32000, message: `${method} refused` } });
            continue;
          }
          if (method === "initialize")
            reply(id, {
              protocolVersion: 1,
              agentCapabilities: options.capabilities ?? {
                mcpCapabilities: { http: true },
              },
            });
          else if (method === "session/new")
            reply(id, {
              sessionId: options.cancels
                ? `session-${started.indexOf(record) + 1}-${++sessions}`
                : `session-${++sessions}`,
              configOptions: options.configOptions,
            });
          else if (
            method === "session/resume" ||
            (method === "session/load" && reopening)
          ) {
            const answer = () => {
              for (const update of options.replay ?? [])
                send({
                  method: "session/update",
                  params: { sessionId: params.sessionId, update },
                });
              reply(
                id,
                options.reopened ?? { configOptions: options.configOptions },
              );
            };
            if (options.holdReopen) reopens.push(answer);
            else answer();
          } else if (method === "session/set_config_option") {
            for (const option of options.configOptions ?? [])
              if (option.id === params.configId)
                option.currentValue = params.value;
            reply(id, { configOptions: options.configOptions });
          } else if (method === "session/close" && options.closeError)
            send({ id, error: options.closeError });
          else if (method === "session/close" && options.holdClose)
            closes.push(() => reply(id, {}));
          else if (method === "session/close") reply(id, {});
          else if (method === "session/load" && options.loadError)
            send({ id, error: options.loadError });
          else if (method === "session/load") {
            // As goose does: the saved conversation replays before the answer.
            for (const sessionUpdate of ["user_message_chunk", "tool_call"])
              send({
                method: "session/update",
                params: {
                  sessionId: params.sessionId,
                  update: { sessionUpdate, toolCallId: "call-1" },
                },
              });
            reply(id, "loadResult" in options ? options.loadResult : {});
          } else if (method === "session/prompt" && rejectPrompts > 0) {
            rejectPrompts--;
            send({ id, error: { code: -32000, message: "Sign in first" } });
          } else if (method === "session/prompt" && options.promptError)
            send({ id, error: options.promptError });
          else if (method === "session/prompt") {
            const sessionId = String(params.sessionId);
            const text = (params.prompt as { text: string }[])[0]?.text ?? "";
            const runId = `run-${turns.length + 1}`;
            const turn = {
              sessionId,
              text,
              steered: [] as string[],
              finish: (
                error?: { code: number; message: string },
                stopReason = options.stopReason ?? "end_turn",
              ) => {
                running.delete(sessionId);
                run(sessionId, null);
                if (error) send({ id, error });
                else reply(id, { stopReason });
              },
            };
            turns.push(turn);
            running.set(sessionId, turn);
            run(sessionId, runId);
            if (!options.hold) turn.finish();
          } else if (method === "session/cancel" && options.cancels)
            running
              .get(String(params.sessionId))
              ?.finish(undefined, "cancelled");
          else if (method === "steer") {
            const turn = running.get(String(params.sessionId));
            if (turn && `run-${turns.indexOf(turn) + 1}` === params.runId) {
              turn.steered.push(String(params.text));
              reply(id, {});
            } else
              send({ id, error: { code: -32602, message: "No active run" } });
          }
        }
      },
      end: async () => undefined,
      kill: async () => {
        record.killed = true;
        record.kills++;
        if (!options.holdExit) end(null);
      },
      exited,
    };
  };
  const sent = (method: string) =>
    received.filter((message) => message.method === method);
  return { spawn, serve, started, received, turns, sent, reopens, closes };
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

  it("still fails a start at its time limit when the harness never exits, and gives the caller the harness", async () => {
    vi.useFakeTimers();
    const harness = fakeHarness({
      capabilities: { mcpCapabilities: { http: false } },
      holdExit: true,
    });
    let given: AcpProcess | undefined;
    let failure: unknown;
    const starting = start(harness, {
      onProcess: (acp) => (given = acp),
    }).catch((error: unknown) => {
      failure = error;
    });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(harness.started[0]?.killed).toBe(true);
    expect(given?.running).toBe(true);
    expect(failure).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await starting;
    expect(failure).toEqual(
      new Error("This Harness cannot reach Buzz tools (no HTTP MCP support)"),
    );
    expect(given?.running).toBe(true);
  });

  const diagnosing: AcpHooks = { ...HOOKS, diagnoseStartup: true };

  it("names the install hint when the program is missing or cannot run", async () => {
    for (const exitCode of [127, 126]) {
      const harness = fakeHarness({ exitCode });
      await expect(start(harness, {}, diagnosing)).rejects.toThrow(
        "Install the harness CLI.",
      );
    }
  });

  it("reports another early exit as itself", async () => {
    const harness = fakeHarness({ exitCode: 1 });
    await expect(start(harness, {}, diagnosing)).rejects.toThrow(
      "env: harness: No such file or directory",
    );
  });

  it("reports goose's early exit by its code alone", async () => {
    for (const exitCode of [1, 127]) {
      const harness = fakeHarness({ exitCode });
      await expect(start(harness, {}, GOOSE)).rejects.toThrow(
        new Error(`goose exited (${exitCode})`),
      );
    }
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

  it("rejects at once when cancelled while it starts, even if it never exits", async () => {
    const harness = fakeHarness({ silent: ["initialize"], holdExit: true });
    const controller = new AbortController();
    const starting = start(harness, { signal: controller.signal });
    await flush();
    controller.abort(new Error("Check was cancelled"));
    await expect(starting).rejects.toThrow("Check was cancelled");
    expect(harness.started[0]?.killed).toBe(true);
  });

  it("leaves no request deadline behind when cancelled while it starts", async () => {
    vi.useFakeTimers();
    const harness = fakeHarness({ silent: ["initialize"], holdExit: true });
    const controller = new AbortController();
    const starting = start(harness, { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(new Error("Check was cancelled"));
    await expect(starting).rejects.toThrow("Check was cancelled");
    // Only the background stop's own wait is left.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    expect(harness.started[0]?.kills).toBe(1);
  });

  it("rejects at once when cancelled while the host is still starting it, and stops the late harness", async () => {
    const harness = fakeHarness();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const spawn: typeof harness.spawn = async (...args) => {
      await gate;
      return harness.spawn(...args);
    };
    const controller = new AbortController();
    const starting = AcpProcess.start(spawn, HOOKS, {
      cwd: "/work",
      serve: harness.serve,
      signal: controller.signal,
    });
    const outcome = starting.then(
      () => "started",
      (error: Error) => error.message,
    );
    await flush();
    controller.abort(new Error("Check was cancelled"));
    await flush();
    expect(await Promise.race([outcome, Promise.resolve("pending")])).toBe(
      "Check was cancelled",
    );
    expect(harness.started).toEqual([]);
    release();
    await flush();
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

  it("gives up waiting at the time limit for a harness that never exits", async () => {
    vi.useFakeTimers();
    const harness = fakeHarness({ holdExit: true });
    const acp = await start(harness);
    let stopped = false;
    const stopping = acp.stop(1_000).then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await stopping;
    expect(harness.started[0]?.killed).toBe(true);
    expect(harness.sent("session/new")).toEqual([]);
  });
});

describe("a session with a steering hook", () => {
  it("steers a message sent while the next turn picks its model into that turn, not the finished one", async () => {
    let selecting: (() => void) | undefined;
    const hooks: AcpHooks = {
      ...HOOKS,
      steering: {
        runId: (update) =>
          update.sessionUpdate !== "run"
            ? null
            : typeof update.runId === "string"
              ? update.runId
              : undefined,
        steer: async (acp, sessionId, runId, text) => {
          await acp.request("steer", { sessionId, runId, text });
        },
      },
      // The second turn's model pick waits until released.
      select: (_acp, session, want) =>
        want.model === "slow"
          ? new Promise<void>((resolve) => {
              selecting = () => {
                session.chosen = want;
                resolve();
              };
            })
          : Promise.resolve(),
    };
    const harness = fakeHarness({ hold: true });
    const acp = await start(harness, {}, hooks);
    const session = await acp.open({
      cwd: "/work",
      systemPrompt: "",
      choice: () => ({ provider: "", model: "" }),
    });
    const first = session.send("first");
    await flush();
    // Another model: queued as the next turn rather than steered.
    const second = session.send("second", {}, "slow");
    await flush();
    harness.turns[0]?.finish();
    await flush();
    expect(selecting).toBeDefined();
    const third = session.send("third");
    await flush();
    selecting?.();
    await flush();
    expect(harness.turns.map((turn) => turn.text)).toEqual(["first", "second"]);
    expect(harness.turns[1]?.steered).toEqual(["third"]);
    harness.turns[1]?.finish();
    await expect(Promise.all([first, second, third])).resolves.toHaveLength(3);
  });
  it("confirms delivery when the run starts before a later prompt error", async () => {
    const hooks: AcpHooks = {
      ...HOOKS,
      steering: {
        runId: (update) =>
          update.sessionUpdate === "run" && typeof update.runId === "string"
            ? update.runId
            : null,
        steer: async () => {},
      },
    };
    const harness = fakeHarness({ hold: true });
    const acp = await start(harness, {}, hooks);
    const session = await acp.open({ cwd: "/work", systemPrompt: "" });
    const delivered = vi.fn();
    const settled = vi.fn();
    const prompt = session.send("first", { delivered }).then(settled);
    try {
      await flush();
      expect(harness.turns).toHaveLength(1);
      expect(settled).not.toHaveBeenCalled();
      expect(delivered).toHaveBeenCalledOnce();
      harness.turns[0]?.finish({ code: -32000, message: "Run failed" });
      await prompt;
      expect(settled).toHaveBeenCalledWith(
        expect.objectContaining({ ok: false, error: "Run failed" }),
      );
      expect(delivered).toHaveBeenCalledOnce();
    } finally {
      await acp.stop();
    }
  });

  it("never steers a message stopped while it waits for the run's id", async () => {
    const hooks: AcpHooks = {
      ...HOOKS,
      steering: {
        // The run's id comes only when the test announces it.
        runId: (update) =>
          update.sessionUpdate === "announce" ? String(update.runId) : null,
        steer: async (acp, sessionId, runId, text) => {
          await acp.request("steer", { sessionId, runId, text });
        },
      },
    };
    const harness = fakeHarness({ hold: true });
    const acp = await start(harness, {}, hooks);
    const session = await acp.open({ cwd: "/work", systemPrompt: "" });
    const first = session.send("first");
    await flush();
    const second = session.send("second");
    await flush();
    session.interrupt();
    session.update({ sessionUpdate: "announce", runId: "run-1" });
    await flush();
    expect(harness.sent("steer")).toEqual([]);
    harness.turns[0]?.finish();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });
});

describe("a session without hooks", () => {
  it("lets an observer see each update and whether a prompt is in flight", async () => {
    const harness = fakeHarness({ hold: true });
    const acp = await start(harness);
    const session = await acp.open({ cwd: "/work", systemPrompt: "" });
    const seen: [unknown, boolean][] = [];
    // The fake harness also announces its runs.
    session.observe = (update, prompting) => {
      if (update.sessionUpdate !== "run")
        seen.push([update.sessionUpdate, prompting]);
    };
    // Outside a prompt, as a replay would arrive.
    session.update({ sessionUpdate: "tool_call_update" });
    const turn = session.send("first");
    await flush();
    session.update({ sessionUpdate: "tool_call" });
    harness.turns[0]?.finish();
    await turn;
    session.update({ sessionUpdate: "tool_call_update" });
    expect(seen).toEqual([
      ["tool_call_update", false],
      ["tool_call", true],
      ["tool_call_update", false],
    ]);
  });
  it("handles each update and answer even when its observer throws", async () => {
    const harness = fakeHarness();
    const acp = await start(harness);
    const session = await acp.open({ cwd: "/work", systemPrompt: "" });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    session.observe = () => {
      throw new Error("observer broke");
    };
    try {
      await expect(session.send("first")).resolves.toMatchObject({ ok: true });
      expect(logged).toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

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

  it("keeps the instructions for the next prompt when the first is rejected", async () => {
    const harness = fakeHarness({ rejectPrompts: 1 });
    const acp = await start(harness);
    const session = await acp.open({ cwd: "/work", systemPrompt: "Be Buzz." });
    await expect(session.send("first")).resolves.toMatchObject({
      ok: false,
      error: "Sign in first",
    });
    await expect(session.send("second")).resolves.toMatchObject({ ok: true });
    expect(harness.turns.map((turn) => turn.text)).toEqual([
      "Be Buzz.\n\nsecond",
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

  it("answers a check of work only while that work runs, not for work after it", async () => {
    const harness = fakeHarness({ hold: true });
    const acp = await start(harness);
    const session = await acp.open({ cwd: "/work", systemPrompt: "" });
    const before = session.current();
    const first = session.send("first");
    await flush();
    const current = session.current();
    expect(current()).toBe(true);
    harness.turns[0]?.finish();
    await expect(first).resolves.toEqual({ ok: true });
    expect(current()).toBe(false);

    const second = session.send("second");
    await flush();
    expect(session.current()()).toBe(true);
    expect(current()).toBe(false);
    expect(before()).toBe(false);
    harness.turns[1]?.finish();
    await second;
  });

  it("cancels captured work on Stop, final settlement, failure and close, independently per session", async () => {
    const harness = fakeHarness({ hold: true });
    const acp = await start(harness);
    const session = await acp.open({ cwd: "/work", systemPrompt: "" });
    const other = await acp.open({ cwd: "/work", systemPrompt: "" });
    expect(session.signal.aborted).toBe(true);
    const first = session.send("first");
    const parallel = other.send("other");
    await flush();
    const old = session.signal;
    const isolated = other.signal;
    session.interrupt();
    expect(old.aborted).toBe(true);
    expect(isolated.aborted).toBe(false);
    const second = session.send("second");
    expect(session.signal.aborted).toBe(true);
    harness.turns[0]?.finish();
    await flush();
    const fresh = session.signal;
    expect(fresh).not.toBe(old);
    expect(fresh.aborted).toBe(false);
    expect(old.aborted).toBe(true);
    session.finished("final-call");
    expect(fresh.aborted).toBe(true);
    expect(session.working).toBe(true);
    await second;
    harness.turns[2]?.finish();
    await first;
    await acp.close(other);
    expect(isolated.aborted).toBe(true);
    await parallel;
    const failed = session.send("failure");
    await flush();
    const failing = session.signal;
    session.fail("failure");
    expect(failing.aborted).toBe(true);
    await expect(failed).resolves.toMatchObject({ ok: false });
  });

  it("aborts work when a prompt fails, without waiting for a process close", async () => {
    const harness = fakeHarness({
      promptError: { code: -32000, message: "failed" },
    });
    const acp = await start(harness);
    const session = await acp.open({ cwd: "/work", systemPrompt: "" });
    const done = session.send("first");
    const signal = session.signal;
    expect(signal.aborted).toBe(false);
    await expect(done).resolves.toMatchObject({ ok: false });
    expect(signal.aborted).toBe(true);
    expect(session.open).toBe(true);
  });

  it("forwards an aborted signal before session/new and while idle, and aborts active calls on process exit", async () => {
    const fake = fakeGoose({ hold: true });
    const signals: AbortSignal[] = [];
    const handler: ToolServer = async (_conversation, message, signal) => {
      if (!signal) throw new Error("Missing cancellation");
      signals.push(signal);
      return { jsonrpc: "2.0", id: message.id, result: {} };
    };
    const acp = await AcpProcess.start(fake.spawn, GOOSE, {
      cwd: "/work",
      serve: async (dispatch) => {
        await dispatch({ id: 1, method: "tools/list" });
        return fake.serve(dispatch);
      },
    });
    const session = await acp.open({
      cwd: "/work",
      systemPrompt: "",
      tools: handler,
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
    const process = fake.geese[0];
    if (!process) throw new Error("Missing process");
    await process.mcp(session.id, "tools/list");
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    const done = session.send("first");
    await vi.waitFor(() => expect(process.turns).toHaveLength(1));
    await process.mcp(session.id, "tools/call", { name: "fixture" });
    const active = signals.at(-1);
    expect(active?.aborted).toBe(false);
    process.exit(1, "failed");
    await acp.exited;
    expect(active?.aborted).toBe(true);
    await expect(done).resolves.toMatchObject({ ok: false });
  });

  it("keeps the harness's error code on a failed turn", async () => {
    const harness = fakeHarness({
      promptError: { code: -32000, message: "Authentication required" },
    });
    const acp = await start(harness);
    const session = await acp.open({ cwd: "/work", systemPrompt: "" });
    await expect(session.send("first")).resolves.toEqual({
      ok: false,
      error: "Authentication required",
      code: -32000,
    });
  });

  it("drops an earlier prompt's error code when a later one is refused", async () => {
    const harness = fakeHarness({ rejectPrompts: 1, stopReason: "refusal" });
    const acp = await start(harness);
    const session = await acp.open({ cwd: "/work", systemPrompt: "" });
    void session.send("first");
    // The latest message owns the burst's error.
    await expect(session.send("second")).resolves.toEqual({
      ok: false,
      error: "Harness refused the request",
    });
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

  it("tears down a session resumed under a closed id, though the harness cannot close it", async () => {
    const harness = fakeHarness({
      capabilities: { mcpCapabilities: { http: true }, loadSession: true },
    });
    const servers: HostMcpServer[] = [];
    const acp = await start(harness, {
      serve: async () => {
        const server = await harness.serve();
        servers.push(server);
        return server;
      },
    });
    const closed = (index: number) =>
      Promise.race([
        servers[index]?.closed.then(() => true),
        flush().then(() => false),
      ]);
    const first = await acp.open({ cwd: "/work", systemPrompt: "", tools });
    await acp.close(first);
    expect(await closed(0)).toBe(true);
    const resumed = await acp.open({
      cwd: "/work",
      systemPrompt: "",
      tools,
      resume: first.id,
    });
    await acp.close(resumed);
    expect(await closed(1)).toBe(true);
    expect(resumed.open).toBe(false);
    expect(harness.sent("session/cancel")).toHaveLength(2);
  });
});

describe("the shared server pool", () => {
  it("is used by every agent's sessions unless one is given", async () => {
    const harness = fakeHarness();
    const acp = await start(harness);
    const sessions = new AgentSessions({
      label: "Harness",
      resolveDirectory: async (path) => path,
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
      resolveDirectory: goose.resolveDirectory,
      tools,
      process: new AgentProcess(goose, goose.serve),
      pool,
      launch,
      choice,
      fingerprint: () => "",
    });
    const acp = await start(harness);
    const genericSessions = new AgentSessions({
      label: "Harness",
      resolveDirectory: async (path) => path,
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

/** A pinned agent's sessions over `harness`: `settings` is what `pin` reads
 * now, and `gates` delays an opening's launch until released. */
function pinnedSessions(
  harness: ReturnType<typeof fakeHarness>,
  o: Readonly<{
    saved?: Record<string, SavedConversation>;
    configOptions?: true;
    restart?: () => Promise<{ ok: true }>;
    hooks?: AcpHooks;
    prompt?: () => string;
  }> = {},
) {
  const settings = { localKey: "a", context: "ctx", generation: 1 };
  const records = new Map(Object.entries(o.saved ?? {}));
  const writes: string[] = [];
  const holds: { generation: number; released: number }[] = [];
  const gates: Promise<void>[] = [];
  const processes = new Map<number, Promise<AcpProcess>>();
  const process = (id: number) => {
    if (!processes.has(id)) processes.set(id, start(harness, {}, o.hooks));
    return processes.get(id) as Promise<AcpProcess>;
  };
  const sessions = new AgentSessions<{ scope: string }>({
    label: "Harness",
    resolveDirectory: async (path) => path,
    tools,
    pool: new ServerPool(),
    process: {
      get: async () => process(0),
      at: async (generation) => process(generation.id),
      hold: (generation) => {
        const hold = { generation: generation.id, released: 0 };
        holds.push(hold);
        return { release: () => void hold.released++ };
      },
      ...(o.restart ? { restart: o.restart } : {}),
    },
    launch: async () => ({ workspace: "/work", systemPrompt: "" }),
    choice: () => ({ provider: "", model: "" }),
    fingerprint: () => "",
    resume: true,
    ...(o.configOptions ? { configOptions: true } : {}),
    store: {
      set: () => undefined,
      get: (key) => records.get(key),
      load: (key) => records.get(key),
      touch: () => undefined,
      advance: (key, commit) => {
        writes.push(`advance ${key} ${commit.id} ${commit.covered.at}`);
        records.set(key, { at: 0, ...commit });
      },
      drop: (key) => {
        writes.push(`drop ${key}`);
        records.delete(key);
      },
    },
    pin: (): Pinned<{ scope: string }> => ({
      snapshot: { scope: settings.localKey },
      context: settings.context,
      localKey: settings.localKey,
      generation: { id: settings.generation, launch: settings.generation },
    }),
    launchFor: async () => {
      await gates.shift();
      return { workspace: "/work", systemPrompt: o.prompt?.() ?? "" };
    },
    pickFor: (_pinned, override) => ({ pick: override ?? {}, source: {} }),
  });
  const gate = () => {
    let open!: () => void;
    gates.push(new Promise<void>((resolve) => (open = resolve)));
    return () => open();
  };
  return { sessions, settings, records, writes, holds, gate };
}

/** The saved context of a session opened on `ctx` with an empty prompt. */
const SAVED = `ctx.${digest("")}`;

/** Lets the fake harness run until `ready` holds. */
async function until(ready: () => boolean) {
  for (let i = 0; i < 50 && !ready(); i++) await flush();
  expect(ready()).toBe(true);
}

const build =
  (at: number) => async (): Promise<{ text: string; through: Mark }> => ({
    text: `through ${at}`,
    through: { at, ids: [`e${at}`] },
  });

describe("a pinned session's record", () => {
  it("is kept by the replacement when a retired opening finishes after it", async () => {
    const harness = fakeHarness({
      holdReopen: true,
      capabilities: { mcpCapabilities: { http: true }, loadSession: true },
    });
    const saved = {
      chat: { at: 0, id: "saved-S", covered: 0, context: SAVED },
    };
    const { sessions, records, writes, holds } = pinnedSessions(harness, {
      saved,
    });
    const a = sessions.deliver("chat", "a", 1, { build: build(1) });
    await until(() => harness.reopens.length === 1);
    sessions.restart();
    expect(await sessions.deliver("chat", "b", 2, { build: build(2) })).toEqual(
      expect.objectContaining({ ok: true }),
    );
    harness.reopens[0]?.();
    expect(await a).toEqual(expect.objectContaining({ ok: true }));
    await flush();
    // B opened new while A still loaded saved-S: they never share it.
    expect(harness.sent("session/new")).toHaveLength(1);
    expect(harness.turns.map((turn) => turn.sessionId)).toEqual([
      "session-1",
      "saved-S",
    ]);
    expect(writes).toEqual(["drop chat", "advance chat session-1 2"]);
    expect(records.get("chat")?.id).toBe("session-1");
    expect(holds[0]).toEqual({ generation: 1, released: 1 });
    sessions.dispose();
  });

  it("is stopped with its successor when Stop comes while New session waits for them", async () => {
    const harness = fakeHarness({ hold: true });
    const { sessions } = pinnedSessions(harness);
    const a = sessions.deliver("chat", "a", 1, { build: build(1) });
    await until(() => harness.turns.length === 1);
    sessions.restart();
    const b = sessions.deliver("chat", "b", 2, { build: build(2) });
    await until(() => harness.turns.length === 2);
    const reset = sessions.reset("chat", "new");
    await flush();
    await sessions.interrupt("chat");
    expect(
      harness.sent("session/cancel").map((m) => m.params?.sessionId),
    ).toEqual(expect.arrayContaining(["session-1", "session-2"]));
    for (const turn of harness.turns) turn.finish();
    await Promise.all([a, b, reset]);
    sessions.dispose();
  });

  it("is never written by a busy session retired mid-turn, in either finish order", async () => {
    for (const aFirst of [true, false]) {
      const harness = fakeHarness({ hold: true });
      const { sessions, records, writes } = pinnedSessions(harness);
      const a = sessions.deliver("chat", "a", 1, { build: build(1) });
      await until(() => harness.turns.length === 1);
      sessions.restart();
      expect(writes).toEqual(["drop chat"]);
      const b = sessions.deliver("chat", "b", 2, { build: build(2) });
      await until(() => harness.turns.length === 2);
      const [first, second] = aFirst ? [0, 1] : [1, 0];
      harness.turns[first]?.finish();
      await flush();
      harness.turns[second]?.finish();
      await Promise.all([a, b]);
      await flush();
      // B opened new: it never resumed A's running session.
      expect(harness.sent("session/resume")).toEqual([]);
      expect(writes).toEqual(["drop chat", "advance chat session-2 2"]);
      expect(records.get("chat")?.id).toBe("session-2");
      sessions.dispose();
    }
  });

  it("resumes a saved session whose context matches, and drops one that doesn't", async () => {
    const saved = { chat: { at: 0, id: "old", covered: 4, context: SAVED } };
    const harness = fakeHarness({
      capabilities: {
        mcpCapabilities: { http: true },
        sessionCapabilities: { resume: {} },
      },
    });
    const one = pinnedSessions(harness, { saved });
    await one.sessions.deliver("chat", "hi", 5, {
      build: async (from) => ({
        text: `from ${from.at}`,
        through: { at: 5, ids: ["e5"] },
      }),
    });
    expect(harness.sent("session/resume")[0]?.params?.sessionId).toBe("old");
    expect(harness.turns[0]).toEqual(
      expect.objectContaining({ sessionId: "old", text: "from 4" }),
    );
    one.sessions.dispose();

    const other = pinnedSessions(harness, {
      saved: { chat: { ...saved.chat, context: "other" } },
    });
    await other.sessions.deliver("chat", "hi", 5, { build: build(5) });
    expect(other.writes[0]).toBe("drop chat");
    expect(harness.sent("session/new")).toHaveLength(1);
    other.sessions.dispose();
  });

  it("follows a prompt given in place, so it never resumes on the old one", async () => {
    let prompt = "one";
    const reprompted: string[] = [];
    const hooks: AcpHooks = {
      ...HOOKS,
      systemPrompt: async (_acp, _id, text) => void reprompted.push(text),
    };
    const harness = fakeHarness({ hold: true });
    const { sessions, records } = pinnedSessions(harness, {
      hooks,
      prompt: () => prompt,
    });
    const a = sessions.deliver("chat", "a", 1, { build: build(1) });
    await until(() => harness.turns.length === 1);
    harness.turns[0]?.finish();
    await a;
    expect(records.get("chat")?.context).toBe(`ctx.${digest("one")}`);
    prompt = "two";
    const b = sessions.deliver("chat", "b", 2, { build: build(2) });
    await until(() => harness.turns.length === 2);
    // Given at open, then in place; the record follows before the turn ends.
    expect(reprompted).toEqual(["one", "two"]);
    expect(harness.sent("session/new")).toHaveLength(1);
    expect(records.get("chat")?.context).toBe(`ctx.${digest("two")}`);
    harness.turns[1]?.finish();
    await b;
    sessions.dispose();
  });

  it("is dropped by a new-session reset", async () => {
    const harness = fakeHarness();
    const { sessions, writes } = pinnedSessions(harness);
    await sessions.deliver("chat", "a", 1, { build: build(1) });
    await sessions.reset("chat", "new");
    expect(writes).toEqual(["advance chat session-1 1", "drop chat"]);
    sessions.dispose();
  });

  it("is dropped by a new-session reset once its session has gone idle", async () => {
    const harness = fakeHarness();
    const saved = { chat: { at: 0, id: "old", covered: 0, context: SAVED } };
    const { sessions, writes } = pinnedSessions(harness, { saved });
    await sessions.reset("chat", "new");
    expect(writes).toEqual(["drop chat"]);
    await sessions.deliver("chat", "a", 1, { build: build(1) });
    expect(harness.sent("session/resume")).toHaveLength(0);
    expect(harness.sent("session/new")).toHaveLength(1);
    sessions.dispose();
  });
});

describe("a pinned session's launch generation", () => {
  it("opens on the generation pinned before a save, and releases its hold once, after idle", async () => {
    const harness = fakeHarness({ hold: true });
    const { sessions, settings, holds, gate } = pinnedSessions(harness);
    const late = gate();
    const a = sessions.deliver("chat", "a", 1);
    settings.localKey = "b";
    settings.generation = 2;
    sessions.reconfigure();
    late();
    await until(() => harness.turns.length === 1);
    expect(holds).toEqual([{ generation: 1, released: 0 }]);
    // A final Buzz send would settle early; the hold waits for the prompt.
    harness.turns[0]?.finish();
    await a;
    await flush();
    expect(holds).toEqual([{ generation: 1, released: 1 }]);
    const b = sessions.deliver("chat", "b", 2);
    await until(() => harness.turns.length === 2);
    harness.turns[1]?.finish();
    await b;
    expect(harness.started).toHaveLength(2);
    expect(holds[1]?.generation).toBe(2);
    sessions.dispose();
  });

  it("releases the hold of an opening that fails", async () => {
    const harness = fakeHarness({ silent: [], exitCode: 1 });
    const { sessions, holds } = pinnedSessions(harness);
    const result = await sessions.deliver("chat", "a", 1);
    expect(result.ok).toBe(false);
    expect(holds).toEqual([{ generation: 1, released: 1 }]);
    sessions.dispose();
  });
});

describe("shutdown after a pinned session is retired or not resumed", () => {
  const closing = { resume: {}, close: {} };
  it("opens new rather than resume a retired session whose close is pending", async () => {
    const harness = fakeHarness({
      holdClose: true,
      capabilities: {
        mcpCapabilities: { http: true },
        sessionCapabilities: closing,
      },
    });
    const { sessions, settings, records } = pinnedSessions(harness);
    await sessions.deliver("chat", "a", 1, { build: build(1) });
    expect(records.get("chat")?.id).toBe("session-1");
    settings.localKey = "b";
    sessions.reconfigure();
    await until(() => harness.closes.length === 1);
    await sessions.deliver("chat", "b", 2, { build: build(2) });
    // Its late close must not unload the session B runs on.
    expect(harness.sent("session/resume")).toEqual([]);
    expect(harness.sent("session/new")).toHaveLength(2);
    harness.closes[0]?.();
    sessions.dispose();
  });

  it.each([
    ["can't close sessions", { resume: {} }, []],
    ["refuses the close", closing, ["session/close"]],
  ])(
    "resumes a retired session again when its harness %s",
    async (_case, sessionCapabilities, refuse) => {
      const harness = fakeHarness({
        refuse,
        capabilities: { mcpCapabilities: { http: true }, sessionCapabilities },
      });
      const { sessions, settings } = pinnedSessions(harness);
      await sessions.deliver("chat", "a", 1, { build: build(1) });
      settings.localKey = "b";
      sessions.reconfigure();
      await until(() => harness.sent("session/new").length === 1);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await sessions.deliver("chat", "b", 2, { build: build(2) });
      // No close is still coming that could unload it.
      expect(harness.sent("session/resume")).toHaveLength(1);
      expect(harness.sent("session/new")).toHaveLength(1);
      sessions.dispose();
    },
  );

  it("keeps no retired session in memory when its harness can't close", async () => {
    const harness = fakeHarness({
      capabilities: {
        mcpCapabilities: { http: true },
        sessionCapabilities: { resume: {} },
      },
    });
    const { sessions, settings } = pinnedSessions(harness);
    for (const [turn, key] of ["a", "b", "c"].entries()) {
      settings.localKey = key;
      sessions.reconfigure();
      await sessions.deliver("chat", key, turn + 1, { build: build(turn + 1) });
    }
    settings.localKey = "d";
    sessions.reconfigure();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const unclosed = (
      sessions as unknown as { unclosed: Map<unknown, unknown> }
    ).unclosed;
    // One failure for the process, not one session per close.
    expect([...unclosed.values()]).toHaveLength(1);
    expect([...unclosed.values()][0]).toBeInstanceOf(Error);
    await expect(sessions.shutdown()).rejects.toThrow("cannot acknowledge");
  });

  it("closes a busy retired session at once, releasing its hold once", async () => {
    const harness = fakeHarness({
      hold: true,
      holdClose: true,
      capabilities: {
        mcpCapabilities: { http: true },
        sessionCapabilities: closing,
      },
    });
    const { sessions, settings, holds } = pinnedSessions(harness);
    const a = sessions.deliver("chat", "a", 1);
    await until(() => harness.turns.length === 1);
    settings.localKey = "b";
    sessions.reconfigure();
    let done = false;
    const shutdown = sessions.shutdown().then(() => (done = true));
    await until(() => harness.closes.length === 1);
    expect(harness.sent("session/cancel")).toHaveLength(1);
    await flush();
    // Unacknowledged: shutdown still waits, and the hold is kept.
    expect(done).toBe(false);
    expect(holds).toEqual([{ generation: 1, released: 0 }]);
    harness.closes[0]?.();
    await shutdown;
    expect(harness.sent("session/close")).toHaveLength(1);
    await a;
    await flush();
    expect(holds).toEqual([{ generation: 1, released: 1 }]);
  });

  it.each([
    ["fails", ["session/resume"], {}],
    ["is incompatible", [], { overridden: { model: true, effort: false } }],
  ])(
    "rejects while a resumed session that %s cannot be closed",
    async (_, refused, record) => {
      const harness = fakeHarness({
        capabilities: {
          mcpCapabilities: { http: true },
          sessionCapabilities: closing,
        },
        refuse: [...refused, "session/close", "session/new"],
      });
      const saved = {
        chat: { at: 0, id: "old", covered: 0, context: SAVED, ...record },
      };
      const { sessions, holds } = pinnedSessions(harness, {
        saved,
        configOptions: true,
      });
      expect((await sessions.deliver("chat", "a", 1)).ok).toBe(false);
      expect(harness.sent("session/close")).toHaveLength(1);
      await expect(sessions.shutdown()).rejects.toThrow(
        "session/close refused",
      );
      expect(holds).toEqual([{ generation: 1, released: 1 }]);
    },
  );
});

describe("Stop after a pinned session is retired", () => {
  const cancelled = (harness: ReturnType<typeof fakeHarness>) =>
    harness.sent("session/cancel").map((m) => m.params?.sessionId);

  it("still cancels the retired turn of a thread-scoped conversation", async () => {
    const harness = fakeHarness({ hold: true });
    const { sessions, settings } = pinnedSessions(harness);
    const a = sessions.deliver("thread T1", "a", 1);
    await until(() => harness.turns.length === 1);
    settings.localKey = "b";
    sessions.reconfigure();
    await sessions.interrupt("thread T1");
    expect(cancelled(harness)).toEqual(["session-1"]);
    for (const turn of harness.turns) turn.finish();
    await a;
    sessions.dispose();
  });

  it("cancels both the retired turn and its replacement in a channel-scoped conversation", async () => {
    const harness = fakeHarness({ hold: true });
    const { sessions, settings } = pinnedSessions(harness);
    const a = sessions.deliver("channel", "a", 1);
    await until(() => harness.turns.length === 1);
    settings.localKey = "b";
    sessions.reconfigure();
    const b = sessions.deliver("channel", "b", 2);
    await until(() => harness.turns.length === 2);
    await sessions.interrupt("channel");
    expect(cancelled(harness).sort()).toEqual(["session-1", "session-2"]);
    for (const turn of harness.turns) turn.finish();
    await Promise.all([a, b]);
    sessions.dispose();
  });

  it("cancels a turn whose session was still opening when a synced change retired it", async () => {
    const harness = fakeHarness({ hold: true });
    const { sessions, settings, holds, gate } = pinnedSessions(harness);
    const late = gate();
    const a = sessions.deliver("chat", "a", 1);
    await until(() => holds.length === 1);
    settings.localKey = "b";
    settings.generation = 2;
    sessions.reconfigure();
    const stop = sessions.interrupt("chat");
    late();
    await until(() => harness.turns.length === 1);
    await stop;
    expect(cancelled(harness)).toEqual(["session-1"]);
    for (const turn of harness.turns) turn.finish();
    await a;
    sessions.dispose();
  });

  it("cancels a running replacement without waiting on a retired opening", async () => {
    const harness = fakeHarness({ hold: true });
    const { sessions, settings, holds, gate } = pinnedSessions(harness);
    const late = gate();
    const a = sessions.deliver("channel", "a", 1);
    await until(() => holds.length === 1);
    settings.localKey = "b";
    settings.generation = 2;
    sessions.reconfigure();
    const b = sessions.deliver("channel", "b", 2);
    await until(() => harness.turns.length === 1);
    const stop = sessions.interrupt("channel");
    await until(() => cancelled(harness).length === 1);
    expect(cancelled(harness)).toEqual(["session-1"]);
    late();
    await stop;
    // Then the retired session, which also closes: each process numbers from 1.
    expect(cancelled(harness).length).toBeGreaterThan(1);
    for (const turn of harness.turns) turn.finish();
    await Promise.all([a, b]);
    sessions.dispose();
  });

  it("leaves a message sent after Stop running when a retired opening finishes", async () => {
    const harness = fakeHarness({ hold: true, cancels: true });
    const { sessions, settings, holds, gate } = pinnedSessions(harness);
    const late = gate();
    const a = sessions.deliver("channel", "a", 1);
    await until(() => holds.length === 1);
    settings.localKey = "b";
    settings.generation = 2;
    sessions.reconfigure();
    const stop = sessions.interrupt("channel");
    const b = sessions.deliver("channel", "b", 2);
    await until(() => harness.turns.length === 1);
    late();
    await stop;
    await until(() => harness.turns.length === 2);
    // B came after Stop: only the retired session is cancelled, after its prompt.
    const [replacement, retired] = harness.turns;
    expect([replacement?.text, retired?.text]).toEqual(["b", "a"]);
    expect(replacement?.sessionId).not.toBe(retired?.sessionId);
    // Its close cancels it again.
    expect(new Set(cancelled(harness))).toEqual(new Set([retired?.sessionId]));
    replacement?.finish();
    expect(await b).toEqual(expect.objectContaining({ ok: true }));
    expect(await b).not.toHaveProperty("stopped");
    await a;
    sessions.dispose();
  });

  it("stops every message waiting on a session that is still opening", async () => {
    const harness = fakeHarness({ cancels: true });
    const { sessions, holds, gate } = pinnedSessions(harness);
    const opened = gate();
    const a = sessions.deliver("channel", "a", 1);
    await until(() => holds.length === 1);
    const b = sessions.deliver("channel", "b", 2);
    const c = sessions.deliver("channel", "c", 3);
    await flush();
    const stop = sessions.interrupt("channel");
    opened();
    await stop;
    expect(await b).toEqual({ ok: true, stopped: true });
    expect(await c).toEqual({ ok: true, stopped: true });
    // Only the opening's own message reached the session.
    expect(harness.turns.map((turn) => turn.text)).toEqual(["a"]);
    for (const turn of harness.turns) turn.finish();
    await a;
    sessions.dispose();
  });
});

describe("routing a pinned message", () => {
  it("keeps a thread's message on its own session after the scope moves to the channel", async () => {
    const harness = fakeHarness();
    const { sessions, settings } = pinnedSessions(harness);
    await sessions.deliver("thread T1", "a", 1);
    settings.localKey = "channel";
    await sessions.deliver("channel", "b", 2);
    // T1's session matches exactly; the channel's matches every thread.
    const match = ({ scope }: { scope: string }) =>
      scope === "a"
        ? { key: "thread T1", exact: true }
        : { key: "channel", exact: false };
    expect(sessions.route(match)?.key).toBe("thread T1");
    sessions.dispose();
  });

  it("never routes to a session Restart retired", async () => {
    const harness = fakeHarness({ hold: true });
    const { sessions } = pinnedSessions(harness);
    void sessions.deliver("chat", "a", 1);
    await flush();
    sessions.restart();
    expect(sessions.route(() => ({ key: "chat", exact: true }))).toBe(
      undefined,
    );
    harness.turns[0]?.finish();
    sessions.dispose();
  });
});

describe("a pinned session's options", () => {
  const configOptions = () => [
    {
      id: "m",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "fast",
      options: [
        { value: "fast", name: "Fast" },
        { value: "smart", name: "Smart" },
      ],
    },
    {
      id: "e",
      name: "Effort",
      category: "thought_level",
      type: "select",
      currentValue: "low",
      options: [
        { value: "low", name: "Low" },
        { value: "high", name: "High" },
      ],
    },
  ];

  it("sets the model, then the effort, before the prompt, and saves both as Buzz's", async () => {
    const harness = fakeHarness({ configOptions: configOptions() });
    const { sessions, records } = pinnedSessions(harness, {
      configOptions: true,
    });
    await sessions.deliver("chat", "a", 1, {
      model: "smart",
      effort: "high",
      build: build(1),
    });
    expect(
      harness.received
        .filter(
          (m) =>
            m.method?.startsWith("session/s") || m.method === "session/prompt",
        )
        .map((m) => `${m.method} ${m.params?.configId ?? ""}`.trim()),
    ).toEqual([
      "session/set_config_option m",
      "session/set_config_option e",
      "session/prompt",
    ]);
    expect(records.get("chat")?.overridden).toEqual({
      model: true,
      effort: true,
    });
    sessions.dispose();
  });
});

describe("a pinned session's queued default", () => {
  const options = () => [
    {
      id: "m",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "fast",
      options: [
        { value: "fast", name: "Fast" },
        { value: "smart", name: "Smart" },
      ],
    },
    {
      id: "e",
      name: "Effort",
      category: "thought_level",
      type: "select",
      currentValue: "low",
      options: [
        { value: "low", name: "Low" },
        { value: "high", name: "High" },
      ],
    },
  ];

  for (const pick of [{ model: "smart" }, { effort: "high" }])
    it(`opens new after a running turn on ${JSON.stringify(pick)}`, async () => {
      const harness = fakeHarness({ hold: true, configOptions: options() });
      const { sessions } = pinnedSessions(harness, { configOptions: true });
      const a = sessions.deliver("chat", "a", 1, { ...pick, build: build(1) });
      await until(() => harness.turns.length === 1);
      const b = sessions.deliver("chat", "b", 2, {
        build: async (from) => ({
          text: `from ${from.at}`,
          through: { at: 2, ids: ["e2"] },
        }),
      });
      await flush();
      harness.turns[0]?.finish();
      await until(() => harness.turns.length === 2);
      harness.turns[1]?.finish();
      await Promise.all([a, b]);
      // The default turn ran on a new session, rebuilt from its start.
      expect(harness.sent("session/new")).toHaveLength(2);
      expect(harness.turns[1]).toEqual(
        expect.objectContaining({ sessionId: "session-2", text: "from -1" }),
      );
      expect(harness.sent("session/set_config_option")).toHaveLength(1);
      sessions.dispose();
    });

  it("queues default turns behind a default turn on the same session", async () => {
    const harness = fakeHarness({ hold: true, configOptions: options() });
    const { sessions } = pinnedSessions(harness, { configOptions: true });
    const a = sessions.deliver("chat", "a", 1, { build: build(1) });
    await until(() => harness.turns.length === 1);
    const queued = [2, 3].map((at) =>
      sessions.deliver("chat", `m${at}`, at, { build: build(at) }),
    );
    await flush();
    // Queued without waiting for the running turn to end.
    expect(harness.sent("session/prompt")).toHaveLength(1);
    let done = false;
    const all = Promise.all([a, ...queued]).then(() => (done = true));
    for (let finished = 0; !done; await flush())
      while (finished < harness.turns.length)
        harness.turns[finished++]?.finish();
    await all;
    expect(harness.sent("session/new")).toHaveLength(1);
    expect(harness.sent("session/set_config_option")).toHaveLength(0);
    sessions.dispose();
  });

  it("runs before an explicit turn that arrives while it waits", async () => {
    const harness = fakeHarness({ hold: true, configOptions: options() });
    const { sessions } = pinnedSessions(harness, { configOptions: true });
    const a = sessions.deliver("chat", "a", 1, {
      model: "smart",
      build: build(1),
    });
    await until(() => harness.turns.length === 1);
    const b = sessions.deliver("chat", "b", 2, { build: build(2) });
    const c = sessions.deliver("chat", "c", 3, {
      model: "smart",
      build: build(3),
    });
    await flush();
    harness.turns[0]?.finish();
    await until(() => harness.turns.length === 2);
    harness.turns[1]?.finish();
    await until(() => harness.turns.length === 3);
    harness.turns[2]?.finish();
    await Promise.all([a, b, c]);
    expect(harness.turns.map((turn) => turn.text)).toEqual([
      "through 1",
      "through 2",
      "through 3",
    ]);
    expect(harness.turns[1]?.sessionId).toBe("session-2");
    sessions.dispose();
  });

  it("reaches a message whose idle session's launch is still being read", async () => {
    const harness = fakeHarness({ configOptions: options() });
    const { sessions, gate } = pinnedSessions(harness, { configOptions: true });
    await sessions.deliver("chat", "a", 1, { build: build(1) });
    const read = gate();
    const b = sessions.deliver("chat", "b", 2, { build: build(2) });
    await flush();
    await sessions.interrupt("chat");
    read();
    await expect(b).resolves.toEqual({ ok: true, stopped: true });
    expect(harness.turns).toHaveLength(1);
    expect(await sessions.deliver("chat", "c", 3, { build: build(3) })).toEqual(
      expect.objectContaining({ ok: true }),
    );
    expect(harness.turns.map((turn) => turn.text)).toEqual([
      "through 1",
      "through 3",
    ]);
    sessions.dispose();
  });

  it("reaches a message stopped after a read that changed its prompt, before admission", async () => {
    const harness = fakeHarness({ configOptions: options() });
    let prompt = "one";
    let stopAfterRead: (() => void) | undefined;
    const { sessions, gate } = pinnedSessions(harness, {
      configOptions: true,
      prompt: () => {
        const stop = stopAfterRead;
        // Stop lands after the read has fulfilled, before B resumes and is
        // admitted: one tick sooner and the reservation's own race catches it.
        if (stop)
          void Promise.resolve()
            .then(() => undefined)
            .then(stop);
        return prompt;
      },
    });
    await sessions.deliver("chat", "a", 1, { build: build(1) });
    const read = gate();
    prompt = "two";
    stopAfterRead = () => void sessions.interrupt("chat");
    const b = sessions.deliver("chat", "b", 2, { build: build(2) });
    read();
    await expect(b).resolves.toEqual({ ok: true, stopped: true });
    stopAfterRead = undefined;
    // B never reached the harness, and no replacement opened for it.
    expect(harness.turns).toHaveLength(1);
    expect(harness.sent("session/new")).toHaveLength(1);
    expect(await sessions.deliver("chat", "c", 3, { build: build(3) })).toEqual(
      expect.objectContaining({ ok: true }),
    );
    expect(harness.turns.map((turn) => turn.text)).toEqual([
      "one\n\nthrough 1",
      "two\n\nthrough 3",
    ]);
    sessions.dispose();
  });

  it("opens new for a default turn behind an explicit one admitted during the read", async () => {
    const harness = fakeHarness({ hold: true, configOptions: options() });
    const { sessions, gate } = pinnedSessions(harness, { configOptions: true });
    const a = sessions.deliver("chat", "a", 1, { build: build(1) });
    await until(() => harness.turns.length === 1);
    harness.turns[0]?.finish();
    await a;
    const read = gate();
    const b = sessions.deliver("chat", "b", 2, {
      model: "smart",
      build: build(2),
    });
    const c = sessions.deliver("chat", "c", 3, { build: build(3) });
    await flush();
    read();
    await until(() => harness.turns.length === 2);
    harness.turns[1]?.finish();
    await until(() => harness.turns.length === 3);
    harness.turns[2]?.finish();
    await Promise.all([b, c]);
    expect(
      harness.turns.map((turn) => `${turn.sessionId} ${turn.text}`),
    ).toEqual([
      "session-1 through 1",
      "session-1 through 2",
      expect.stringMatching(/^session-2 /),
    ]);
    sessions.dispose();
  });

  it("is cleared by Stop while it waits", async () => {
    const harness = fakeHarness({ hold: true, configOptions: options() });
    const { sessions } = pinnedSessions(harness, { configOptions: true });
    const a = sessions.deliver("chat", "a", 1, {
      model: "smart",
      build: build(1),
    });
    await until(() => harness.turns.length === 1);
    const b = sessions.deliver("chat", "b", 2, { build: build(2) });
    await flush();
    await sessions.interrupt("chat");
    harness.turns[0]?.finish();
    await expect(b).resolves.toEqual({ ok: true, stopped: true });
    await a;
    await flush();
    expect(harness.sent("session/new")).toHaveLength(1);
    expect(harness.turns).toHaveLength(1);
    sessions.dispose();
  });

  it("keeps its place when a later waiter is cancelled", async () => {
    const harness = fakeHarness({ hold: true, configOptions: options() });
    const { sessions } = pinnedSessions(harness, { configOptions: true });
    const smart = (at: number, signal?: AbortSignal) =>
      sessions.deliver("chat", `m${at}`, at, {
        model: "smart",
        build: build(at),
        ...(signal ? { signal } : {}),
      });
    const a = smart(1);
    await until(() => harness.turns.length === 1);
    const b = sessions.deliver("chat", "m2", 2, { build: build(2) });
    const cancel = new AbortController();
    const c = smart(3, cancel.signal);
    const d = smart(4);
    await flush();
    cancel.abort();
    await c;
    await flush();
    let done = false;
    const all = Promise.all([a, b, d]).then(() => (done = true));
    for (let finished = 0; !done; await flush())
      while (finished < harness.turns.length)
        harness.turns[finished++]?.finish();
    await all;
    expect(harness.turns.map((turn) => turn.text)).toEqual([
      "through 1",
      "through 2",
      "through 4",
    ]);
    expect(harness.turns[1]?.sessionId).toBe("session-2");
    sessions.dispose();
  });

  it("is still cleared by Stop after the last waiter is cancelled", async () => {
    const harness = fakeHarness({ hold: true, configOptions: options() });
    const { sessions } = pinnedSessions(harness, { configOptions: true });
    const a = sessions.deliver("chat", "a", 1, {
      model: "smart",
      build: build(1),
    });
    await until(() => harness.turns.length === 1);
    const b = sessions.deliver("chat", "b", 2, { build: build(2) });
    const cancel = new AbortController();
    const c = sessions.deliver("chat", "c", 3, {
      model: "smart",
      build: build(3),
      signal: cancel.signal,
    });
    await flush();
    cancel.abort();
    await c;
    await sessions.interrupt("chat");
    harness.turns[0]?.finish();
    await expect(b).resolves.toEqual({ ok: true, stopped: true });
    await a;
    await flush();
    expect(harness.sent("session/new")).toHaveLength(1);
    expect(harness.turns).toHaveLength(1);
    sessions.dispose();
  });
});

describe("a reopened session's options", () => {
  it.each([
    ["load", { loadSession: true }],
    ["resume", { sessionCapabilities: { resume: {} } }],
  ])(
    "are kept when the %s answers without options, so a pick is set",
    async (method, reopens) => {
      const model = {
        id: "m",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "fast",
        options: [
          { value: "fast", name: "Fast" },
          { value: "smart", name: "Smart" },
        ],
      };
      const harness = fakeHarness({
        capabilities: { mcpCapabilities: { http: true }, ...reopens },
        replay: [
          { sessionUpdate: "config_option_update", configOptions: [model] },
        ],
        reopened: {},
      });
      const { sessions } = pinnedSessions(harness, {
        configOptions: true,
        saved: { chat: { at: 0, id: "old", covered: 0, context: SAVED } },
      });
      await sessions.deliver("chat", "a", 1, {
        model: "smart",
        build: build(1),
      });
      expect(harness.sent(`session/${method}`)).toHaveLength(1);
      expect(
        harness.sent("session/set_config_option").map((m) => m.params?.value),
      ).toEqual(["smart"]);
      sessions.dispose();
    },
  );
});

describe("reconnecting after sign-in", () => {
  it("fails live sessions, keeps their records, and restarts the process", async () => {
    const harness = fakeHarness();
    const restart = vi.fn(async () => ({ ok: true }) as const);
    const { sessions, writes } = pinnedSessions(harness, { restart });
    await sessions.deliver("chat", "a", 1, { build: build(1) });
    expect(await sessions.reconnect()).toEqual({ ok: true });
    expect(restart).toHaveBeenCalledOnce();
    // Called on the process, which a restart reads its own state from.
    expect(restart.mock.contexts[0]).toBeDefined();
    expect(writes).toEqual(["advance chat session-1 1"]);
    sessions.dispose();
  });
});

describe("reading a transcript", () => {
  it("replays a saved session into turns, giving threadOf only the prompt's start", async () => {
    const long = `thread:t1 ${"x".repeat(10_000)}`;
    const harness = fakeHarness({
      capabilities: { mcpCapabilities: { http: true }, loadSession: true },
      replay: [
        {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: long },
        },
        {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hi" },
        },
      ],
    });
    const prefixes: number[] = [];
    const transcript = await readTranscript({
      start: () => start(harness),
      cwd: "/work",
      sessionId: "old",
      threadOf: (prefix) => {
        prefixes.push(prefix.length);
        return prefix.startsWith("thread:t1") ? "t1" : undefined;
      },
    });
    expect(prefixes).toEqual([4096]);
    expect(transcript?.turns).toHaveLength(1);
    expect(transcript?.turns[0]?.threadRootId).toBe("t1");
    expect(harness.sent("session/prompt")).toEqual([]);
    expect(harness.started[0]?.killed).toBe(true);
  });

  it("reads a replayed request as Buzz framed it, past a long context and across chunks", async () => {
    const id = "e".repeat(64);
    const pubkey = "a".repeat(64);
    const prompt = [
      "<thread-context>",
      `{"content":${JSON.stringify("x".repeat(8_000))}}`,
      "</thread-context>",
      "<buzz-event>",
      JSON.stringify({ id, pubkey, content: "Ship it" }),
      `Request: ${JSON.stringify("Ship it")}`,
      "</buzz-event>",
    ].join("\n");
    const cut = prompt.indexOf("</buzz-event>") + 4;
    const harness = fakeHarness({
      capabilities: { mcpCapabilities: { http: true }, loadSession: true },
      replay: [prompt.slice(0, cut), prompt.slice(cut)].map((text) => ({
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text },
      })),
    });
    const transcript = await readTranscript({
      start: () => start(harness),
      cwd: "/work",
      sessionId: "old",
      threadOf: () => undefined,
    });
    const [turn] = transcript?.turns ?? [];
    expect(turn?.triggeringEventIds).toEqual([id]);
    expect(turn?.items[0]).toMatchObject({
      type: "prompt",
      text: "Ship it",
      authorPubkey: pubkey,
    });
  });

  const read = (replay: Record<string, unknown>[]) => {
    const harness = fakeHarness({
      capabilities: { mcpCapabilities: { http: true }, loadSession: true },
      replay,
    });
    return readTranscript({
      start: () => start(harness),
      cwd: "/work",
      sessionId: "old",
      threadOf: () => undefined,
      limits: { turns: 2, items: 2, bytes: 1024 },
    });
  };
  const said = (text: string, messageId: string) => ({
    sessionUpdate: "agent_message_chunk",
    messageId,
    content: { type: "text", text },
  });

  it("marks a session's start only when its replay keeps its first prompt", async () => {
    const asked = (text: string) => ({
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text },
    });
    const whole = await read([asked("one"), said("ok", "m1")]);
    expect(whole?.turns.map((turn) => turn.newSession)).toEqual([true]);
    // Its oldest turn cut away: the start isn't shown.
    const cut = await read([
      asked("one"),
      said("ok", "m1"),
      asked("two"),
      said("ok", "m2"),
      asked("three"),
    ]);
    expect(cut?.turns.length).toBeGreaterThan(0);
    expect(cut?.turns.some((turn) => turn.newSession)).toBe(false);
    // No prompt first: it starts partway through.
    const late = await read([said("ok", "m1"), asked("two")]);
    expect(late?.turns.length).toBeGreaterThan(0);
    expect(late?.turns.some((turn) => turn.newSession)).toBe(false);
  });

  it("keeps a single turn within its item limit", async () => {
    const replay = [...Array(8).keys()].map((i) => said("hi", `m${i}`));
    const transcript = await read(replay);
    expect(transcript?.turns.flatMap((turn) => turn.items)).toHaveLength(2);
  });

  it("counts a message id and multibyte text in UTF-8 bytes", async () => {
    const long = await read([said("hi", "x".repeat(20_000))]);
    expect(long?.turns.flatMap((turn) => turn.items)).toEqual([]);
    const wide = await read([said("é".repeat(1_000), "m")]);
    const [item] = wide?.turns.flatMap((turn) => turn.items) ?? [];
    const text = item?.type === "message" ? item.text : "";
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(1024);
    expect(text).toContain("…[elided 1000 chars]");
  });

  const size = (transcript: unknown) =>
    new TextEncoder().encode(JSON.stringify(transcript)).length;
  const tool = (fields: Record<string, unknown>) => ({
    sessionUpdate: "tool_call",
    toolCallId: "t",
    ...fields,
  });

  it("counts a tool's metadata and every diff entry", async () => {
    const kind = await read([tool({ kind: "k".repeat(20_000) })]);
    expect(size(kind)).toBeLessThan(4096);
    const diff = { type: "diff", path: "", newText: "" };
    const diffs = await read([
      tool({ content: Array.from({ length: 20_000 }, () => diff) }),
    ]);
    expect(size(diffs)).toBeLessThan(4096);
  });

  it("replaces a tool's diffs when an update resends its content", async () => {
    const diff = { type: "diff", path: "a.ts", newText: "two", oldText: "one" };
    const transcript = await read([
      tool({ content: [diff] }),
      { ...tool({ content: [diff] }), sessionUpdate: "tool_call_update" },
      { ...tool({ status: "completed" }), sessionUpdate: "tool_call_update" },
    ]);
    const [item] = transcript?.turns.flatMap((turn) => turn.items) ?? [];
    expect(item?.type === "tool" && item.diffs).toEqual([
      { path: "a.ts", newText: "two", oldText: "one" },
    ]);
  });

  it("marks a turn partial when it drops the turn's own content", async () => {
    const at = { _meta: { timestamp: 1_000 } };
    const transcript = await read([
      {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "go" },
        ...at,
      },
      ...[...Array(8).keys()].map((i) => ({ ...said("hi", `m${i}`), ...at })),
    ]);
    expect(transcript?.turns.at(-1)?.partial).toBe(true);
  });

  it("counts a user message id in UTF-8 bytes", async () => {
    const transcript = await read([
      {
        sessionUpdate: "user_message_chunk",
        messageId: "x".repeat(20_000),
        content: { type: "text", text: "go" },
        _meta: { timestamp: 1_000 },
      },
    ]);
    const [turn] = transcript?.turns ?? [];
    expect(turn?.items).toEqual([]);
    expect(turn?.partial).toBe(true);
  });
});

describe("resuming a saved session", () => {
  const LOADS = {
    mcpCapabilities: { http: true },
    loadSession: true,
    sessionCapabilities: { close: {} },
  };

  it("loads it with fresh tools, never seeing its replay, naming or new-session meta", async () => {
    const names = vi.fn(async () => true);
    const newSessionMeta = vi.fn(() => ({}));
    const systemPrompt = vi.fn(async () => undefined);
    const hooks: AcpHooks = { ...HOOKS, names, newSessionMeta, systemPrompt };
    const harness = fakeHarness({ capabilities: LOADS });
    const acp = await start(harness, {}, hooks);
    const first = await acp.open({
      cwd: "/work",
      systemPrompt: "Be Buzz.",
      tools,
    });
    await acp.close(first);
    names.mockClear();
    newSessionMeta.mockClear();
    systemPrompt.mockClear();
    const updates = vi.spyOn(AcpSession.prototype, "update");
    const seen: unknown[] = [];
    const named = vi.fn();
    try {
      const session = await acp.open({
        cwd: "/work",
        systemPrompt: "Be Buzz.",
        title: "A new title",
        named,
        tools,
        load: first.id,
        onSession: (opened) => {
          opened.observe = (update) => seen.push(update);
        },
      });
      await flush();
      expect(session.id).toBe(first.id);
      expect(updates).not.toHaveBeenCalled();
      expect(seen).toEqual([]);
      expect(harness.sent("session/new")).toHaveLength(1);
      // The first session's server was token-1; its token is never reused.
      expect(harness.sent("session/load")[0]?.params).toEqual({
        sessionId: first.id,
        cwd: "/work",
        mcpServers: [
          {
            type: "http",
            name: TOOL_SERVER,
            url: "http://127.0.0.1:40002/mcp",
            headers: [{ name: "Authorization", value: "Bearer token-2" }],
          },
        ],
      });
      expect(names).not.toHaveBeenCalled();
      expect(newSessionMeta).not.toHaveBeenCalled();
      expect(named).not.toHaveBeenCalled();
      // Set under its key again, which replaces it rather than adding one.
      expect(systemPrompt).toHaveBeenCalledExactlyOnceWith(
        acp,
        first.id,
        "Be Buzz.",
        undefined,
      );
    } finally {
      updates.mockRestore();
    }
  });

  it("leads no prompt with the instructions its conversation already holds", async () => {
    const harness = fakeHarness({ capabilities: LOADS });
    const acp = await start(harness);
    const session = await acp.open({
      cwd: "/work",
      systemPrompt: "Be Buzz.",
      load: "saved-1",
    });
    await session.send("next");
    expect(harness.turns.map((turn) => turn.text)).toEqual(["next"]);
  });

  it("refuses, never opening a new session, without loadSession or when the load fails", async () => {
    const without = fakeHarness();
    const plain = await start(without);
    await expect(
      plain.open({ cwd: "/work", systemPrompt: "", load: "saved-1" }),
    ).rejects.toThrow("This Harness cannot resume a session");
    expect(without.sent("session/load")).toEqual([]);
    expect(without.sent("session/new")).toEqual([]);

    const failing = fakeHarness({
      capabilities: LOADS,
      loadError: { code: -32002, message: "Session not found: saved-1" },
    });
    const acp = await start(failing);
    await expect(
      acp.open({ cwd: "/work", systemPrompt: "", tools, load: "saved-1" }),
    ).rejects.toThrow("Session not found: saved-1");
    expect(failing.sent("session/new")).toEqual([]);
    // Nothing holds the id: a later load may try again.
    failing.sent("session/load").length = 0;
    await expect(
      acp.open({ cwd: "/work", systemPrompt: "", load: "saved-1" }),
    ).rejects.toThrow("Session not found: saved-1");
  });

  it("refuses a system prompt it would have to send with session/new", async () => {
    const harness = fakeHarness({
      capabilities: {
        ...LOADS,
        sessionCapabilities: { close: {}, systemPrompt: {} },
      },
    });
    const acp = await start(harness);
    await expect(
      acp.open({ cwd: "/work", systemPrompt: "Be Buzz.", load: "saved-1" }),
    ).rejects.toThrow(
      "This Harness cannot resume a session with its system prompt",
    );
    expect(harness.sent("session/load")).toEqual([]);
  });

  it("resumes a session whose load answers null, keeping its tools", async () => {
    const harness = fakeHarness({ capabilities: LOADS, loadResult: null });
    const acp = await start(harness);
    const session = await acp.open({
      cwd: "/work",
      systemPrompt: "",
      tools,
      load: "saved-1",
    });
    expect(session.id).toBe("saved-1");
    expect(session.open).toBe(true);
    // Its tools' server stays up with it.
    let stopped = false;
    void session.server?.closed.then(() => (stopped = true));
    await flush();
    expect(stopped).toBe(false);
  });

  it("lets one open own a saved session at a time", async () => {
    const harness = fakeHarness({ capabilities: LOADS });
    const acp = await start(harness);
    const loading = acp.open({
      cwd: "/work",
      systemPrompt: "",
      load: "saved-1",
    });
    await expect(
      acp.open({ cwd: "/work", systemPrompt: "", load: "saved-1" }),
    ).rejects.toThrow("This Harness session is already open");
    const session = await loading;
    await expect(
      acp.open({ cwd: "/work", systemPrompt: "", load: "saved-1" }),
    ).rejects.toThrow("This Harness session is already open");
    expect(harness.sent("session/load")).toHaveLength(1);
    await acp.close(session);
    await expect(
      acp.open({ cwd: "/work", systemPrompt: "", load: "saved-1" }),
    ).resolves.toMatchObject({ id: "saved-1" });
  });

  it("waits for the harness to acknowledge a close before loading it again", async () => {
    const harness = fakeHarness({
      capabilities: { ...LOADS, sessionCapabilities: {} },
    });
    const acp = await start(harness);
    const session = await acp.open({
      cwd: "/work",
      systemPrompt: "",
      load: "saved-1",
    });
    await acp.close(session);
    await expect(
      acp.open({ cwd: "/work", systemPrompt: "", load: "saved-1" }),
    ).rejects.toThrow("This Harness session has not finished closing");
    expect(harness.sent("session/load")).toHaveLength(1);
  });
});

describe("holding a conversation", () => {
  const CLOSES = {
    mcpCapabilities: { http: true },
    sessionCapabilities: { close: {} },
  };
  function held(
    harness: ReturnType<typeof fakeHarness>,
    acp: AcpProcess,
    launch = async () => ({ workspace: "/work", systemPrompt: "" }),
  ) {
    const saved = new Map<string, SavedConversation>();
    const sessions = new AgentSessions({
      label: "Harness",
      resolveDirectory: async (path) => path,
      tools,
      process: { get: async () => acp },
      launch,
      choice: () => ({ provider: "", model: "" }),
      fingerprint: () => "",
      store: {
        get: (key) => saved.get(key),
        set: (key, value) => saved.set(key, value),
      },
    });
    return { sessions, saved, harness };
  }
  const deferred = <T = void>() => {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    return { promise, resolve, reject };
  };

  it("starts its work only once the old session's close is acknowledged, and messages wait for it", async () => {
    const harness = fakeHarness({ capabilities: CLOSES, holdClose: true });
    const { sessions } = held(harness, await start(harness));
    await sessions.deliver("chat", "hello", 1);
    const order: string[] = [];
    const holding = sessions.exclusive("chat", async ({ saved }) => {
      order.push(`work ${saved}`);
      return "done";
    });
    await flush();
    const later = sessions
      .deliver("chat", "later", 2)
      .then(() => order.push("later"));
    await flush();
    expect(harness.sent("session/close")).toHaveLength(1);
    expect(order).toEqual([]);
    expect(sessions.active("chat")).toBe(true);
    harness.closes.shift()?.();
    await expect(holding).resolves.toBe("done");
    await later;
    expect(order).toEqual(["work session-1", "later"]);
    expect(harness.turns.map((turn) => turn.text)).toEqual(["hello", "later"]);
    expect(harness.sent("session/delete")).toEqual([]);
  });

  it("refuses work while an older process whose close failed still runs, after a newer one exits", async () => {
    const harnesses = [0, 1].map(() =>
      fakeHarness({
        capabilities: CLOSES,
        closeError: { code: -32000, message: "close failed" },
      }),
    );
    const [p1, p2] = await Promise.all(harnesses.map((h) => start(h)));
    let process = p1;
    let fingerprint = "1";
    const sessions = new AgentSessions({
      label: "Harness",
      resolveDirectory: async (path) => path,
      tools,
      process: { get: async () => process as AcpProcess },
      launch: async () => ({ workspace: "/work", systemPrompt: "" }),
      choice: () => ({ provider: "", model: "" }),
      fingerprint: () => fingerprint,
    });
    for (const [i, next] of [p1, p2].entries()) {
      process = next;
      await sessions.deliver("chat", `turn ${i}`, i + 1);
      fingerprint = String(i + 2);
      sessions.reconfigure();
      await until(() => harnesses[i]?.sent("session/close").length === 1);
      await flush();
    }
    await p2?.kill();
    await p2?.exited;
    await flush();
    const work = vi.fn(async () => undefined);
    await expect(sessions.exclusive("chat", work)).rejects.toThrow(
      "close failed",
    );
    expect(work).not.toHaveBeenCalled();
    sessions.dispose();
    await p1?.kill();
  });

  it("never starts its work after a close the harness failed, deleting nothing", async () => {
    const harness = fakeHarness({
      capabilities: CLOSES,
      closeError: { code: -32000, message: "close failed" },
    });
    const { sessions, saved } = held(harness, await start(harness));
    await sessions.deliver("chat", "hello", 1);
    const before = saved.get("chat");
    const work = vi.fn(async () => undefined);
    await expect(sessions.exclusive("chat", work)).rejects.toThrow(
      "close failed",
    );
    // The failed close stays failed: the next hold is refused too.
    await expect(sessions.exclusive("chat", work)).rejects.toThrow(
      "close failed",
    );
    expect(work).not.toHaveBeenCalled();
    expect(sessions.active("chat")).toBe(false);
    expect(saved.get("chat")).toEqual(before);
    expect(harness.sent("session/delete")).toEqual([]);
  });

  it("leaves other conversations alone", async () => {
    const harness = fakeHarness({ capabilities: CLOSES });
    const { sessions } = held(harness, await start(harness));
    await sessions.deliver("other", "hello", 1);
    const working = deferred();
    const holding = sessions.exclusive("chat", () => working.promise);
    await flush();
    await expect(sessions.deliver("other", "again", 2)).resolves.toMatchObject({
      ok: true,
    });
    expect(harness.sent("session/close")).toEqual([]);
    working.resolve();
    await holding;
  });

  it("lets one caller in at a time once an opening session settles", async () => {
    const harness = fakeHarness({ capabilities: CLOSES });
    const launching = deferred();
    const { sessions } = held(harness, await start(harness), async () => {
      await launching.promise;
      return { workspace: "/work", systemPrompt: "" };
    });
    const opening = sessions.deliver("chat", "hello", 1);
    await flush();
    const first = deferred();
    const entered: string[] = [];
    const a = sessions.exclusive("chat", () => {
      entered.push("a");
      return first.promise;
    });
    const b = sessions.exclusive("chat", async () => {
      entered.push("b");
    });
    launching.resolve();
    await opening;
    await flush();
    expect(entered).toEqual(["a"]);
    first.resolve();
    await Promise.all([a, b]);
    expect(entered).toEqual(["a", "b"]);
  });

  it("tells its work of an interrupt at once, without waiting for it", async () => {
    const harness = fakeHarness({ capabilities: CLOSES });
    const { sessions } = held(harness, await start(harness));
    const working = deferred();
    let signal: AbortSignal | undefined;
    const holding = sessions.exclusive("chat", (held) => {
      signal = held.signal;
      return working.promise;
    });
    await flush();
    await sessions.interrupt("chat");
    expect(signal?.aborted).toBe(true);
    expect(sessions.active("chat")).toBe(true);
    working.resolve();
    await holding;
    expect(sessions.active("chat")).toBe(false);
  });

  it("never starts work interrupted while it waits for a close", async () => {
    const harness = fakeHarness({ capabilities: CLOSES, holdClose: true });
    const { sessions } = held(harness, await start(harness));
    await sessions.deliver("chat", "hello", 1);
    const work = vi.fn(async () => undefined);
    const holding = sessions.exclusive("chat", work);
    await flush();
    await sessions.interrupt("chat");
    harness.closes.shift()?.();
    await expect(holding).rejects.toThrow("Harness was stopped");
    expect(work).not.toHaveBeenCalled();
    expect(sessions.active("chat")).toBe(false);
  });

  it("is aborted by dispose, and shutdown waits for its work", async () => {
    const harness = fakeHarness({ capabilities: CLOSES });
    const { sessions } = held(harness, await start(harness));
    const working = deferred();
    let signal: AbortSignal | undefined;
    const holding = sessions.exclusive("chat", (held) => {
      signal = held.signal;
      return working.promise;
    });
    await flush();
    let shut = false;
    const shutting = sessions.shutdown().then(() => (shut = true));
    await flush();
    expect(signal?.aborted).toBe(true);
    expect(shut).toBe(false);
    working.resolve();
    await Promise.all([holding, shutting]);
    await expect(
      sessions.exclusive("chat", async () => undefined),
    ).rejects.toThrow("Harness was stopped");
  });

  it("queues the conversation's holds and messages, not others, until a session its work left running exits", async () => {
    const harness = fakeHarness({ capabilities: CLOSES });
    const { sessions } = held(harness, await start(harness));
    const exited = deferred<number | null>();
    await sessions.exclusive("chat", async ({ outlives }) => {
      outlives(exited.promise);
    });
    const work = vi.fn(async () => undefined);
    const holding = sessions.exclusive("chat", work);
    const waiting = sessions.deliver("chat", "after", 1);
    // A whole turn elsewhere: time enough for an unblocked one to run.
    await expect(
      sessions.deliver("other", "meanwhile", 1),
    ).resolves.toMatchObject({ ok: true });
    expect(sessions.active("chat")).toBe(true);
    expect(work).not.toHaveBeenCalled();
    expect(harness.turns.map((turn) => turn.text)).toEqual(["meanwhile"]);
    exited.resolve(0);
    await holding;
    expect(work).toHaveBeenCalledOnce();
    await expect(waiting).resolves.toMatchObject({ ok: true });
    expect(harness.turns.map((turn) => turn.text)).toEqual([
      "meanwhile",
      "after",
    ]);
  });

  it("keeps both paths refused when a left-running session's exit cannot be observed", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const harness = fakeHarness({ capabilities: CLOSES });
      const { sessions } = held(harness, await start(harness));
      const exited = deferred<number | null>();
      await sessions.exclusive("chat", async ({ outlives }) => {
        outlives(exited.promise);
      });
      const waiting = sessions.deliver("chat", "after", 1);
      exited.reject(new Error("exit unobservable"));
      await expect(waiting).resolves.toMatchObject({
        ok: false,
        error: "Harness could not confirm this conversation's session ended",
        undelivered: true,
      });
      const work = vi.fn(async () => undefined);
      await expect(sessions.exclusive("chat", work)).rejects.toThrow(
        "Harness could not confirm this conversation's session ended",
      );
      expect(work).not.toHaveBeenCalled();
      expect(harness.turns).toEqual([]);
    } finally {
      warned.mockRestore();
    }
  });

  it("waits for every session its work left running, whichever exits last", async () => {
    const harness = fakeHarness({ capabilities: CLOSES });
    const { sessions } = held(harness, await start(harness));
    const first = deferred<number | null>();
    const second = deferred<number | null>();
    await sessions.exclusive("chat", async ({ outlives }) => {
      outlives(first.promise);
      outlives(second.promise);
    });
    const waiting = sessions.deliver("chat", "after", 1);
    second.resolve(0);
    // A whole turn elsewhere: time enough for an unblocked one to run.
    await expect(
      sessions.deliver("other", "meanwhile", 1),
    ).resolves.toMatchObject({ ok: true });
    expect(sessions.active("chat")).toBe(true);
    expect(harness.turns.map((turn) => turn.text)).toEqual(["meanwhile"]);
    first.resolve(0);
    await expect(waiting).resolves.toMatchObject({ ok: true });
    expect(harness.turns.map((turn) => turn.text)).toEqual([
      "meanwhile",
      "after",
    ]);
  });

  it("keeps the conversation refused when an earlier left-running session's exit cannot be observed", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const harness = fakeHarness({ capabilities: CLOSES });
      const { sessions } = held(harness, await start(harness));
      const first = deferred<number | null>();
      const second = deferred<number | null>();
      await sessions.exclusive("chat", async ({ outlives }) => {
        outlives(first.promise);
        outlives(second.promise);
      });
      first.reject(new Error("exit unobservable"));
      second.resolve(0);
      await expect(sessions.deliver("chat", "after", 1)).resolves.toMatchObject(
        {
          ok: false,
          error: "Harness could not confirm this conversation's session ended",
          undelivered: true,
        },
      );
      expect(warned).toHaveBeenCalledOnce();
      expect(harness.turns).toEqual([]);
    } finally {
      warned.mockRestore();
    }
  });

  it("refuses a left-running session named after its work settled", async () => {
    const harness = fakeHarness({ capabilities: CLOSES });
    const { sessions } = held(harness, await start(harness));
    let late: ((done: Promise<unknown>) => void) | undefined;
    await sessions.exclusive("chat", async ({ outlives }) => {
      late = outlives;
    });
    expect(() => late?.(new Promise(() => {}))).toThrow(
      "Harness has released this conversation",
    );
    await expect(sessions.deliver("chat", "after", 1)).resolves.toMatchObject({
      ok: true,
    });
  });

  it("lets a message waiting on a left-running session give up, or stop", async () => {
    const harness = fakeHarness({ capabilities: CLOSES });
    const { sessions } = held(harness, await start(harness));
    await sessions.exclusive("chat", async ({ outlives }) => {
      outlives(new Promise(() => {}));
    });
    const giving = new AbortController();
    const given = sessions.deliver("chat", "abandoned", 1, {
      signal: giving.signal,
    });
    const stopped = sessions.deliver("chat", "stopped", 1);
    await flush();
    giving.abort();
    await expect(given).resolves.toMatchObject({
      ok: false,
      undelivered: true,
    });
    sessions.dispose();
    await expect(stopped).resolves.toMatchObject({
      ok: false,
      error: "Harness was stopped",
      undelivered: true,
    });
    expect(harness.turns).toEqual([]);
  });

  it("counts as the conversation's session for the next message", async () => {
    const harness = fakeHarness({ capabilities: CLOSES });
    const { sessions } = held(harness, await start(harness));
    await sessions.exclusive("chat", async () => undefined);
    const named = vi.fn();
    await sessions.deliver("chat", "stale", 1, {
      fresh: async () => "rebuilt",
      named,
    });
    expect(harness.turns.map((turn) => turn.text)).toEqual(["rebuilt"]);
  });

  it("keeps a session only while it holds the conversation, and releases it on failure", async () => {
    const harness = fakeHarness({ capabilities: CLOSES });
    const { sessions, saved } = held(harness, await start(harness));
    let late: ((id: string, binding: unknown) => boolean) | undefined;
    await sessions.exclusive("chat", async ({ keep }) => {
      expect(keep("saved-1", "b1")).toBe(true);
      late = keep;
    });
    expect(saved.get("chat")).toMatchObject({
      sessions: ["saved-1"],
      binding: { session: "saved-1", value: "b1" },
    });
    expect(late?.("saved-2", "b2")).toBe(false);
    expect(saved.get("chat")?.sessions).toEqual(["saved-1"]);
    await expect(
      sessions.exclusive("chat", async ({ saved: newest }) => {
        throw new Error(`could not load ${newest}`);
      }),
    ).rejects.toThrow("could not load saved-1");
    expect(sessions.active("chat")).toBe(false);
  });

  it("ends a hold queued behind a left-running session on interrupt, never running it", async () => {
    const harness = fakeHarness({ capabilities: CLOSES });
    const { sessions } = held(harness, await start(harness));
    const exited = deferred<number | null>();
    await sessions.exclusive("chat", async ({ outlives }) => {
      outlives(exited.promise);
    });
    const work = vi.fn(async () => undefined);
    const queued = sessions.exclusive("chat", work);
    await flush();
    await sessions.interrupt("chat");
    await expect(queued).rejects.toThrow("Harness was stopped");
    exited.resolve(0);
    await flush();
    expect(work).not.toHaveBeenCalled();
    expect(sessions.active("chat")).toBe(false);
  });

  it("ends a queued hold on its caller's signal, or on dispose", async () => {
    const harness = fakeHarness({ capabilities: CLOSES });
    const { sessions } = held(harness, await start(harness));
    await sessions.exclusive("chat", async ({ outlives }) => {
      outlives(new Promise(() => {}));
    });
    const work = vi.fn(async () => undefined);
    const giving = new AbortController();
    const given = sessions.exclusive("chat", work, giving.signal);
    const stopped = sessions.exclusive("chat", work);
    await flush();
    giving.abort();
    await expect(given).rejects.toThrow("Harness was stopped");
    sessions.dispose();
    await expect(stopped).rejects.toThrow("Harness was stopped");
    expect(work).not.toHaveBeenCalled();
  });

  it("refuses a hold queued behind a left-running session whose exit then cannot be observed", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const harness = fakeHarness({ capabilities: CLOSES });
      const { sessions } = held(harness, await start(harness));
      const exited = deferred<number | null>();
      await sessions.exclusive("chat", async ({ outlives }) => {
        outlives(exited.promise);
      });
      const work = vi.fn(async () => undefined);
      const queued = sessions.exclusive("chat", work);
      await flush();
      exited.reject(new Error("exit unobservable"));
      await expect(queued).rejects.toThrow(
        "Harness could not confirm this conversation's session ended",
      );
      expect(work).not.toHaveBeenCalled();
    } finally {
      warned.mockRestore();
    }
  });
});

describe("saved sessions under holds", () => {
  const CLOSES = {
    mcpCapabilities: { http: true },
    sessionCapabilities: { close: {} },
  };
  const deferred = <T = void>() => {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    return { promise, resolve, reject };
  };
  const sessionsWith = (
    saved = new Map<string, SavedConversation>(),
    hold = false,
  ) => {
    const harness = fakeHarness({ capabilities: CLOSES, hold });
    const acp = start(harness);
    const sessions = new AgentSessions({
      label: "Harness",
      resolveDirectory: async (path) => path,
      tools,
      process: { get: () => acp },
      launch: async () => ({ workspace: "/work", systemPrompt: "" }),
      choice: () => ({ provider: "", model: "" }),
      fingerprint: () => "",
      store: {
        get: (key) => saved.get(key),
        set: (key, value) => saved.set(key, value),
      },
    });
    return { sessions, saved, harness };
  };
  /** What held work is given for `key`, taking nothing. */
  const read = (sessions: AgentSessions, key = "chat") =>
    sessions.exclusive(key, async (held) => ({
      saved: held.saved,
      reset: held.reset,
      binding: held.binding,
    }));

  it("reads what held work saved only with the session it saved it with", () => {
    const at = 1;
    expect(association(undefined)).toBeUndefined();
    expect(association({ at, sessions: ["s1"] })).toBeUndefined();
    expect(
      association({
        at,
        sessions: ["s1"],
        binding: { session: "s1", value: { v: 1 } },
      }),
    ).toEqual({ value: { v: 1 } });
    // A value that can't be read is still that session's: never none.
    expect(
      association({
        at,
        sessions: ["s1"],
        binding: { session: "s1", value: null },
      }),
    ).toEqual({ value: null });
    expect(
      association({
        at,
        sessions: ["s2", "s1"],
        binding: { session: "s1", value: 1 },
      }),
    ).toBeUndefined();
    for (const binding of [
      null,
      "s1",
      ["s1", 1],
      {},
      { session: "s1" },
      { value: 1 },
      { session: "s1", value: 1, extra: 1 },
      { session: 1, value: 1 },
      { session: "", value: 1 },
      { session: "s".repeat(257), value: 1 },
    ])
      expect(association({ at, sessions: ["s1"], binding })).toBe("malformed");
  });

  it("reads what is stored raw, however damaged, and the reset marker only as written", () => {
    const binding = { session: 7, junk: [1] };
    const read = savedConversation({
      at: 1,
      sessions: ["s1"],
      binding,
      next: "new",
    });
    expect(read).toEqual({ at: 1, sessions: ["s1"], binding, next: "new" });
    expect(read?.binding).toBe(binding);
    expect(savedConversation({ at: 1, binding: null })).toEqual({
      at: 1,
      binding: null,
    });
    expect(savedConversation({ at: 1, next: "other" })).toEqual({ at: 1 });
  });

  it("gives a forwarded session's value back, but a fresh one after an ordinary session replaced it", async () => {
    const { sessions, saved } = sessionsWith();
    await sessions.exclusive("chat", async ({ keep }) => {
      expect(keep("g1", { b: "B" })).toBe(true);
    });
    expect(await read(sessions)).toEqual({
      saved: "g1",
      reset: false,
      binding: { value: { b: "B" } },
    });
    await expect(
      sessions.deliver("chat", "ordinary", 1),
    ).resolves.toMatchObject({ ok: true });
    const ordinary = saved.get("chat")?.sessions?.[0];
    expect(ordinary).not.toBe("g1");
    expect(saved.get("chat")?.binding).toEqual({
      session: "g1",
      value: { b: "B" },
    });
    expect(await read(sessions)).toEqual({
      saved: ordinary,
      reset: false,
      binding: undefined,
    });
  });

  it("gives the same value back after a reload, whatever its turn did", async () => {
    const saved = new Map<string, SavedConversation>();
    const first = sessionsWith(saved).sessions;
    await expect(
      first.exclusive("chat", async ({ keep }) => {
        expect(keep("g1", { b: "B" })).toBe(true);
        throw new Error("the prompt failed");
      }),
    ).rejects.toThrow("the prompt failed");
    first.dispose();
    const reloaded = sessionsWith(
      new Map(JSON.parse(JSON.stringify([...saved]))),
    ).sessions;
    expect(await read(reloaded)).toEqual({
      saved: "g1",
      reset: false,
      binding: { value: { b: "B" } },
    });
  });

  it("does not count a session as saved unless the store reads it back", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { sessions, saved } = sessionsWith();
      const set = vi.spyOn(saved, "set");
      set.mockImplementationOnce(() => saved);
      set.mockImplementationOnce(() => {
        throw new Error("quota");
      });
      await sessions.exclusive("chat", async ({ keep }) => {
        expect(keep("g1", "B")).toBe(false);
        expect(keep("g1", "B")).toBe(false);
        expect(keep("g1", "B")).toBe(true);
      });
    } finally {
      warned.mockRestore();
    }
  });

  it("starts New session over, reading nothing stored, and keeps every session listed until one replaces it", async () => {
    const saved = new Map<string, SavedConversation>([
      ["chat", { at: 1, sessions: ["g1", "g0"], binding: { session: 7 } }],
    ]);
    const { sessions } = sessionsWith(saved);
    expect((await read(sessions)).binding).toBe("malformed");
    await expect(sessions.reset("chat", "new")).resolves.toEqual({ ok: true });
    expect(saved.get("chat")).toEqual({
      at: 1,
      sessions: ["g1", "g0"],
      binding: { session: 7 },
      next: "new",
    });
    expect(await read(sessions)).toEqual({
      saved: undefined,
      reset: true,
      binding: undefined,
    });
    // A replacement that fails to start keeps it all.
    await expect(
      sessions.exclusive("chat", async () => {
        throw new Error("could not start");
      }),
    ).rejects.toThrow("could not start");
    expect(saved.get("chat")?.next).toBe("new");
    await sessions.exclusive("chat", async ({ keep }) => {
      expect(keep("g2", "C")).toBe(true);
    });
    expect(saved.get("chat")).toMatchObject({
      sessions: ["g2", "g1", "g0"],
      binding: { session: "g2", value: "C" },
    });
    expect(saved.get("chat")).not.toHaveProperty("next");
  });

  it("keeps the open session when New session cannot be saved", async () => {
    // A store that keeps the old record once frozen.
    let frozen = false;
    const saved = new (class extends Map<string, SavedConversation> {
      override set(key: string, value: SavedConversation) {
        if (!frozen) super.set(key, value);
        return this;
      }
    })();
    const { sessions, harness } = sessionsWith(saved);
    await expect(sessions.deliver("chat", "first", 1)).resolves.toMatchObject({
      ok: true,
    });
    frozen = true;
    await expect(sessions.reset("chat", "new")).resolves.toEqual({
      ok: false,
      error: "Harness could not save New session",
    });
    // Nothing was closed: the next message runs in the same session.
    expect(harness.sent("session/close")).toEqual([]);
    await expect(sessions.deliver("chat", "again", 2)).resolves.toMatchObject({
      ok: true,
    });
    expect(harness.sent("session/new")).toHaveLength(1);
    expect(harness.turns.map((turn) => turn.text)).toEqual(["first", "again"]);
  });

  it("lets an ordinary session that replaces the newest end New session, and nothing else", async () => {
    const saved = new Map<string, SavedConversation>([
      [
        "chat",
        { at: 1, sessions: ["g1"], binding: { session: "g1", value: "B" } },
      ],
    ]);
    const { sessions } = sessionsWith(saved);
    await sessions.reset("chat", "new");
    await expect(
      sessions.deliver("chat", "ordinary", 1),
    ).resolves.toMatchObject({ ok: true });
    const record = saved.get("chat");
    expect(record?.sessions?.[1]).toBe("g1");
    expect(record).not.toHaveProperty("next");
    expect(record?.binding).toEqual({ session: "g1", value: "B" });
  });

  it("refuses New session, writing nothing, once a left-running session could not be confirmed ended", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const saved = new Map<string, SavedConversation>();
      const { sessions } = sessionsWith(saved);
      const exited = deferred<number | null>();
      await sessions.exclusive("chat", async ({ keep, outlives }) => {
        keep("g1", "B");
        outlives(exited.promise);
      });
      exited.reject(new Error("exit unobservable"));
      await flush();
      const before = saved.get("chat");
      await expect(sessions.reset("chat", "new")).resolves.toEqual({
        ok: false,
        error: "Harness could not confirm this conversation's session ended",
      });
      expect(saved.get("chat")).toBe(before);
    } finally {
      warned.mockRestore();
    }
  });

  it("waits for a held turn before New session marks the conversation", async () => {
    const saved = new Map<string, SavedConversation>();
    const { sessions } = sessionsWith(saved);
    const working = deferred();
    const turn = sessions.exclusive("chat", async ({ keep }) => {
      await working.promise;
      keep("g1", "B");
    });
    await flush();
    const resetting = sessions.reset("chat", "new");
    await flush();
    expect(saved.get("chat")).toBeUndefined();
    working.resolve();
    await turn;
    await expect(resetting).resolves.toEqual({ ok: true });
    expect(saved.get("chat")?.next).toBe("new");
  });

  it("does nothing more once New session or compaction is interrupted while it waits for the turn", async () => {
    for (const action of ["new", "compact"] as const) {
      const saved = new Map<string, SavedConversation>();
      const { sessions, harness } = sessionsWith(saved, true);
      const forwarded = vi.fn(
        async (_held: Exclusive) => ({ ok: true }) as const,
      );
      const delivered = sessions.deliver("chat", "one", 1);
      while (!harness.turns.length) await flush();
      // This harness confirms delivery when it finishes the prompt.
      expect(saved.has("chat")).toBe(false);
      const resetting = sessions.reset("chat", action, forwarded);
      await flush();
      await sessions.interrupt("chat");
      harness.turns[0]?.finish();
      await delivered;
      await expect(resetting).resolves.toEqual({
        ok: false,
        error: "Harness was stopped",
      });
      expect(saved.get("chat")).toEqual({
        at: expect.any(Number),
        sessions: [harness.turns[0]?.sessionId],
      });
      expect(forwarded).not.toHaveBeenCalled();
      expect(harness.turns.map((turn) => turn.text)).toEqual(["one"]);
      // The session it waited on is still the conversation's.
      const again = sessions.deliver("chat", "two", 2);
      while (harness.turns.length < 2) await flush();
      harness.turns[1]?.finish();
      await again;
      expect(harness.turns.map((turn) => turn.sessionId)).toEqual([
        harness.turns[0]?.sessionId,
        harness.turns[0]?.sessionId,
      ]);
      expect(harness.sent("session/new")).toHaveLength(1);
    }
  });

  it("refuses to keep no value at all, writing nothing", async () => {
    const saved = new Map<string, SavedConversation>();
    const { sessions } = sessionsWith(saved);
    await sessions.exclusive("chat", async ({ keep }) => {
      expect(keep("g1", undefined)).toBe(false);
    });
    expect(saved.get("chat")).toBeUndefined();
  });

  it("chooses compaction under the hold: the open session, a forwarded one, or nothing", async () => {
    const saved = new Map<string, SavedConversation>();
    const { sessions } = sessionsWith(saved);
    const forwarded = vi.fn(
      async (_held: Exclusive) => ({ ok: true }) as const,
    );
    // Nothing saved: nothing to do.
    await expect(sessions.reset("chat", "compact", forwarded)).resolves.toEqual(
      {
        ok: true,
      },
    );
    expect(forwarded).not.toHaveBeenCalled();
    await sessions.exclusive("chat", async ({ keep }) => {
      keep("g1", "B");
    });
    await expect(sessions.reset("chat", "compact", forwarded)).resolves.toEqual(
      {
        ok: true,
      },
    );
    expect(forwarded).toHaveBeenCalledOnce();
    expect(forwarded.mock.calls[0]?.[0]).toMatchObject({
      saved: "g1",
      binding: { value: "B" },
    });
    // Damage goes to the forwarded path, which refuses it, never to nothing.
    saved.set("chat", { at: 1, sessions: ["g1"], binding: { session: 7 } });
    await sessions.reset("chat", "compact", forwarded);
    expect(forwarded.mock.calls[1]?.[0]).toMatchObject({
      binding: "malformed",
    });
    // After New session there is nothing to compact.
    await sessions.reset("chat", "new");
    await sessions.reset("chat", "compact", forwarded);
    expect(forwarded).toHaveBeenCalledTimes(2);
  });
});
