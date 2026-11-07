import { expect, it } from "vitest";
import { AcpProcess } from "../../features/agent-harness/acp/process";
import type {
  ServeMcp,
  ToolServer,
} from "../../features/agent-harness/acp/types";
import type { McpHandler } from "../../features/host/service";
import type { HostProcessOptions } from "../../features/host/service";
import { bundledPlugins } from "..";
import { OpenCodeModels, picks } from "./models";
import { ENV, OPENCODE, OpenCodeProcess } from "./opencode";
import { config, DEFAULT_CONFIG } from "./runtime";

const CONFIG_OPTIONS = [
  {
    id: "model",
    category: "model",
    currentValue: "anthropic/sonnet",
    options: [
      { value: "anthropic/sonnet", name: "Sonnet" },
      { value: "openai/gpt", name: "GPT" },
    ],
  },
  {
    id: "effort",
    category: "thought_level",
    currentValue: "medium",
    options: [
      { value: "low", name: "Low" },
      { value: "medium", name: "Medium" },
    ],
  },
  { id: "mode", category: "mode", currentValue: "build", options: [] },
];

/** A stand-in for `opencode acp` over stdio. */
const fake = (failure?: string) => {
  const spawned: { id: string; options: HostProcessOptions }[] = [];
  const received: { method: string; params: Record<string, unknown> }[] = [];
  let killed = 0;
  let sessions = 0;
  const spawn = async (id: string, options: HostProcessOptions = {}) => {
    if (failure) throw new Error(failure);
    spawned.push({ id, options });
    return {
      write: async (data: string) => {
        const { id: rpc, method, params } = JSON.parse(data);
        received.push({ method, params });
        const result =
          method === "initialize"
            ? { agentCapabilities: { mcpCapabilities: { http: true } } }
            : method === "session/new"
              ? { sessionId: `s${++sessions}`, configOptions: CONFIG_OPTIONS }
              : { configOptions: CONFIG_OPTIONS };
        queueMicrotask(() =>
          options.onStdout?.(
            `${JSON.stringify({ jsonrpc: "2.0", id: rpc, result })}\n`,
          ),
        );
      },
      end: async () => undefined,
      kill: async () => {
        killed++;
      },
      exited: new Promise<number | null>(() => undefined),
    };
  };
  return { spawn, spawned, received, killed: () => killed };
};

it("registers disabled by default, running opencode acp from PATH with Buzz tools", () => {
  const plugin = bundledPlugins.find(
    ({ manifest }) => manifest.id === "buzz.opencode",
  );
  expect(plugin?.enabledByDefault).toBe(false);
  expect(plugin?.manifest.name).toBe("OpenCode");
  expect(plugin?.manifest.host).toMatchObject({
    processes: [{ id: "opencode", program: "opencode", args: ["acp"] }],
    mcp: true,
    files: true,
  });
  expect(plugin?.manifest.host?.processes?.[0]).not.toHaveProperty("bundled");
});

it("reports a missing opencode binary", async () => {
  const { spawn } = fake("No such file or directory (os error 2)");
  await expect(OpenCodeProcess.start(spawn, { cwd: "/w" })).rejects.toThrow(
    OPENCODE.missing,
  );
  const other = fake("permission denied");
  await expect(
    OpenCodeProcess.start(other.spawn, { cwd: "/w" }),
  ).rejects.toThrow("permission denied");
});

it("starts without the Buzz identity", async () => {
  const opencode = fake();
  await OpenCodeProcess.start(opencode.spawn, { cwd: "/w" });
  expect(opencode.spawned[0]?.id).toBe("opencode");
  expect(opencode.spawned[0]?.options.env).toMatchObject(ENV);
  for (const name of ["BUZZ_PRIVATE_KEY", "BUZZ_AUTH_TAG", "BUZZ_RELAY_URL"])
    expect(ENV[name]).toBeNull();
});

it("puts a session on the picked model and level, and skips what is already set", async () => {
  const opencode = fake();
  const process = await OpenCodeProcess.start(opencode.spawn, { cwd: "/w" });
  const offered: unknown[] = [];
  const session = {
    id: "s1",
    chosen: { provider: "", model: "", effort: "" },
    offer: (options: unknown) => offered.push(options),
  };
  const configured = () =>
    opencode.received
      .filter(({ method }) => method === "session/set_config_option")
      .map(({ params }) => `${params.configId}=${params.value}`);

  await OPENCODE.select?.(process, session, {
    provider: "",
    model: "",
    effort: "",
  });
  expect(configured()).toEqual([]);

  await OPENCODE.select?.(process, session, {
    provider: "",
    model: "openai/gpt",
    effort: "low",
  });
  expect(configured()).toEqual(["model=openai/gpt", "effort=low"]);
  expect(offered).toHaveLength(2);
  expect(session.chosen).toMatchObject({ model: "openai/gpt", effort: "low" });

  await OPENCODE.select?.(process, session, {
    provider: "",
    model: "openai/gpt",
    effort: "low",
  });
  expect(configured()).toHaveLength(2);

  await OPENCODE.select?.(process, session, {
    provider: "",
    model: "anthropic/sonnet",
    effort: "xhigh",
  });
  expect(configured()).toEqual([
    "model=openai/gpt",
    "effort=low",
    "model=anthropic/sonnet",
  ]);
  expect(session.chosen).toMatchObject({
    model: "anthropic/sonnet",
    effort: "low",
  });
});

it("lists the models and levels opencode offers, and kills the probe", async () => {
  expect(picks([])).toEqual({ current: "", models: [] });
  const opencode = fake();
  const models = await new OpenCodeModels({
    spawn: opencode.spawn,
    resolveDirectory: async (path) => path,
  }).read();
  expect(models.current).toBe("anthropic/sonnet");
  expect(models.models.map(({ id }) => id)).toEqual([
    "anthropic/sonnet",
    "openai/gpt",
  ]);
  expect(models.models[0]).toMatchObject({
    effort: "medium",
    efforts: [
      { id: "low", label: "Low" },
      { id: "medium", label: "Medium" },
    ],
  });
  expect(models.models[1]?.efforts).toEqual([]);
  expect(opencode.killed()).toBe(1);
});

it("does not cache a failed model read", async () => {
  let fail = true;
  const ok = fake();
  const reader = new OpenCodeModels({
    spawn: (id, options) =>
      fail ? Promise.reject(new Error("os error 2")) : ok.spawn(id, options),
    resolveDirectory: async (path) => path,
  });
  await expect(reader.read()).rejects.toThrow(OPENCODE.missing);
  fail = false;
  expect((await reader.read()).models).toHaveLength(2);
});

it("fills a saved config with defaults", () => {
  expect(config(undefined)).toEqual(DEFAULT_CONFIG);
  expect(config({ model: "m" })).toEqual({ ...DEFAULT_CONFIG, model: "m" });
});

it("routes the shared Buzz tool server's calls by the session id opencode sends", async () => {
  const handlers: McpHandler[] = [];
  const serve: ServeMcp = async (handler) => {
    handlers.push(handler);
    return {
      url: "http://127.0.0.1:1/mcp",
      headers: [{ name: "Authorization", value: "Bearer t" }],
      close: async () => undefined,
      closed: new Promise<void>(() => undefined),
    };
  };
  const toolsFor =
    (name: string): ToolServer =>
    async (conversation, message) => ({
      jsonrpc: "2.0",
      id: message.id,
      result: { name, conversation },
    });
  const call = (sessionID?: string) =>
    handlers[0]?.({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "send",
        ...(sessionID ? { _meta: { "ai.opencode/sessionID": sessionID } } : {}),
      },
    });

  const opencode = fake();
  const process = await OpenCodeProcess.start(opencode.spawn, {
    cwd: "/w",
    serve,
  });
  const a = await process.open({
    cwd: "/w",
    systemPrompt: "",
    tools: toolsFor("a"),
  });
  const b = await process.open({
    cwd: "/w",
    systemPrompt: "",
    tools: toolsFor("b"),
  });
  a.conversation = "chan/a";
  b.conversation = "chan/b";
  expect(handlers).toHaveLength(1);
  const servers = opencode.received
    .filter(({ method }) => method === "session/new")
    .map(({ params }) => params.mcpServers);
  expect(servers[0]).toEqual(servers[1]);
  expect(await call(a.id)).toMatchObject({
    result: { name: "a", conversation: "chan/a" },
  });
  expect(await call(b.id)).toMatchObject({
    result: { name: "b", conversation: "chan/b" },
  });
  expect(await call()).toMatchObject({ error: { code: -32602 } });
  expect(await call("nope")).toMatchObject({
    error: { code: -32602 },
  });
  await process.close(a);
  expect(await call(a.id)).toMatchObject({
    error: { code: -32602 },
  });

  const goose = await AcpProcess.start(
    opencode.spawn,
    { ...OPENCODE, sharedMcp: false },
    { cwd: "/w", serve },
  );
  await goose.open({ cwd: "/w", systemPrompt: "", tools: toolsFor("x") });
  await goose.open({ cwd: "/w", systemPrompt: "", tools: toolsFor("y") });
  expect(handlers).toHaveLength(3);
});
