import { AppInvocation } from "../../buzz-mcp/app-client";
import type { AgentHandle } from "../agents/service";
import type { RelayData } from "../relay/service";
import type { RelaySession } from "../relay/session";
import { Context } from "@deepseek-ai/cordis";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PluginRuntime } from "../../plugins/runtime";
import type { PluginInfo } from "../../plugins/types";
import {
  HostService,
  type Host,
  type ReviewedInvocationDestination,
  type ReviewedInvocationReceipt,
} from "./service";
import { runtimePerformance } from "../developer/runtime-performance";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: vi.fn(),
  invoke: vi.fn(),
  Channel: class {
    constructor(public onmessage: (event: unknown) => void) {}
  },
}));

beforeEach(() => {
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(invoke).mockReset();
  vi.stubGlobal("navigator", { platform: "MacIntel" });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function pluginContext() {
  const root = new Context();
  new HostService(root);
  return {
    root,
    plugin: root.extend({
      pluginOwner: { id: "example.plugin", revision: "abc" },
    }),
  };
}

it("prepares a structured NIP-OA proof with the native identity without a community", async () => {
  const identity = "ab".repeat(32);
  const agentPubkey = "cd".repeat(32);
  const authorization = ["auth", identity, "", "ef".repeat(64)];
  const { plugin } = pluginContext();
  vi.mocked(invoke)
    .mockResolvedValueOnce(identity)
    .mockResolvedValueOnce(authorization);
  expect(
    await plugin.host.prepareRemoteAgentAuthorization?.(agentPubkey),
  ).toEqual(authorization);
  expect(invoke).toHaveBeenNthCalledWith(1, "identity_restore");
  expect(invoke).toHaveBeenNthCalledWith(
    2,
    "identity_prepare_remote_agent_authorization",
    { owner: identity, agentPubkey },
  );
});

it.each([
  { mode: "browser", tauri: false, live: undefined },
  { mode: "live desktop", tauri: true, live: "1" },
])(
  "uses the dev broker identity for $mode authorization without a selected relay",
  async ({ tauri, live }) => {
    const identity = "ab".repeat(32);
    const agentPubkey = "cd".repeat(32);
    const authorization = ["auth", identity, "", "ef".repeat(64)];
    vi.mocked(isTauri).mockReturnValue(tauri);
    vi.stubEnv("VITE_BUZZ_LIVE", live);
    const fetcher = vi.fn(async (_url: string, _input?: RequestInit) =>
      Response.json({ viewer: identity }),
    );
    fetcher
      .mockResolvedValueOnce(Response.json({ viewer: identity }))
      .mockResolvedValueOnce(Response.json(authorization));
    vi.stubGlobal("fetch", fetcher);
    const { plugin } = pluginContext();
    expect(
      await plugin.host.prepareRemoteAgentAuthorization?.(agentPubkey),
    ).toEqual(authorization);
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/relay/identity");
    expect(fetcher.mock.calls[1]?.[0]).toBe(
      "/api/relay/prepare-remote-agent-authorization",
    );
    const input = fetcher.mock.calls[1]?.[1] as RequestInit;
    expect(JSON.parse(String(input.body))).toEqual({
      owner: identity,
      agentPubkey,
    });
    expect(invoke).not.toHaveBeenCalled();
  },
);

it("does not sign invalid, self, missing-identity or pre-canceled requests", async () => {
  const identity = "ab".repeat(32);
  const agentPubkey = "cd".repeat(32);
  const { plugin } = pluginContext();
  await expect(
    plugin.host.prepareRemoteAgentAuthorization?.("invalid"),
  ).rejects.toThrow("64 lowercase hex");
  expect(invoke).not.toHaveBeenCalled();
  vi.mocked(invoke).mockResolvedValueOnce(identity);
  await expect(
    plugin.host.prepareRemoteAgentAuthorization?.(identity),
  ).rejects.toThrow("must differ");
  vi.mocked(invoke).mockResolvedValueOnce(null);
  await expect(
    plugin.host.prepareRemoteAgentAuthorization?.(agentPubkey),
  ).rejects.toThrow("Set up your identity");
  const cancel = new AbortController();
  cancel.abort();
  await expect(
    plugin.host.prepareRemoteAgentAuthorization?.(agentPubkey, cancel.signal),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(invoke).toHaveBeenCalledTimes(2);
});

it.each(["identity_restore", "identity_prepare_remote_agent_authorization"])(
  "fences cancellation during %s",
  async (command) => {
    const identity = "ab".repeat(32);
    const agentPubkey = "cd".repeat(32);
    const authorization = ["auth", identity, "", "ef".repeat(64)];
    let release!: (value: unknown) => void;
    vi.mocked(invoke).mockImplementation((name) =>
      name === command
        ? new Promise((resolve) => {
            release = resolve;
          })
        : Promise.resolve(identity),
    );
    const { plugin } = pluginContext();
    const cancel = new AbortController();
    const pending = plugin.host.prepareRemoteAgentAuthorization?.(
      agentPubkey,
      cancel.signal,
    );
    try {
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      cancel.abort();
    } finally {
      release?.(command === "identity_restore" ? identity : authorization);
    }
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(invoke).toHaveBeenCalledTimes(
      command === "identity_restore" ? 1 : 2,
    );
  },
);

it.each(["different owner", "nonempty conditions", "malformed signature"])(
  "rejects an invalid authorization: %s",
  async (scenario) => {
    const identity = "ab".repeat(32);
    const agentPubkey = "cd".repeat(32);
    const authorization = [
      "auth",
      scenario === "different owner" ? agentPubkey : identity,
      scenario === "nonempty conditions" ? "kind=0" : "",
      scenario === "malformed signature" ? "invalid" : "ef".repeat(64),
    ];
    const { plugin } = pluginContext();
    vi.mocked(invoke)
      .mockResolvedValueOnce(identity)
      .mockResolvedValueOnce(authorization);
    await expect(
      plugin.host.prepareRemoteAgentAuthorization?.(agentPubkey),
    ).rejects.toThrow("Invalid remote agent authorization");
  },
);

it("uses the calling plugin identity and preserves bounded command output", async () => {
  const { plugin } = pluginContext();
  vi.mocked(invoke).mockResolvedValue("ready \n");
  await expect(plugin.host.runCommand("status")).resolves.toBe("ready \n");
  expect(invoke).toHaveBeenCalledWith("plugin_host_run_command", {
    id: "example.plugin",
    revision: "abc",
    commandId: "status",
  });
});

it("keeps native command failures and browser calls nullable", async () => {
  const { root, plugin } = pluginContext();
  vi.mocked(invoke).mockRejectedValue(new Error("secret stderr"));
  await expect(plugin.host.runCommand("status")).resolves.toBeNull();
  await expect(root.host.runCommand("status")).resolves.toBeNull();
  vi.mocked(isTauri).mockReturnValue(false);
  await expect(plugin.host.runCommand("status")).resolves.toBeNull();
  expect(invoke).toHaveBeenCalledTimes(1);
});

it("passes review decisions as stdin data while keeping the command fixed", async () => {
  const { plugin } = pluginContext();
  vi.mocked(invoke).mockResolvedValue('{"accepted":true}');
  const input =
    '{"id":"action-a","choice":"allow_once","text":"$(touch injected)"}';
  await plugin.host.runCommand("review", input);
  expect(invoke).toHaveBeenCalledWith("plugin_host_run_command", {
    id: "example.plugin",
    revision: "abc",
    commandId: "review",
    input,
  });
});

it("routes HTTPS requests with plugin identity and rejects browser requests", async () => {
  const { plugin } = pluginContext();
  const response = {
    status: 200,
    headers: { "content-type": "application/json" },
    body: "{}",
  };
  vi.mocked(invoke).mockResolvedValue(response);
  const request = {
    url: "https://api.example.com/graphql",
    method: "POST" as const,
    headers: { Authorization: "Bearer token" },
    body: "{}",
    secret: "api-key",
  };
  await expect(plugin.host.request(request)).resolves.toEqual(response);
  expect(invoke).toHaveBeenCalledWith("plugin_host_request", {
    id: "example.plugin",
    revision: "abc",
    request,
  });
  vi.mocked(isTauri).mockReturnValue(false);
  await expect(plugin.host.request(request)).rejects.toThrow(/desktop plugin/);
});

it.each(["request", "upload"] as const)(
  "normalizes native %s string failures and preserves existing Errors",
  async (operation) => {
    const { plugin } = pluginContext();
    const input = { url: "https://api.example.com/", secret: "api-key" };
    const call = () =>
      operation === "request"
        ? plugin.host.request(input)
        : plugin.host.upload?.({
            ...input,
            file: {
              field: "artifact",
              path: "/home/me/artifact.tar.gz",
              name: "artifact.tar.gz",
              contentType: "application/gzip",
            },
          });
    const message =
      operation === "request"
        ? "Host request timed out"
        : "Files are not declared";
    vi.mocked(invoke).mockRejectedValueOnce(message);
    await expect(call()).rejects.toEqual(new Error(message));
    const error = new Error("Native failure");
    vi.mocked(invoke).mockRejectedValueOnce(error);
    await expect(call()).rejects.toBe(error);
    expect(invoke).toHaveBeenCalledTimes(2);
  },
);

it("reads files and resolves directories as the calling plugin", async () => {
  const { plugin } = pluginContext();
  vi.mocked(invoke)
    .mockResolvedValueOnce(new Uint8Array([0, 255]).buffer)
    .mockResolvedValueOnce("/home/me/.buzz")
    .mockRejectedValueOnce("notes.md: No such file");
  await expect(
    plugin.host.readFile?.("./a.png", { cwd: "~/.buzz" }),
  ).resolves.toEqual(new Uint8Array([0, 255]));
  expect(invoke).toHaveBeenCalledWith("plugin_host_read_file", {
    id: "example.plugin",
    revision: "abc",
    path: "./a.png",
    cwd: "~/.buzz",
  });
  await expect(plugin.host.resolveDirectory?.("~/.buzz")).resolves.toBe(
    "/home/me/.buzz",
  );
  expect(invoke).toHaveBeenLastCalledWith("plugin_host_resolve_directory", {
    id: "example.plugin",
    revision: "abc",
    path: "~/.buzz",
  });
  // Callers tell a missing file by its message, so it arrives as an Error.
  await expect(plugin.host.readFile?.("/notes.md")).rejects.toThrow(
    /No such file/,
  );
  vi.mocked(invoke).mockResolvedValueOnce("/home/me/work");
  await expect(
    plugin.host.resolveDirectory?.("~/work", { create: false }),
  ).resolves.toBe("/home/me/work");
  expect(invoke).toHaveBeenLastCalledWith("plugin_host_resolve_directory", {
    id: "example.plugin",
    revision: "abc",
    path: "~/work",
    create: false,
  });
  vi.mocked(isTauri).mockReturnValue(false);
  await expect(plugin.host.readFile?.("/notes.md")).rejects.toThrow(
    /desktop plugin/,
  );
});

it("lists the binding's configured repositories folder as the calling plugin, never a path it names", async () => {
  const viewer = "a".repeat(64);
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
  });
  const { root, plugin } = pluginContext();
  const binding = {
    scope: `https://one.example:${viewer}`,
    viewer,
    incarnation: "1",
  };
  const rows = [
    { name: "app", path: "/home/me/code/app", displayPath: "~/code/app" },
  ];
  const { signal } = new AbortController();
  vi.mocked(invoke).mockResolvedValue(rows);
  await expect(plugin.host.repositoryFolders?.(binding, signal)).resolves.toBe(
    rows,
  );
  expect(invoke).toHaveBeenLastCalledWith("plugin_host_repository_folders", {
    id: "example.plugin",
    revision: "abc",
    path: "~/.buzz/REPOS",
  });
  stored.set(
    `buzz-community-repositories.v1:${JSON.stringify(["https://one.example", viewer])}`,
    "~/code",
  );
  await plugin.host.repositoryFolders?.(binding, signal);
  expect(invoke).toHaveBeenLastCalledWith("plugin_host_repository_folders", {
    id: "example.plugin",
    revision: "abc",
    path: "~/code",
  });
  vi.mocked(invoke).mockClear();
  await expect(
    plugin.host.repositoryFolders?.({ ...binding, scope: "none" }, signal),
  ).rejects.toThrow(/community and account/);
  await expect(root.host.repositoryFolders?.(binding, signal)).rejects.toThrow(
    /desktop plugin/,
  );
  vi.mocked(isTauri).mockReturnValue(false);
  await expect(
    plugin.host.repositoryFolders?.(binding, signal),
  ).rejects.toThrow(/desktop plugin/);
  expect(invoke).not.toHaveBeenCalled();
});

it("starts a declared process as the calling plugin and streams it", async () => {
  const { plugin } = pluginContext();
  vi.mocked(invoke).mockResolvedValueOnce(7);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const process = await plugin.host.spawn?.("agent", {
    args: ["--print"],
    cwd: "~/.buzz",
    env: { CLAUDECODE: null },
    mcp: {
      url: "http://127.0.0.1:1234/mcp",
      headers: [{ name: "Authorization", value: "Bearer agent" }],
    },
    onStdout: (data) => stdout.push(data),
    onStderr: (data) => stderr.push(data),
  });
  const [, spawn] = vi.mocked(invoke).mock.calls[0] as [
    string,
    { onEvent: { onmessage(event: unknown): void } },
  ];
  expect(invoke).toHaveBeenCalledWith("plugin_host_process_spawn", {
    id: "example.plugin",
    revision: "abc",
    processId: "agent",
    args: ["--print"],
    cwd: "~/.buzz",
    env: { CLAUDECODE: null },
    protection: null,
    agentCredential: false,
    protectedAgent: null,
    onEvent: spawn.onEvent,
    mcp: {
      url: "http://127.0.0.1:1234/mcp",
      headers: [{ name: "Authorization", value: "Bearer agent" }],
    },
  });
  expect(process?.actAs).toBeUndefined();
  spawn.onEvent.onmessage({ type: "stdout", data: "out" });
  spawn.onEvent.onmessage({ type: "stderr", data: "err" });
  expect(stdout).toEqual(["out"]);
  expect(stderr).toEqual(["err"]);

  vi.mocked(invoke).mockResolvedValue(undefined);
  await process?.write("line\n");
  await process?.end();
  expect(invoke).toHaveBeenCalledWith("plugin_host_process_write", {
    id: "example.plugin",
    handle: 7,
    data: "line\n",
    close: false,
  });
  expect(invoke).toHaveBeenCalledWith("plugin_host_process_write", {
    id: "example.plugin",
    handle: 7,
    data: "",
    close: true,
  });
  spawn.onEvent.onmessage({ type: "exit", code: 0 });
  await expect(process?.exited).resolves.toBe(0);
});

it("asks native for an agent credential and binds it to one agent", async () => {
  const { plugin } = pluginContext();
  vi.mocked(invoke).mockResolvedValueOnce(7);
  const process = await plugin.host.spawn?.("agent", {
    agentCredential: true,
  });
  expect(invoke).toHaveBeenCalledWith(
    "plugin_host_process_spawn",
    expect.objectContaining({ agentCredential: true }),
  );

  vi.mocked(invoke).mockResolvedValueOnce(undefined);
  await process?.actAs?.({ pubkey: "ab".repeat(32), relay: "wss://relay" });
  expect(invoke).toHaveBeenLastCalledWith("plugin_host_process_bind_agent", {
    id: "example.plugin",
    handle: 7,
    pubkey: "ab".repeat(32),
    relay: "wss://relay",
  });
});

it("writes a long input in order, in pieces the host accepts", async () => {
  const { plugin } = pluginContext();
  vi.mocked(invoke).mockResolvedValueOnce(7);
  const process = await plugin.host.spawn?.("agent");
  const pieces: string[] = [];
  vi.mocked(invoke).mockImplementation(async (_command, args) => {
    pieces.push((args as { data: string }).data);
  });
  // A pair straddles the first boundary.
  const long = `${"a".repeat(256 * 1024 - 1)}😀${"b".repeat(600 * 1024)}`;
  await Promise.all([process?.write(long), process?.write("next\n")]);
  expect(pieces).toHaveLength(5);
  expect(pieces.every((piece) => new Blob([piece]).size <= 1024 * 1024)).toBe(
    true,
  );
  expect(pieces[0]?.endsWith("a")).toBe(true);
  expect(pieces.join("")).toBe(`${long}next\n`);
});

it("keeps delivering process events after an output handler throws", async () => {
  const { plugin } = pluginContext();
  vi.mocked(invoke).mockResolvedValueOnce(7);
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const process = await plugin.host.spawn?.("agent", {
    onStdout: () => {
      throw new Error("handler bug");
    },
  });
  const [, spawn] = vi.mocked(invoke).mock.calls[0] as [
    string,
    { onEvent: { onmessage(event: unknown): void } },
  ];
  expect(() =>
    spawn.onEvent.onmessage({ type: "stdout", data: "out" }),
  ).not.toThrow();
  expect(error).toHaveBeenCalled();
  vi.mocked(invoke).mockResolvedValue(undefined);
  spawn.onEvent.onmessage({ type: "exit", code: 1 });
  await expect(process?.exited).resolves.toBe(1);
  error.mockRestore();
});

it("kills a plugin's processes when the plugin unloads", async () => {
  const root = new Context();
  new HostService(root);
  let host!: Host;
  const fiber = root
    .extend({ pluginOwner: { id: "example.plugin", revision: "abc" } })
    .plugin({
      inject: ["host"],
      apply: (ctx: Context) => {
        host = ctx.host;
      },
    });
  await fiber;
  vi.mocked(invoke).mockResolvedValue(3);
  await host.spawn?.("agent");
  vi.mocked(invoke).mockClear();
  await fiber.dispose();
  expect(invoke).toHaveBeenCalledWith("plugin_host_process_kill", {
    id: "example.plugin",
    handle: 3,
  });
});

it("kills a process that started as its plugin unloaded", async () => {
  const root = new Context();
  new HostService(root);
  let host!: Host;
  const fiber = root
    .extend({ pluginOwner: { id: "example.plugin", revision: "abc" } })
    .plugin({
      inject: ["host"],
      apply: (ctx: Context) => {
        host = ctx.host;
      },
    });
  await fiber;
  let started!: (handle: number) => void;
  vi.mocked(invoke).mockImplementation((command) =>
    command === "plugin_host_process_spawn"
      ? new Promise((resolve) => {
          started = resolve;
        })
      : Promise.resolve(undefined),
  );
  const spawning = host.spawn?.("agent");
  await fiber.dispose();
  started(4);
  await expect(spawning).rejects.toThrow();
  expect(invoke).toHaveBeenCalledWith("plugin_host_process_kill", {
    id: "example.plugin",
    handle: 4,
  });
});

it("refuses processes outside the desktop app", async () => {
  const { root, plugin } = pluginContext();
  await expect(root.host.spawn?.("agent")).rejects.toThrow(
    "installed desktop plugin",
  );
  vi.mocked(isTauri).mockReturnValue(false);
  await expect(plugin.host.spawn?.("agent")).rejects.toThrow(
    "installed desktop plugin",
  );
  expect(invoke).not.toHaveBeenCalled();
});

it.each([false, true])(
  "serves MCP as the calling plugin with sharedSession=%s",
  async (sharedSession) => {
    const { plugin } = pluginContext();
    vi.mocked(invoke).mockResolvedValueOnce({
      handle: 4,
      url: "http://127.0.0.1:5000/mcp",
      token: "secret",
    });
    const handler = vi.fn(async (message: unknown) => {
      const { id } = message as { id?: number };
      return id === undefined ? undefined : { jsonrpc: "2.0", id, result: {} };
    });
    const server = await plugin.host.serveMcp?.(handler, { sharedSession });
    const [, serve] = vi.mocked(invoke).mock.calls[0] as [
      string,
      { onEvent: { onmessage(event: unknown): void } },
    ];
    expect(invoke).toHaveBeenCalledWith("plugin_host_mcp_serve", {
      id: "example.plugin",
      revision: "abc",
      onEvent: serve.onEvent,
      ...(sharedSession ? { sharedSession: true } : {}),
    });
    expect(server?.url).toBe("http://127.0.0.1:5000/mcp");
    expect(server?.headers).toEqual([
      { name: "Authorization", value: "Bearer secret" },
    ]);

    vi.mocked(invoke).mockResolvedValue(undefined);
    serve.onEvent.onmessage({
      type: "message",
      request: 1,
      body: '{"jsonrpc":"2.0","id":9,"method":"ping"}',
    });
    serve.onEvent.onmessage({
      type: "message",
      request: 2,
      body: '{"jsonrpc":"2.0","method":"notifications/initialized"}',
    });
    serve.onEvent.onmessage({ type: "message", request: 3, body: "{" });
    await vi.waitFor(() =>
      expect(vi.mocked(invoke).mock.calls.length).toBeGreaterThanOrEqual(4),
    );
    expect(invoke).toHaveBeenCalledWith("plugin_host_mcp_reply", {
      id: "example.plugin",
      handle: 4,
      request: 1,
      body: '{"jsonrpc":"2.0","id":9,"result":{}}',
    });
    // A notification is accepted without a body.
    expect(invoke).toHaveBeenCalledWith("plugin_host_mcp_reply", {
      id: "example.plugin",
      handle: 4,
      request: 2,
      body: null,
    });
    expect(invoke).toHaveBeenCalledWith("plugin_host_mcp_reply", {
      id: "example.plugin",
      handle: 4,
      request: 3,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      }),
    });

    await server?.close();
    expect(invoke).toHaveBeenCalledWith("plugin_host_mcp_close", {
      id: "example.plugin",
      handle: 4,
    });
    serve.onEvent.onmessage({ type: "closed" });
    await expect(server?.closed).resolves.toBeUndefined();
  },
);

it("counts actual plugin MCP reply encoding without retaining its contents", async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "document",
    Object.assign(new EventTarget(), {
      hidden: false,
      visibilityState: "visible",
    }),
  );
  const lifetime = new AbortController();
  try {
    const { plugin } = pluginContext();
    vi.mocked(invoke).mockResolvedValue({
      handle: 4,
      url: "http://127.0.0.1:5000/mcp",
      token: "secret",
    });
    const reply = {
      jsonrpc: "2.0",
      id: 9,
      result: { private: "private message" },
    };
    const server = await plugin.host.serveMcp?.(async () => reply);
    const [, serve] = vi.mocked(invoke).mock.calls[0] as [
      string,
      { onEvent: { onmessage(event: unknown): void } },
    ];
    const pending = runtimePerformance.capture(1000, () => () => {}, [
      lifetime.signal,
    ]);
    serve.onEvent.onmessage({
      type: "message",
      request: 1,
      body: '{"jsonrpc":"2.0","id":9,"method":"ping"}',
    });
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("plugin_host_mcp_reply", {
        id: "example.plugin",
        handle: 4,
        request: 1,
        body: JSON.stringify(reply),
      }),
    );
    await vi.advanceTimersByTimeAsync(1000);
    const encoded = JSON.stringify(await pending);
    expect(JSON.parse(encoded).mcpReplies).toMatchObject({
      count: 1,
      codeUnits: 63,
      failed: 0,
    });
    expect(encoded).not.toContain("private message");
    await server?.close();
  } finally {
    lifetime.abort();
    vi.useRealTimers();
  }
});

it("answers a failed MCP request with a JSON-RPC error", async () => {
  const { plugin } = pluginContext();
  vi.mocked(invoke).mockResolvedValueOnce({ handle: 4, url: "u", token: "t" });
  await plugin.host.serveMcp?.(async () => {
    throw new Error("relay down");
  });
  const [, serve] = vi.mocked(invoke).mock.calls[0] as [
    string,
    { onEvent: { onmessage(event: unknown): void } },
  ];
  vi.mocked(invoke).mockResolvedValue(undefined);
  serve.onEvent.onmessage({
    type: "message",
    request: 1,
    body: '{"jsonrpc":"2.0","id":"a","method":"tools/call"}',
  });
  await vi.waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("plugin_host_mcp_reply", {
      id: "example.plugin",
      handle: 4,
      request: 1,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "a",
        error: { code: -32603, message: "relay down" },
      }),
    }),
  );
});

it("answers with an error when a reply cannot be delivered", async () => {
  const { plugin } = pluginContext();
  vi.mocked(invoke).mockResolvedValueOnce({ handle: 4, url: "u", token: "t" });
  await plugin.host.serveMcp?.(async (message) => ({
    jsonrpc: "2.0",
    id: (message as { id: unknown }).id,
    result: { count: 1n },
  }));
  const [, serve] = vi.mocked(invoke).mock.calls[0] as [
    string,
    { onEvent: { onmessage(event: unknown): void } },
  ];
  // A reply the native side refuses as too large takes the same path.
  vi.mocked(invoke).mockResolvedValue(undefined);
  serve.onEvent.onmessage({
    type: "message",
    request: 1,
    body: '{"jsonrpc":"2.0","id":7,"method":"tools/call"}',
  });
  await vi.waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("plugin_host_mcp_reply", {
      id: "example.plugin",
      handle: 4,
      request: 1,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        error: {
          code: -32603,
          message: "Do not know how to serialize a BigInt",
        },
      }),
    }),
  );
});

it("closes a plugin's MCP servers when the plugin unloads", async () => {
  const root = new Context();
  new HostService(root);
  let host!: Host;
  const fiber = root
    .extend({ pluginOwner: { id: "example.plugin", revision: "abc" } })
    .plugin({
      inject: ["host"],
      apply: (ctx: Context) => {
        host = ctx.host;
      },
    });
  await fiber;
  vi.mocked(invoke).mockResolvedValueOnce({ handle: 6, url: "u", token: "t" });
  await host.serveMcp?.(async () => undefined);
  vi.mocked(invoke).mockResolvedValue(undefined);
  await fiber.dispose();
  expect(invoke).toHaveBeenCalledWith("plugin_host_mcp_close", {
    id: "example.plugin",
    handle: 6,
  });
});

const onceContext = { boot: "12345678-1234-4234-8234-123456789abc", page: 1 };
const onceInput = {
  url: "https://example.test/submit",
  method: "POST" as const,
  body: "{}",
};
const callId = "abcdefab-1234-4234-8234-123456789abc";
const onceReply = { status: 200, headers: {}, body: "accepted" };

function reviewSession(root: Context, origin = "fixture-community") {
  const session = {
    viewer: "fixture-viewer",
    scope: "fixture-community:fixture-viewer",
  } as RelaySession;
  root.provide("relay", {
    snapshot: () => ({ session, origin }),
    subscribe: () => () => {},
  } as unknown as RelayData);
}

async function oncePlugin(community?: string) {
  const root = new Context();
  reviewSession(root, community);
  new HostService(root);
  let host!: Host;
  const fiber = root
    .extend({ pluginOwner: { id: "example.plugin", revision: "abc" } })
    .plugin({
      inject: ["host"],
      apply: (ctx: Context) => {
        host = ctx.host;
      },
    });
  await fiber;
  return { root, host, fiber };
}

it("passes recorded POST identity unchanged, shares context only within its calling fiber and never retries", async () => {
  const first = await oncePlugin();
  const second = await oncePlugin();
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "plugin_host_call_context" ? onceContext : onceReply,
  );
  try {
    await expect(
      first.host.requestOnce?.(onceInput, { callId }),
    ).resolves.toEqual(onceReply);
    await first.host.requestOnce?.(onceInput, { callId });
    await second.host.requestOnce?.(onceInput, { callId });
    const contexts = vi
      .mocked(invoke)
      .mock.calls.filter(([name]) => name === "plugin_host_call_context");
    const requests = vi
      .mocked(invoke)
      .mock.calls.filter(([name]) => name === "plugin_host_request");
    expect(contexts).toHaveLength(2);
    const payloads = requests.map(
      ([, body]) =>
        body as {
          request: unknown;
          once: { activation: string; callId: string };
        },
    );
    expect(payloads[0]?.request).toBe(onceInput);
    expect(payloads[0]?.once).toEqual({
      ...onceContext,
      activation: expect.any(String),
      callId,
    });
    expect(payloads[1]?.once).toEqual(payloads[0]?.once);
    expect(payloads[2]?.once.activation).not.toBe(payloads[0]?.once.activation);
    vi.mocked(invoke).mockRejectedValueOnce(
      "Host call already consumed; outcome unknown",
    );
    await expect(
      first.host.requestOnce?.(onceInput, { callId }),
    ).rejects.toThrow("already consumed");
    expect(invoke).toHaveBeenCalledTimes(6);
  } finally {
    await first.fiber.dispose();
    await second.fiber.dispose();
  }
});

it.each(["restart", "config update"] as const)(
  "starts fresh protected authority after a real Cordis %s on the same fiber",
  async (change) => {
    const { host, fiber } = await oncePlugin();
    const uid = fiber.uid;
    vi.mocked(invoke).mockImplementation(async (command) =>
      command === "plugin_host_call_context" ? onceContext : onceReply,
    );
    try {
      await expect(host.requestOnce?.(onceInput, { callId })).resolves.toEqual(
        onceReply,
      );
      if (change === "restart") await fiber.restart();
      else await fiber.update({ revision: "next" });
      expect(fiber.uid).toBe(uid);
      const nextId = "abcdefab-1234-4234-8234-123456789abd";
      await expect(
        host.requestOnce?.(onceInput, { callId: nextId }),
      ).resolves.toEqual(onceReply);
      const requests = protectedInvokes().map(
        ([, body]) =>
          body as {
            once: { activation: string; callId: string };
          },
      );
      expect(requests).toHaveLength(2);
      expect(requests[1]?.once.callId).toBe(nextId);
      expect(requests[1]?.once.activation).not.toBe(
        requests[0]?.once.activation,
      );
      expect(
        vi
          .mocked(invoke)
          .mock.calls.filter(([name]) => name === "plugin_host_call_context"),
      ).toHaveLength(2);
    } finally {
      await fiber.dispose();
    }
  },
);

it.each(["context", "reply"] as const)(
  "does not revive a captured protected lifetime waiting for %s after Cordis restart",
  async (phase) => {
    const { host, fiber } = await oncePlugin();
    let release!: (value: typeof onceContext | typeof onceReply) => void;
    const held = new Promise<typeof onceContext | typeof onceReply>(
      (resolve) => {
        release = resolve;
      },
    );
    let started!: () => void;
    const dispatched = new Promise<void>((resolve) => {
      started = resolve;
    });
    let holding = true;
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === "plugin_host_call_context")
        return holding && phase === "context"
          ? held
          : Promise.resolve(onceContext);
      if (holding && phase === "reply") {
        started();
        return held;
      }
      return Promise.resolve(onceReply);
    });
    const stale = host.requestOnce?.(onceInput, { callId });
    const refused = expect(stale).rejects.toThrow("inactive");
    try {
      if (phase === "reply") await dispatched;
      await fiber.restart();
      holding = false;
      const nextId = "abcdefab-1234-4234-8234-123456789abd";
      await expect(
        host.requestOnce?.(onceInput, { callId: nextId }),
      ).resolves.toEqual(onceReply);
      release(phase === "context" ? onceContext : onceReply);
      await refused;
      // Finishing the old call cannot discard or rebind the new activation.
      await expect(
        host.requestOnce?.(onceInput, {
          callId: "abcdefab-1234-4234-8234-123456789abe",
        }),
      ).resolves.toEqual(onceReply);
      const requests = protectedInvokes().map(
        ([, body]) =>
          body as {
            once: { activation: string; callId: string };
          },
      );
      expect(requests).toHaveLength(phase === "context" ? 2 : 3);
      const fresh = requests.filter(({ once }) => once.callId !== callId);
      expect(fresh[1]?.once.activation).toBe(fresh[0]?.once.activation);
      if (phase === "reply")
        expect(fresh[0]?.once.activation).not.toBe(
          requests[0]?.once.activation,
        );
      expect(
        vi
          .mocked(invoke)
          .mock.calls.filter(([name]) => name === "plugin_host_call_context"),
      ).toHaveLength(2);
    } finally {
      release(phase === "context" ? onceContext : onceReply);
      await refused;
      await fiber.dispose();
    }
  },
);

it.each([
  undefined,
  { boot: "not-a-uuid", page: 1 },
  { ...onceContext, page: -1 },
  { ...onceContext, page: 1.5 },
])(
  "refuses invalid native context %j without dispatching POST",
  async (context) => {
    const { host, fiber } = await oncePlugin();
    vi.mocked(invoke).mockResolvedValue(context);
    try {
      await expect(host.requestOnce?.(onceInput, { callId })).rejects.toThrow(
        "context is unavailable",
      );
      expect(invoke).toHaveBeenCalledExactlyOnceWith(
        "plugin_host_call_context",
      );
    } finally {
      await fiber.dispose();
    }
  },
);

it("fails closed and caches old-native context errors without fallback or authority refresh", async () => {
  const { host, fiber } = await oncePlugin();
  vi.mocked(invoke).mockRejectedValue(
    "Command plugin_host_call_context not found",
  );
  try {
    for (let i = 0; i < 2; i++)
      await expect(host.requestOnce?.(onceInput, { callId })).rejects.toThrow(
        "not found",
      );
    expect(invoke).toHaveBeenCalledExactlyOnceWith("plugin_host_call_context");
  } finally {
    await fiber.dispose();
  }
});

it("does not retry when newer frontend meets a native request command rejecting once", async () => {
  const input = { ...onceInput, secret: "api-key" };
  const { host, fiber } = await oncePlugin();
  vi.mocked(invoke)
    .mockResolvedValueOnce(onceContext)
    .mockRejectedValueOnce("Protected request unsupported");
  try {
    await expect(host.requestOnce?.(input, { callId })).rejects.toThrow(
      "unsupported",
    );
    expect(invoke).toHaveBeenCalledTimes(2);
    expect((protectedInvokes()[0]?.[1] as { request: unknown })?.request).toBe(
      input,
    );
  } finally {
    await fiber.dispose();
  }
});

it("refuses non-POST and noncanonical call identities before asking native for authority", async () => {
  const { host, fiber } = await oncePlugin();
  try {
    for (const request of [
      { ...onceInput, method: "GET" as const },
      { url: onceInput.url },
    ])
      await expect(host.requestOnce?.(request, { callId })).rejects.toThrow(
        "require POST",
      );
    for (const id of [callId.toUpperCase(), callId.replaceAll("-", ""), ""])
      await expect(
        host.requestOnce?.(onceInput, { callId: id }),
      ).rejects.toThrow("canonical UUID");
    vi.mocked(isTauri).mockReturnValue(false);
    await expect(host.requestOnce?.(onceInput, { callId })).rejects.toThrow(
      "desktop plugin",
    );
    expect(invoke).not.toHaveBeenCalled();
  } finally {
    await fiber.dispose();
  }
});

it("blocks a captured protected call immediately when real Cordis disposal begins", async () => {
  const { host, fiber } = await oncePlugin();
  const disposing = fiber.dispose();
  await expect(host.requestOnce?.(onceInput, { callId })).rejects.toThrow(
    "inactive",
  );
  await disposing;
  expect(invoke).not.toHaveBeenCalled();
});

it("does not dispatch after context resolves during Cordis disposal", async () => {
  const { host, fiber } = await oncePlugin();
  let release!: (value: typeof onceContext) => void;
  vi.mocked(invoke).mockReturnValue(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  const request = host.requestOnce?.(onceInput, { callId });
  expect(invoke).toHaveBeenCalledExactlyOnceWith("plugin_host_call_context");
  const disposed = fiber.dispose();
  release(onceContext);
  await expect(request).rejects.toThrow("inactive");
  await disposed;
  expect(invoke).toHaveBeenCalledTimes(1);
});

it("suppresses a queued successful response when Cordis disposes before its continuation", async () => {
  const { host, fiber } = await oncePlugin();
  let release!: (value: typeof onceReply) => void;
  let started!: () => void;
  const dispatch = new Promise<void>((resolve) => {
    started = resolve;
  });
  vi.mocked(invoke).mockImplementation((command) =>
    command === "plugin_host_call_context"
      ? Promise.resolve(onceContext)
      : new Promise((resolve) => {
          release = resolve;
          started();
        }),
  );
  const request = host.requestOnce?.(onceInput, { callId });
  await dispatch;
  release(onceReply);
  const disposed = fiber.dispose();
  await expect(request).rejects.toThrow("inactive");
  await disposed;
  expect(invoke).toHaveBeenCalledTimes(2);
});

function byteFrame(
  body = new Uint8Array([0, 159, 255]),
  metadata: unknown = { status: 418, headers: { "x-test": "bytes" } },
) {
  const meta = new TextEncoder().encode(JSON.stringify(metadata));
  const frame = new ArrayBuffer(4 + meta.length + body.length);
  new DataView(frame).setUint32(0, meta.length, false);
  new Uint8Array(frame, 4, meta.length).set(meta);
  new Uint8Array(frame, 4 + meta.length).set(body);
  return frame;
}
const byteInput = { url: "https://example.test/bytes", maxBytes: 3 };
const byteHash = "a".repeat(64);
const byteSaved = {
  path: "/private/plugin-artifacts/file",
  size: 3,
  sha256: byteHash,
  expiresAt: 2_000_000_000_000,
};

it("returns a non-text body view without a clone, accepts empty bodies and never obtains POST context", async () => {
  const { fiber, host } = await oncePlugin();
  const frame = byteFrame();
  vi.mocked(invoke)
    .mockResolvedValueOnce(frame)
    .mockResolvedValueOnce(byteFrame(new Uint8Array()));
  try {
    const result = await host.requestBytes?.(byteInput);
    expect(result).toMatchObject({
      status: 418,
      headers: { "x-test": "bytes" },
    });
    expect(result?.body).toEqual(new Uint8Array([0, 159, 255]));
    expect(result?.body.buffer).toBe(frame);
    expect((await host.requestBytes?.(byteInput))?.body.length).toBe(0);
    expect(vi.mocked(invoke).mock.calls.map(([name]) => name)).toEqual([
      "plugin_host_request_bytes",
      "plugin_host_request_bytes",
    ]);
    expect(vi.mocked(invoke).mock.calls[0]?.[1]).toEqual({
      id: "example.plugin",
      revision: "abc",
      request: byteInput,
    });
  } finally {
    await fiber.dispose();
  }
});

it("reads a public page's preview through its own command and validates the timeout first", async () => {
  const { fiber, host } = await oncePlugin();
  const page = { status: 200, preview: { title: "Example" } };
  vi.mocked(invoke).mockResolvedValueOnce(page);
  try {
    await expect(
      host.readPage?.("https://example.test/", { timeoutMs: 5000 }),
    ).resolves.toEqual(page);
    expect(vi.mocked(invoke).mock.calls).toEqual([
      [
        "plugin_host_read_page",
        {
          id: "example.plugin",
          revision: "abc",
          url: "https://example.test/",
          timeoutMs: 5000,
        },
      ],
    ]);
    for (const timeoutMs of [0, 1.5, 30001])
      await expect(
        host.readPage?.("https://example.test/", { timeoutMs }),
      ).rejects.toThrow("Invalid page request");
    expect(invoke).toHaveBeenCalledTimes(1);
  } finally {
    await fiber.dispose();
  }
});
it("refuses fallback arrays and corrupted frames before returning any bytes", async () => {
  const { fiber, host } = await oncePlugin();
  const wrongLength = byteFrame();
  new DataView(wrongLength).setUint32(0, wrongLength.byteLength, false);
  const invalidUtf8 = new Uint8Array([0, 0, 0, 1, 255]).buffer;
  const inputs = [
    [0, 0, 0, 1, 0],
    new Uint8Array([1]),
    new ArrayBuffer(3),
    wrongLength,
    invalidUtf8,
    byteFrame(new Uint8Array(4)),
    byteFrame(new Uint8Array(), null),
    byteFrame(new Uint8Array(), { status: 99, headers: {} }),
    byteFrame(new Uint8Array(), { status: 600, headers: {} }),
    byteFrame(new Uint8Array(), { status: 200.5, headers: {} }),
    byteFrame(new Uint8Array(), { status: 200, headers: [] }),
    byteFrame(new Uint8Array(), { status: 200, headers: { x: 1 } }),
    byteFrame(new Uint8Array(), {
      status: 200,
      headers: { "set-cookie": "a=b" },
    }),
    byteFrame(new Uint8Array(), { status: 200, headers: { x: "a\r\nb" } }),
    byteFrame(new Uint8Array(), { status: 200, headers: { "bad name": "x" } }),
    byteFrame(new Uint8Array(), {
      status: 200,
      headers: Object.fromEntries(
        Array.from({ length: 65 }, (_, i) => [`h${i}`, "x"]),
      ),
    }),
    byteFrame(new Uint8Array(), {
      status: 200,
      headers: { x: "é".repeat(8192) },
    }),
    byteFrame(new Uint8Array(), {
      status: 200,
      headers: { x: "x".repeat(21 * 1024) },
    }),
  ];
  try {
    for (const input of inputs) {
      vi.mocked(invoke).mockResolvedValueOnce(input);
      await expect(host.requestBytes?.(byteInput)).rejects.toThrow();
    }
    expect(invoke).toHaveBeenCalledTimes(inputs.length);
  } finally {
    await fiber.dispose();
  }
});

it("validates byte limits before IPC and uses only raw top-level save bytes with bounded metadata", async () => {
  const { fiber, host } = await oncePlugin();
  const bytes = new Uint8Array([0, 159, 255]);
  try {
    for (const maxBytes of [0, -1, 1.5, Number.NaN, 16 * 1024 * 1024 + 1])
      await expect(
        host.requestBytes?.({ ...byteInput, maxBytes }),
      ).rejects.toThrow("limits");
    for (const timeoutMs of [0, 1.5, 30001])
      await expect(
        host.requestBytes?.({ ...byteInput, timeoutMs }),
      ).rejects.toThrow("limits");
    for (const data of [new Uint8Array(), new Uint8Array(16 * 1024 * 1024 + 1)])
      await expect(
        host.saveBytes?.(data, { sha256: byteHash }),
      ).rejects.toThrow("Invalid");
    for (const sha256 of ["A".repeat(64), "a".repeat(63), "g".repeat(64)])
      await expect(host.saveBytes?.(bytes, { sha256 })).rejects.toThrow(
        "Invalid",
      );
    expect(invoke).not.toHaveBeenCalled();
    vi.mocked(invoke).mockResolvedValueOnce(byteSaved);
    await expect(
      host.saveBytes?.(bytes, { sha256: byteHash }),
    ).resolves.toEqual(byteSaved);
    expect(invoke).toHaveBeenCalledExactlyOnceWith(
      "plugin_host_save_bytes",
      bytes,
      {
        headers: {
          "x-buzz-plugin-id": "example.plugin",
          "x-buzz-plugin-revision": "abc",
          "x-buzz-sha256": byteHash,
        },
      },
    );
    expect(vi.mocked(invoke).mock.calls[0]?.[1]).toBe(bytes);
  } finally {
    await fiber.dispose();
  }
});

it("rejects malformed save results and never retries unknown saves", async () => {
  const { fiber, host } = await oncePlugin();
  try {
    for (const result of [
      null,
      { ...byteSaved, path: "" },
      { ...byteSaved, size: 2 },
      { ...byteSaved, sha256: "b".repeat(64) },
      { ...byteSaved, expiresAt: 1.5 },
    ]) {
      vi.mocked(invoke).mockResolvedValueOnce(result);
      await expect(
        host.saveBytes?.(new Uint8Array(3), { sha256: byteHash }),
      ).rejects.toThrow("outcome unknown");
    }
    vi.mocked(invoke).mockRejectedValueOnce("reply lost");
    await expect(
      host.saveBytes?.(new Uint8Array(3), { sha256: byteHash }),
    ).rejects.toThrow("reply lost");
    expect(invoke).toHaveBeenCalledTimes(6);
  } finally {
    await fiber.dispose();
  }
});

it.each(["get", "save"] as const)(
  "suppresses queued %s success and refuses captured calls during synchronous Cordis disposal",
  async (kind) => {
    const { host, fiber } = await oncePlugin();
    let finish!: (value: unknown) => void;
    vi.mocked(invoke).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const run = () =>
      kind === "get"
        ? host.requestBytes?.(byteInput)
        : host.saveBytes?.(new Uint8Array(3), { sha256: byteHash });
    const pending = run();
    finish(kind === "get" ? byteFrame() : byteSaved);
    const disposing = fiber.dispose();
    await expect(pending).rejects.toThrow("inactive");
    await expect(run()).rejects.toThrow("inactive");
    expect(invoke).toHaveBeenCalledTimes(1);
    await disposing;
    await fiber.dispose();
  },
);

function deferredOnceContext() {
  let resolve!: (value: typeof onceContext) => void;
  let reject!: (reason: Error) => void;
  const context = new Promise<typeof onceContext>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  vi.mocked(invoke).mockImplementation((command) =>
    command === "plugin_host_call_context"
      ? context
      : Promise.resolve(onceReply),
  );
  return { resolve, reject };
}
const protectedInvokes = () =>
  vi
    .mocked(invoke)
    .mock.calls.filter(([name]) => name === "plugin_host_request");

it("final eligibility checks once after deferred context before one exact POST", async () => {
  const { host, fiber } = await oncePlugin();
  const held = deferredOnceContext();
  const isEligible = vi.fn(() => true);
  try {
    const options = { callId, isEligible };
    const request = host.requestOnce?.(onceInput, options);
    expect(isEligible).not.toHaveBeenCalled();
    expect(protectedInvokes()).toHaveLength(0);
    held.resolve(onceContext);
    await expect(request).resolves.toEqual(onceReply);
    expect(isEligible).toHaveBeenCalledExactlyOnceWith();
    expect(protectedInvokes()).toEqual([
      [
        "plugin_host_request",
        {
          id: "example.plugin",
          revision: "abc",
          request: onceInput,
          once: { ...onceContext, activation: expect.any(String), callId },
        },
      ],
    ]);
  } finally {
    held.resolve(onceContext);
    await fiber.dispose();
  }
});

it("final eligibility sees true becoming false while native context is pending", async () => {
  const { host, fiber } = await oncePlugin();
  const held = deferredOnceContext();
  let eligible = true;
  const isEligible = vi.fn(() => eligible);
  const options = { callId, isEligible };
  const request = host.requestOnce?.(
    { ...onceInput, secret: "api-key" },
    options,
  );
  const refused = expect(request).rejects.toThrow("eligibility");
  try {
    expect(isEligible).not.toHaveBeenCalled();
    eligible = false;
    held.resolve(onceContext);
    await refused;
    expect(isEligible).toHaveBeenCalledTimes(1);
    expect(protectedInvokes()).toHaveLength(0);
  } finally {
    held.resolve(onceContext);
    await fiber.dispose();
  }
});

it("final eligibility rejects elapsed monotonic deadline before its timer task executes", async () => {
  const { host, fiber } = await oncePlugin();
  const held = deferredOnceContext();
  vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
  let timerRan = false;
  const deadline = performance.now() + 300_000;
  const timer = setTimeout(() => {
    timerRan = true;
  }, 300_000);
  const options = { callId, isEligible: () => performance.now() < deadline };
  const request = host.requestOnce?.(onceInput, options);
  const refused = expect(request).rejects.toThrow("eligibility");
  try {
    // Move the clock, not the task queue: expiry must not depend on the timer.
    vi.spyOn(performance, "now").mockReturnValue(deadline + 1);
    held.resolve(onceContext);
    await refused;
    expect(timerRan).toBe(false);
    expect(protectedInvokes()).toHaveLength(0);
  } finally {
    held.resolve(onceContext);
    clearTimeout(timer);
    vi.restoreAllMocks();
    vi.useRealTimers();
    await fiber.dispose();
  }
});

it.each([
  "false",
  "undefined",
  "number",
  "string",
  "object",
  "throw",
  "promise",
  "rejected promise",
  "thenable",
])(
  "final eligibility rejects %s without dispatch or unhandled async rejection",
  async (kind) => {
    const { host, fiber } = await oncePlugin();
    const held = deferredOnceContext();
    const isEligible = vi.fn(() => {
      switch (kind) {
        case "false":
          return false;
        case "number":
          return 1;
        case "string":
          return "true";
        case "object":
          return {};
        case "throw":
          throw new Error("caller failure");
        case "promise":
          return Promise.resolve(true);
        case "rejected promise":
          return Promise.reject(new Error("async caller failure"));
        case "thenable":
          // biome-ignore lint/suspicious/noThenProperty: Deliberately invalid async callback result must fail closed.
          return { then: (resolve: (value: boolean) => void) => resolve(true) };
        default:
          return undefined;
      }
    });
    const options = { callId, isEligible: isEligible as () => boolean };
    const request = host.requestOnce?.(onceInput, options);
    const refused = expect(request).rejects.toThrow("eligibility");
    try {
      held.resolve(onceContext);
      await refused;
      expect(isEligible).toHaveBeenCalledTimes(1);
      expect(protectedInvokes()).toHaveLength(0);
    } finally {
      held.resolve(onceContext);
      await fiber.dispose();
    }
  },
);

it("final eligibility cannot dispose the calling Cordis fiber and still dispatch", async () => {
  const { host, fiber } = await oncePlugin();
  const held = deferredOnceContext();
  let disposing: Promise<void> | undefined;
  const options = {
    callId,
    isEligible: () => {
      disposing = fiber.dispose();
      return true;
    },
  };
  const request = host.requestOnce?.(onceInput, options);
  const refused = expect(request).rejects.toThrow("inactive");
  try {
    held.resolve(onceContext);
    await refused;
    expect(protectedInvokes()).toHaveLength(0);
  } finally {
    held.resolve(onceContext);
    await disposing;
    await fiber.dispose();
  }
});

it.each(["reject", "invalid"])(
  "final eligibility never runs after %s context",
  async (kind) => {
    const { host, fiber } = await oncePlugin();
    const held = deferredOnceContext();
    const isEligible = vi.fn(() => true);
    const options = { callId, isEligible };
    const request = host.requestOnce?.(
      { ...onceInput, secret: "api-key" },
      options,
    );
    const refused = expect(request).rejects.toThrow(
      kind === "reject" ? "context rejected" : "context is unavailable",
    );
    try {
      if (kind === "reject") held.reject(new Error("context rejected"));
      else held.resolve({ ...onceContext, page: -1 });
      await refused;
      expect(isEligible).not.toHaveBeenCalled();
      expect(protectedInvokes()).toHaveLength(0);
    } finally {
      held.resolve(onceContext);
      await fiber.dispose();
    }
  },
);

it("final eligibility omission preserves deferred protected dispatch without serializing a predicate", async () => {
  const { host, fiber } = await oncePlugin();
  const held = deferredOnceContext();
  try {
    const request = host.requestOnce?.(onceInput, { callId });
    held.resolve(onceContext);
    await expect(request).resolves.toEqual(onceReply);
    expect(protectedInvokes()).toHaveLength(1);
    expect(protectedInvokes()[0]?.[1]).not.toHaveProperty("isEligible");
  } finally {
    held.resolve(onceContext);
    await fiber.dispose();
  }
});

it("deletes only by the calling installed plugin and suppresses disposed completion", async () => {
  const { host, fiber } = await oncePlugin();
  vi.mocked(invoke).mockResolvedValueOnce(undefined);
  await host.deleteManagedFile?.(byteSaved.path);
  expect(invoke).toHaveBeenCalledExactlyOnceWith(
    "plugin_host_delete_managed_file",
    {
      id: "example.plugin",
      revision: "abc",
      path: byteSaved.path,
    },
  );
  vi.mocked(invoke).mockClear();
  for (const path of ["", "bad\0path"]) {
    await expect(host.deleteManagedFile?.(path)).rejects.toThrow();
  }
  expect(invoke).not.toHaveBeenCalled();
  let finish!: () => void;
  vi.mocked(invoke).mockReturnValueOnce(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  const pending = host.deleteManagedFile?.(byteSaved.path);
  const disposed = fiber.dispose();
  finish();
  await expect(pending).rejects.toThrow("inactive");
  await disposed;
});

const byteUpload = {
  url: "https://example.test/upload",
  field: "image",
  name: "image.png",
  contentType: "image/png",
  fields: { label: "café" },
};

it("uploads an immutable raw snapshot with shared protected authority and no fallback", async () => {
  const { host, fiber } = await oncePlugin();
  let release!: (value: typeof onceContext) => void;
  vi.mocked(invoke).mockReturnValueOnce(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  const bytes = new Uint8Array([0, 159, 255]);
  const eligibility = vi.fn(() => true);
  try {
    const pending = host.uploadBytesOnce?.(bytes, byteUpload, {
      callId,
      isEligible: eligibility,
    });
    bytes.fill(1);
    expect(eligibility).not.toHaveBeenCalled();
    release(onceContext);
    vi.mocked(invoke).mockResolvedValueOnce(onceReply);
    await expect(pending).resolves.toEqual(onceReply);
    const [, body, options] = vi.mocked(invoke).mock.calls[1] ?? [];
    expect(body).toEqual(new Uint8Array([0, 159, 255]));
    const metadata = JSON.parse(
      new Headers(options?.headers).get("x-buzz-upload") ?? "",
    );
    expect(metadata).toEqual({
      id: "example.plugin",
      revision: "abc",
      upload: byteUpload,
      once: { ...onceContext, activation: expect.any(String), callId },
    });
    expect(eligibility).toHaveBeenCalledTimes(1);
    vi.mocked(invoke).mockResolvedValueOnce(onceReply);
    await host.requestOnce?.(onceInput, { callId });
    const post = vi.mocked(invoke).mock.calls[2]?.[1] as { once: unknown };
    expect(post.once).toEqual(metadata.once);
    vi.mocked(invoke).mockRejectedValueOnce("raw IPC unavailable");
    await expect(
      host.uploadBytesOnce?.(bytes, byteUpload, { callId }),
    ).rejects.toThrow("raw IPC");
    expect(invoke).toHaveBeenCalledTimes(4);
  } finally {
    await fiber.dispose();
  }
});

it("serializes upload metadata once and preserves escaped text when adding authority", async () => {
  const { host, fiber } = await oncePlugin();
  const fields = { caption: 'café 😀 "quoted"\r\n\\ trailing }' };
  const toJSON = vi.fn(() => ({ ...byteUpload, fields }));
  vi.mocked(invoke).mockResolvedValueOnce(onceContext);
  vi.mocked(invoke).mockResolvedValueOnce(onceReply);
  try {
    const input = { ...byteUpload, toJSON };
    await host.uploadBytesOnce?.(new Uint8Array([1]), input, { callId });
    expect(toJSON).toHaveBeenCalledTimes(1);
    const header = new Headers(
      vi.mocked(invoke).mock.calls[1]?.[2]?.headers,
    ).get("x-buzz-upload");
    expect(header).toMatch(/^[\x20-\x7e]+$/);
    expect(JSON.parse(header ?? "")).toEqual({
      id: "example.plugin",
      revision: "abc",
      upload: { ...byteUpload, fields },
      once: { ...onceContext, activation: expect.any(String), callId },
    });
  } finally {
    await fiber.dispose();
  }
});

it.each([new Uint8Array(), new Uint8Array(16777217), [1, 2]])(
  "refuses invalid upload bytes before acquiring authority",
  async (bytes) => {
    const { host, fiber } = await oncePlugin();
    try {
      await expect(
        host.uploadBytesOnce?.(bytes as Uint8Array, byteUpload, { callId }),
      ).rejects.toThrow("bytes");
      expect(invoke).not.toHaveBeenCalled();
    } finally {
      await fiber.dispose();
    }
  },
);

it.each([false, undefined, Promise.resolve(true), new Error("refused")])(
  "fails upload eligibility closed",
  async (eligible) => {
    const { host, fiber } = await oncePlugin();
    vi.mocked(invoke).mockResolvedValue(onceContext);
    try {
      await expect(
        host.uploadBytesOnce?.(new Uint8Array([1]), byteUpload, {
          callId,
          isEligible: (() => {
            if (eligible instanceof Error) throw eligible;
            return eligible;
          }) as () => boolean,
        }),
      ).rejects.toThrow("eligibility");
      expect(invoke).toHaveBeenCalledTimes(1);
    } finally {
      await fiber.dispose();
    }
  },
);

it("refuses uploads after disposal while native authority is pending", async () => {
  const { host, fiber } = await oncePlugin();
  let release!: (value: typeof onceContext) => void;
  vi.mocked(invoke).mockReturnValue(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  const pending = host.uploadBytesOnce?.(new Uint8Array([1]), byteUpload, {
    callId,
  });
  await fiber.dispose();
  release(onceContext);
  await expect(pending).rejects.toThrow("inactive");
  expect(invoke).toHaveBeenCalledTimes(1);
});

it("rejects oversized upload metadata without IPC", async () => {
  const { host, fiber } = await oncePlugin();
  try {
    await expect(
      host.uploadBytesOnce?.(
        new Uint8Array([1]),
        { ...byteUpload, fields: { large: "x".repeat(16384) } },
        { callId },
      ),
    ).rejects.toThrow("metadata");
    expect(invoke).not.toHaveBeenCalled();
  } finally {
    await fiber.dispose();
  }
});

it("pins upload metadata before authority and suppresses late results after disposal", async () => {
  const { host, fiber } = await oncePlugin();
  let context!: (value: typeof onceContext) => void;
  let finish!: (value: typeof onceReply) => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  vi.mocked(invoke).mockReturnValueOnce(
    new Promise((resolve) => {
      context = resolve;
    }),
  );
  vi.mocked(invoke).mockImplementationOnce(async (_command, _body, options) => {
    expect(
      JSON.parse(new Headers(options?.headers).get("x-buzz-upload") ?? "")
        .upload.name,
    ).toBe("image.png");
    markStarted();
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const upload = { ...byteUpload };
  const pending = host.uploadBytesOnce?.(new Uint8Array([1]), upload, {
    callId,
  });
  upload.name = "changed.png";
  context(onceContext);
  await started;
  await fiber.dispose();
  finish(onceReply);
  await expect(pending).rejects.toThrow("inactive");
  expect(invoke).toHaveBeenCalledTimes(2);
});

it.each(["browser", "unowned", "invalid-call-id"])(
  "refuses protected upload in %s",
  async (mode) => {
    const { host, fiber, root } = await oncePlugin();
    if (mode === "browser") vi.mocked(isTauri).mockReturnValue(false);
    try {
      await expect(
        (mode === "unowned" ? root.host : host).uploadBytesOnce?.(
          new Uint8Array([1]),
          byteUpload,
          { callId: mode === "invalid-call-id" ? "INVALID" : callId },
        ),
      ).rejects.toThrow();
      expect(invoke).not.toHaveBeenCalled();
    } finally {
      await fiber.dispose();
    }
  },
);

it("preserves requestOnce owner-first errors and matches upload owner wording", async () => {
  const { root, plugin } = pluginContext();
  const invalid = { url: onceInput.url, method: "GET" as const };
  const ownerError = "Protected requests require an installed desktop plugin";
  await expect(
    root.host.requestOnce?.(invalid, { callId: "bad" }),
  ).rejects.toThrow(ownerError);
  await expect(
    root.host.uploadBytesOnce?.(new Uint8Array(), byteUpload, {
      callId: "bad",
    }),
  ).rejects.toThrow(ownerError);
  vi.mocked(isTauri).mockReturnValue(false);
  await expect(
    plugin.host.requestOnce?.(invalid, { callId: "bad" }),
  ).rejects.toThrow(ownerError);
  await expect(
    plugin.host.uploadBytesOnce?.(new Uint8Array(), byteUpload, {
      callId: "bad",
    }),
  ).rejects.toThrow(ownerError);
  expect(invoke).not.toHaveBeenCalled();
});

it("keeps an asynchronous streamed message together with queued writes", async () => {
  const { plugin } = pluginContext();
  vi.mocked(invoke).mockResolvedValueOnce(7);
  const process = await plugin.host.spawn?.("agent");
  if (!process?.writeStream) throw new Error("Missing streaming process");
  const pieces: string[] = [];
  vi.mocked(invoke).mockImplementation(async (_command, args) => {
    pieces.push((args as { data: string }).data);
  });
  let release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  const stream = process.writeStream(
    (async function* () {
      yield "first";
      await held;
      yield "last\n";
    })(),
  );
  const next = process.write("next\n");
  await vi.waitFor(() => expect(pieces).toEqual(["first"]));
  release();
  await Promise.all([stream, next]);
  expect(pieces).toEqual(["first", "last\n", "next\n"]);
});

it("stops a process after a failed streamed frame and rejects queued writes", async () => {
  const { plugin } = pluginContext();
  vi.mocked(invoke).mockResolvedValueOnce(7);
  const process = await plugin.host.spawn?.("agent");
  if (!process?.writeStream) throw new Error("Missing streaming process");
  const pieces: string[] = [];
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "plugin_host_process_write")
      pieces.push((args as { data: string }).data);
  });
  const failed = process.writeStream(
    (async function* () {
      yield "partial";
      throw new Error("read failed");
    })(),
  );
  const next = process.write("next\n");
  await expect(failed).rejects.toThrow("read failed");
  await expect(next).rejects.toThrow("read failed");
  expect(pieces).toEqual(["partial"]);
  expect(invoke).toHaveBeenCalledWith(
    "plugin_host_process_kill",
    expect.objectContaining({ handle: 7 }),
  );
});

it("requires native acknowledgement for release-after-send saves without retry", async () => {
  const { fiber, host } = await oncePlugin();
  try {
    const input = { sha256: byteHash, releaseAfterSend: true };
    vi.mocked(invoke).mockResolvedValueOnce(byteSaved);
    await expect(host.saveBytes?.(new Uint8Array(3), input)).rejects.toThrow(
      "possibly saved",
    );
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(vi.mocked(invoke).mock.calls[0]?.[2]?.headers).toMatchObject({
      "x-buzz-release-after-send": "1",
    });
    vi.mocked(invoke).mockResolvedValueOnce({
      ...byteSaved,
      releaseAfterSend: true,
    });
    await expect(
      host.saveBytes?.(new Uint8Array(3), input),
    ).resolves.toMatchObject({ releaseAfterSend: true });
  } finally {
    await fiber.dispose();
  }
});

const reviewedRequest = {
  operation: "synthetic",
  body: "Original",
  destination: {
    community: "fixture-community",
    viewer: "fixture-viewer",
    channel: "origin-a",
  },
};
const reviewedReceipt = {
  callId,
  destination: {
    community: "fixture-community",
    viewer: "fixture-viewer",
    channel: "origin-a",
  },
  digest: "ab".repeat(32),
  outcome: "submitted",
};

it("freezes reviewed scalar inputs before authority and exposes no acceptance or private input IPC", async () => {
  const { host, fiber } = await oncePlugin();
  const held = deferredOnceContext();
  const input = {
    ...reviewedRequest,
    accepted: true,
    secret: "must-not-cross",
  };
  const request = host.reviewAndInvokeOnce?.(input, { callId });
  input.body = "Replacement";
  input.destination = { ...input.destination, channel: "origin-b" };
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "plugin_host_reviewed_invoke" ? reviewedReceipt : undefined,
  );
  try {
    held.resolve(onceContext);
    expect(await request).toEqual(reviewedReceipt);
    expect(invoke).toHaveBeenCalledWith("plugin_host_reviewed_invoke", {
      id: "example.plugin",
      revision: "abc",
      request: reviewedRequest,
      onReview: expect.any(Object),
      once: { ...onceContext, activation: expect.any(String), callId },
    });
    expect(invoke).toHaveBeenCalledWith("plugin_host_reviewed_retire", {
      callId,
    });
  } finally {
    held.resolve(onceContext);
    await fiber.dispose();
  }
});

it("validates the release flag before IPC and omits false", async () => {
  const { fiber, host } = await oncePlugin();
  try {
    for (const flag of [null, 1, "true", {}]) {
      const input = { sha256: byteHash, releaseAfterSend: flag as boolean };
      await expect(host.saveBytes?.(new Uint8Array(3), input)).rejects.toThrow(
        "Invalid",
      );
    }
    expect(invoke).not.toHaveBeenCalled();
    vi.mocked(invoke).mockResolvedValueOnce(byteSaved);
    await host.saveBytes?.(new Uint8Array(3), {
      sha256: byteHash,
      releaseAfterSend: false,
    });
    expect(vi.mocked(invoke).mock.calls[0]?.[2]?.headers).not.toHaveProperty(
      "x-buzz-release-after-send",
    );
  } finally {
    await fiber.dispose();
  }
});

it("retires a disposed reviewed call before delayed native context can dispatch", async () => {
  const { host, fiber } = await oncePlugin();
  const held = deferredOnceContext();
  const request = host.reviewAndInvokeOnce?.(reviewedRequest, { callId });
  const refused = expect(request).rejects.toThrow("inactive");
  vi.mocked(invoke).mockResolvedValue(undefined);
  try {
    await fiber.dispose();
    held.resolve(onceContext);
    await refused;
    expect(invoke).toHaveBeenCalledWith("plugin_host_reviewed_retire", {
      callId,
    });
    expect(
      vi
        .mocked(invoke)
        .mock.calls.filter(([name]) => name === "plugin_host_reviewed_invoke"),
    ).toHaveLength(0);
  } finally {
    held.resolve(onceContext);
    await fiber.dispose();
  }
});

it.each([undefined, false, "true", 1])(
  "rejects %s release acknowledgement without fallback or retry",
  async (ack) => {
    const { host, fiber } = await oncePlugin();
    try {
      vi.mocked(invoke).mockResolvedValueOnce({
        ...byteSaved,
        releaseAfterSend: ack,
      });
      await expect(
        host.saveBytes?.(new Uint8Array(3), {
          sha256: byteHash,
          releaseAfterSend: true,
        }),
      ).rejects.toThrow("possibly saved");
      expect(invoke).toHaveBeenCalledOnce();
    } finally {
      await fiber.dispose();
    }
  },
);

it.each(["unknown", "rejected", "mismatch"])(
  "never retries or renews reviewed authority after %s",
  async (mode) => {
    const { host, fiber } = await oncePlugin();
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "plugin_host_call_context") return onceContext;
      if (command === "plugin_host_reviewed_retire") return undefined;
      if (mode === "rejected") throw new Error("outcome unknown");
      return {
        ...reviewedReceipt,
        ...(mode === "unknown"
          ? { outcome: "unknown" }
          : { destination: "other" }),
      };
    });
    try {
      const result = host.reviewAndInvokeOnce?.(reviewedRequest, { callId });
      if (mode === "unknown")
        await expect(result).resolves.toMatchObject({ outcome: "unknown" });
      else await expect(result).rejects.toThrow(/unknown/);
      expect(vi.mocked(invoke).mock.calls.map(([name]) => name)).toEqual([
        "plugin_host_call_context",
        "plugin_host_reviewed_invoke",
        "plugin_host_reviewed_retire",
      ]);
    } finally {
      await fiber.dispose();
    }
  },
);

it("renderer disposal suppresses an opted-in acknowledgement without claiming native cancellation", async () => {
  const { host, fiber } = await oncePlugin();
  let finish!: (value: unknown) => void;
  vi.mocked(invoke).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = host.saveBytes?.(new Uint8Array(3), {
    sha256: byteHash,
    releaseAfterSend: true,
  });
  await fiber.dispose();
  finish({ ...byteSaved, releaseAfterSend: true });
  await expect(pending).rejects.toThrow("inactive");
  expect(invoke).toHaveBeenCalledExactlyOnceWith(
    "plugin_host_save_bytes",
    expect.any(Uint8Array),
    expect.anything(),
  );
});

function reviewGate<T>() {
  let resolve = (_value: T) => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each([false, true])(
  "keeps actual Cordis disposal pending after admission until confirmed native retirement (IPC failure: %s)",
  async (failRetirement) => {
    const { host, fiber } = await oncePlugin();
    const admitted = reviewGate<void>();
    const retirementStarted = reviewGate<void>();
    const deliverRetirement = reviewGate<void>();
    const retirementResponded = reviewGate<void>();
    const terminal = reviewGate<ReviewedInvocationReceipt>();
    let nativeLive = false;
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "plugin_host_call_context") return onceContext;
      if (command === "plugin_host_reviewed_invoke") {
        nativeLive = true;
        admitted.resolve();
        return terminal.promise;
      }
      if (command === "plugin_host_reviewed_retire") {
        retirementStarted.resolve();
        await deliverRetirement.promise;
        if (failRetirement) {
          retirementResponded.resolve();
          throw new Error("Retirement transport unavailable");
        }
        nativeLive = false;
        retirementResponded.resolve();
      }
      return undefined;
    });
    const pending = host.reviewAndInvokeOnce?.(reviewedRequest, { callId });
    const refused = expect(pending).rejects.toThrow("inactive");
    await admitted.promise;
    let completed = false;
    const disposed = fiber.dispose().then(() => {
      completed = true;
    });
    try {
      await retirementStarted.promise;
      // Drain the cleanup continuation queue after an observed IPC-start gate,
      // not a duration chosen to race the runner or native transport.
      await new Promise<void>((done) => setImmediate(done));
      expect(completed).toBe(false);
      expect(nativeLive).toBe(true);
      deliverRetirement.resolve();
      await retirementResponded.promise;
      await new Promise<void>((done) => setImmediate(done));
      if (failRetirement) {
        expect(completed).toBe(false);
        expect(nativeLive).toBe(true);
        // A separate, exact native terminal response is affirmative retirement,
        // unlike transport failure. No IPC retry or authority refresh occurs.
        nativeLive = false;
        terminal.resolve({ ...reviewedReceipt, outcome: "cancelled" });
      }
      await disposed;
      expect(nativeLive).toBe(false);
      terminal.resolve({ ...reviewedReceipt, outcome: "cancelled" });
      await refused;
      expect(vi.mocked(invoke).mock.calls.map(([name]) => name)).toEqual([
        "plugin_host_call_context",
        "plugin_host_reviewed_invoke",
        "plugin_host_reviewed_retire",
      ]);
    } finally {
      nativeLive = false;
      deliverRetirement.resolve();
      terminal.resolve({ ...reviewedReceipt, outcome: "cancelled" });
      await disposed;
    }
  },
);

it.each([false, true])(
  "gates actual PluginRuntime successor activation on native retirement after admission (IPC failure: %s)",
  async (failRetirement) => {
    const root = new Context();
    reviewSession(root);
    new HostService(root);
    const admitted = reviewGate<void>();
    const retireStarted = reviewGate<void>();
    const deliverRetire = reviewGate<void>();
    const retireResponded = reviewGate<void>();
    const terminal = reviewGate<ReviewedInvocationReceipt>();
    const successor = reviewGate<void>();
    let nativeLive = false;
    let starts = 0;
    let oldResult: Promise<unknown> | undefined;
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "plugin_host_call_context") return onceContext;
      if (command === "plugin_host_reviewed_invoke") {
        nativeLive = true;
        admitted.resolve();
        return terminal.promise;
      }
      if (command === "plugin_host_reviewed_retire") {
        retireStarted.resolve();
        await deliverRetire.promise;
        retireResponded.resolve();
        if (failRetirement) throw new Error("retirement IPC unavailable");
        nativeLive = false;
      }
      return undefined;
    });
    const runtime = new PluginRuntime(root, async () => ({
      inject: ["host"],
      apply(ctx) {
        starts++;
        if (starts === 1) {
          oldResult = ctx.host
            .reviewAndInvokeOnce?.(reviewedRequest, { callId })
            .catch((error: unknown) => error);
        } else {
          expect(nativeLive).toBe(false);
          successor.resolve();
        }
      },
    }));
    const plugin: PluginInfo = {
      manifest: { id: "example.plugin", name: "Review", apiVersion: 1 },
      source: "external",
      enabled: true,
      revision: "abc",
      previous: null,
      reloadable: true,
      error: null,
    };
    try {
      runtime.reconcile([plugin]);
      await admitted.promise;
      runtime.reconcile([{ ...plugin, revision: "def" }]);
      await retireStarted.promise;
      await new Promise<void>((done) => setImmediate(done));
      expect(starts).toBe(1);
      expect(nativeLive).toBe(true);
      expect(runtime.snapshot()[plugin.manifest.id]?.status).toBe("starting");
      deliverRetire.resolve();
      await retireResponded.promise;
      await new Promise<void>((done) => setImmediate(done));
      if (failRetirement) {
        expect(starts).toBe(1);
        expect(nativeLive).toBe(true);
        nativeLive = false;
        terminal.resolve({ ...reviewedReceipt, outcome: "cancelled" });
      }
      await successor.promise;
      expect(starts).toBe(2);
      expect(nativeLive).toBe(false);
      terminal.resolve({ ...reviewedReceipt, outcome: "cancelled" });
      expect(await oldResult).toBeInstanceOf(Error);
      expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
        "plugin_host_call_context",
        "plugin_host_reviewed_invoke",
        "plugin_host_reviewed_retire",
      ]);
    } finally {
      nativeLive = false;
      deliverRetire.resolve();
      terminal.resolve({ ...reviewedReceipt, outcome: "cancelled" });
      await runtime.dispose();
      await root.fiber.dispose();
    }
  },
);

it("captures nested secrets per real Cordis fiber, retaining A after B", async () => {
  const root = new Context();
  new HostService(root);
  const owners = [
    { id: "example.alpha", revision: "a".repeat(64) },
    { id: "example.beta", revision: "b".repeat(64) },
  ];
  const hosts: Host[] = [];
  const fibers = owners.map((pluginOwner, index) =>
    root.extend({ pluginOwner }).plugin({
      inject: ["host"],
      apply: (ctx: Context) => {
        hosts[index] = ctx.host;
      },
    }),
  );
  try {
    await Promise.all(fibers);
    const a = hosts[0]?.secrets;
    vi.mocked(invoke).mockResolvedValue(null).mockResolvedValueOnce("saved");
    await expect(a?.status("alpha")).resolves.toBe("saved");
    const b = hosts[1]?.secrets;
    vi.mocked(invoke).mockResolvedValueOnce("missing");
    await expect(b?.status("beta")).resolves.toBe("missing");
    await expect(a?.set("alpha", "A value")).resolves.toBeUndefined();
    await expect(b?.clear("beta")).resolves.toBeUndefined();
    await expect(a?.clear("alpha")).resolves.toBeUndefined();
    await expect(b?.set("beta", "B value")).resolves.toBeUndefined();
    vi.mocked(invoke).mockResolvedValueOnce("unreadable");
    await expect(a?.status("alpha")).resolves.toBe("unreadable");
    const scopeA = { ...owners[0], slot: "alpha" };
    const scopeB = { ...owners[1], slot: "beta" };
    expect(vi.mocked(invoke).mock.calls).toEqual([
      ["plugin_host_secret_status", scopeA],
      ["plugin_host_secret_status", scopeB],
      ["plugin_host_secret_set", { ...scopeA, value: "A value" }],
      ["plugin_host_secret_clear", scopeB],
      ["plugin_host_secret_clear", scopeA],
      ["plugin_host_secret_set", { ...scopeB, value: "B value" }],
      ["plugin_host_secret_status", scopeA],
    ]);
  } finally {
    await Promise.all(fibers.map((fiber) => fiber.dispose()));
  }
});

it("refuses root, missing-owner child and browser secrets before IPC", async () => {
  const { root, plugin } = pluginContext();
  for (const host of [root.host, root.extend({}).host]) {
    await expect(host.secrets?.status("key")).rejects.toThrow("desktop plugin");
    await expect(host.secrets?.set("key", "value")).rejects.toThrow(
      "desktop plugin",
    );
    await expect(host.secrets?.clear("key")).rejects.toThrow("desktop plugin");
  }
  vi.mocked(isTauri).mockReturnValue(false);
  await expect(plugin.host.secrets?.status("key")).rejects.toThrow(
    "desktop plugin",
  );
  await expect(plugin.host.secrets?.set("key", "value")).rejects.toThrow(
    "desktop plugin",
  );
  await expect(plugin.host.secrets?.clear("key")).rejects.toThrow(
    "desktop plugin",
  );
  expect(invoke).not.toHaveBeenCalled();
});

it.each([null, undefined, {}, "value"])(
  "rejects malformed status %j and discards write results",
  async (result) => {
    const { plugin } = pluginContext();
    const secrets = plugin.host.secrets;
    vi.mocked(invoke).mockResolvedValue(result);
    await expect(secrets?.status("key")).rejects.toThrow(
      "Invalid saved credential status",
    );
    await expect(secrets?.set("key", "value")).resolves.toBeUndefined();
    await expect(secrets?.clear("key")).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledTimes(3);
  },
);

it.each([
  ["status", "Saved plugin credentials are unavailable"],
  ["clear", "Saved plugin credentials are unavailable"],
  [
    "set",
    "Buzz couldn't confirm saving the credential. Saving may still finish; do not retry yet.",
  ],
  ["status", "Command plugin_host_secret_status not found"],
] as const)(
  "preserves safe %s failures without retry or readback",
  async (operation, message) => {
    const { plugin } = pluginContext();
    const secrets = plugin.host.secrets;
    const call = () =>
      operation === "set"
        ? secrets?.set("key", "value")
        : secrets?.[operation]("key");
    vi.mocked(invoke).mockRejectedValueOnce(message);
    await expect(call()).rejects.toEqual(new Error(message));
    const error = new Error(message);
    vi.mocked(invoke).mockRejectedValueOnce(error);
    await expect(call()).rejects.toBe(error);
    expect(invoke).toHaveBeenCalledTimes(2);
  },
);

it("enrolls through slot-only protected IPC without renderer credential data", async () => {
  const { host, fiber } = await oncePlugin();
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "plugin_host_call_context" ? onceContext : "saved",
  );
  try {
    await expect(host.secrets?.enroll?.("key")).resolves.toBe("saved");
    expect(invoke).toHaveBeenCalledWith("plugin_host_secret_enroll", {
      id: "example.plugin",
      revision: "abc",
      slot: "key",
      once: {
        ...onceContext,
        activation: expect.any(String),
        callId: expect.any(String),
      },
    });
    expect(vi.mocked(invoke).mock.calls.map(([name]) => name)).toEqual([
      "plugin_host_call_context",
      "plugin_host_secret_enroll",
    ]);
  } finally {
    await fiber.dispose();
  }
});

it("retires private entry before delayed context can dispatch after disposal", async () => {
  const { host, fiber } = await oncePlugin();
  const held = deferredOnceContext();
  const pending = host.secrets?.enroll?.("key");
  const refused = expect(pending).rejects.toThrow("inactive");
  vi.mocked(invoke).mockResolvedValue(undefined);
  try {
    await fiber.dispose();
    held.resolve(onceContext);
    await refused;
    expect(vi.mocked(invoke).mock.calls.map(([name]) => name)).toEqual([
      "plugin_host_call_context",
      "plugin_host_reviewed_retire",
    ]);
  } finally {
    held.resolve(onceContext);
    await fiber.dispose();
  }
});

it.each([false, true])(
  "holds enrollment disposal until native retirement or exact terminal response (lost ack: %s)",
  async (lostAck) => {
    const { host, fiber } = await oncePlugin();
    const entered = reviewGate<void>();
    const retiring = reviewGate<void>();
    const acknowledgement = reviewGate<void>();
    const retirementResponded = reviewGate<void>();
    const terminal = reviewGate<"missing">();
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "plugin_host_call_context") return onceContext;
      if (command === "plugin_host_secret_enroll") {
        entered.resolve();
        return terminal.promise;
      }
      if (command === "plugin_host_reviewed_retire") {
        retiring.resolve();
        await acknowledgement.promise;
        retirementResponded.resolve();
        if (lostAck) throw new Error("acknowledgement unavailable");
      }
      return undefined;
    });
    const pending = host.secrets?.enroll?.("key");
    const refused = expect(pending).rejects.toThrow("inactive");
    await entered.promise;
    let complete = false;
    const disposed = fiber.dispose().then(() => {
      complete = true;
    });
    try {
      await retiring.promise;
      await new Promise<void>((done) => setImmediate(done));
      expect(complete).toBe(false);
      acknowledgement.resolve();
      await retirementResponded.promise;
      if (lostAck) {
        await new Promise<void>((done) => setImmediate(done));
        expect(complete).toBe(false);
        terminal.resolve("missing");
      }
      await disposed;
      terminal.resolve("missing");
      await refused;
      expect(vi.mocked(invoke).mock.calls.map(([name]) => name)).toEqual([
        "plugin_host_call_context",
        "plugin_host_secret_enroll",
        "plugin_host_reviewed_retire",
      ]);
    } finally {
      acknowledgement.resolve();
      terminal.resolve("missing");
      await disposed;
    }
  },
);

it.each(["outcome unknown", "malformed"])(
  "never retries private entry or falls back to renderer values after %s",
  async (mode) => {
    const { host, fiber } = await oncePlugin();
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "plugin_host_call_context") return onceContext;
      if (command === "plugin_host_reviewed_retire") return undefined;
      if (mode === "malformed") return { value: "must-not-be-returned" };
      throw new Error(mode);
    });
    try {
      await expect(host.secrets?.enroll?.("key")).rejects.toThrow(
        mode === "malformed" ? "Invalid saved credential status" : mode,
      );
      expect(vi.mocked(invoke).mock.calls.map(([name]) => name)).toEqual([
        "plugin_host_call_context",
        "plugin_host_secret_enroll",
        "plugin_host_reviewed_retire",
      ]);
    } finally {
      await fiber.dispose();
    }
  },
);

const nativeSupport = {
  version: 1,
  synthetic: true,
  credentialHttp: {
    version: 1,
    createResponse: true,
    continuation: false,
    result: false,
    delivery: false,
  },
};
const unsupported = { version: 1, synthetic: false, credentialHttp: null };

it("reports native support as read-only availability, failing closed", async () => {
  const { host, fiber } = await oncePlugin();
  try {
    vi.mocked(invoke).mockResolvedValue(nativeSupport);
    const support = await host.reviewedInvocationSupport?.();
    // Only this host adds review-start support; native never reports it.
    expect(support).toEqual({ ...nativeSupport, reviewStart: 1 });
    expect(Object.isFrozen(support?.credentialHttp)).toBe(true);
    // Checking support is not an invocation and asks native for nothing else.
    expect(vi.mocked(invoke).mock.calls).toEqual([
      ["plugin_host_reviewed_capabilities"],
    ]);
    for (const reply of [
      undefined,
      null,
      { ...nativeSupport, version: 2 },
      { ...nativeSupport, extra: true },
      { ...nativeSupport, reviewStart: 1 },
      { ...nativeSupport, synthetic: "yes" },
      { ...nativeSupport, credentialHttp: { version: 1 } },
      {
        ...nativeSupport,
        credentialHttp: { ...nativeSupport.credentialHttp, result: 1 },
      },
    ]) {
      vi.mocked(invoke).mockResolvedValueOnce(reply);
      expect(await host.reviewedInvocationSupport?.()).toEqual(unsupported);
    }
    vi.mocked(invoke).mockRejectedValueOnce(new Error("unknown command"));
    expect(await host.reviewedInvocationSupport?.()).toEqual(unsupported);
    vi.mocked(isTauri).mockReturnValue(false);
    vi.mocked(invoke).mockClear();
    expect(await host.reviewedInvocationSupport?.()).toEqual(unsupported);
    expect(invoke).not.toHaveBeenCalled();
  } finally {
    await fiber.dispose();
  }
});

const credentialRequest = {
  ...reviewedRequest,
  version: 1 as const,
  body: '{"prompt":"Original"}',
  effect: {
    kind: "credential-http" as const,
    method: "POST" as const,
    url: "https://api.example.test/v1/create",
    headers: { "x-version": "1", accept: "application/json" } as Record<
      string,
      string
    >,
    slot: "api-key",
  },
  disclosure: { version: "example/1", text: "About one credit" },
};
const digest = "cd".repeat(32);
const createResponse = {
  version: 1,
  callId,
  digest,
  destination: reviewedRequest.destination,
  sequence: 1,
  phase: "create-response",
  status: 200,
  safeBody: '{"id":"task"}',
};

type Native = {
  args: Record<string, unknown>;
  review(projection: unknown): void;
  progress(response: unknown): void;
};
async function credentialCall(
  onCreateResponse = vi.fn(),
  input: Record<string, unknown> = credentialRequest,
  origin?: ReturnType<typeof agentOrigin>["origin"],
) {
  const { root, host, fiber } = await oncePlugin(origin?.destination.community);
  const terminal = reviewGate<ReviewedInvocationReceipt>();
  const started = reviewGate<Native>();
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "plugin_host_call_context") return onceContext;
    if (command === "plugin_host_reviewed_invoke") {
      const ipc = args as Record<string, { onmessage(value: unknown): void }>;
      started.resolve({
        args: args as Record<string, unknown>,
        review: (projection) => ipc.onReview?.onmessage(projection),
        progress: (response) => ipc.onProgress?.onmessage(response),
      });
      return terminal.promise;
    }
    return undefined;
  });
  const result = (host as HostService)
    .reviewAndInvokeOnce(
      input as typeof credentialRequest,
      { callId, onCreateResponse },
      origin,
    )
    .catch((error: unknown) => error);
  const native = await started.promise;
  const reviewed = (root.host as HostService).reviewed;
  const approve = (projected: object = credentialRequest, extra = {}) => {
    native.review({
      ...extra,
      callId,
      pluginId: "example.plugin",
      revision: "abc",
      request: projected,
      ...(origin && {
        author: { pubkey: origin.invocation.pubkey, relay: origin.relay },
      }),
      digest,
      expiresAt: Date.now() + 60_000,
    });
    const current = reviewed.snapshot();
    if (current?.projection)
      reviewed.update({ ...current, status: "dispatching" });
  };
  const finish = async (
    receipt: ReviewedInvocationReceipt = {
      callId,
      destination: reviewedRequest.destination,
      digest,
      outcome: "unknown",
    },
  ) => {
    terminal.resolve(receipt);
    await result;
    await fiber.dispose();
  };
  return { host, native, reviewed, approve, finish, onCreateResponse, result };
}

const retires = () =>
  vi
    .mocked(invoke)
    .mock.calls.filter(([name]) => name === "plugin_host_reviewed_retire");

it("freezes versioned effect scalars and delivers one correlated create response", async () => {
  const input = structuredClone(credentialRequest);
  const call = await credentialCall(vi.fn(), input);
  input.effect.headers["x-version"] = "2";
  input.effect.url = "https://other.example.test";
  input.disclosure.text = "Free";
  try {
    expect(call.native.args.request).toEqual(credentialRequest);
    expect(call.native.args.onProgress).toBeDefined();
    // Header order may differ in the native projection.
    call.approve({
      ...credentialRequest,
      effect: {
        ...credentialRequest.effect,
        headers: { accept: "application/json", "x-version": "1" },
      },
    });
    expect(call.reviewed.snapshot()?.status).toBe("dispatching");
    call.native.progress(createResponse);
    expect(call.onCreateResponse).toHaveBeenCalledExactlyOnceWith(
      createResponse,
    );
    expect(Object.isFrozen(call.onCreateResponse.mock.calls[0]?.[0])).toBe(
      true,
    );
    call.native.progress(createResponse);
    expect(call.onCreateResponse).toHaveBeenCalledOnce();
    expect(retires()).toHaveLength(1);
  } finally {
    await call.finish();
  }
  expect(await call.result).toMatchObject({ outcome: "unknown" });
  expect(
    vi
      .mocked(invoke)
      .mock.calls.filter(([name]) => name === "plugin_host_reviewed_invoke"),
  ).toHaveLength(1);
});

it.each([
  ["call", { callId: "00000000-1234-4234-8234-123456789abc" }],
  ["digest", { digest: "ef".repeat(32) }],
  [
    "destination",
    { destination: { ...reviewedRequest.destination, channel: "x" } },
  ],
  ["sequence", { sequence: 2 }],
  ["phase", { phase: "status" }],
  ["status", { status: 99 }],
  ["body", { safeBody: 1 }],
])("refuses a create response with the wrong %s", async (_name, change) => {
  const call = await credentialCall();
  try {
    call.approve();
    call.native.progress({ ...createResponse, ...change });
    call.native.progress(createResponse);
    expect(call.onCreateResponse).not.toHaveBeenCalled();
    expect(retires()).toHaveLength(1);
    expect(call.reviewed.snapshot()?.status).toBe("retired");
  } finally {
    await call.finish();
  }
});

it("suppresses create responses before approval and refuses a changed effect projection", async () => {
  const call = await credentialCall();
  try {
    call.native.progress(createResponse);
    expect(call.onCreateResponse).not.toHaveBeenCalled();
    expect(retires()).toHaveLength(0);
    call.approve({
      ...credentialRequest,
      effect: { ...credentialRequest.effect, headers: { accept: "*/*" } },
    });
    expect(call.reviewed.snapshot()?.projection).toBeUndefined();
    expect(retires()).toHaveLength(1);
  } finally {
    await call.finish();
  }
});

/** An agent's tool call that asked to send to `reviewedRequest`'s destination. */
function agentOrigin(destination = reviewedRequest.destination) {
  const state = { open: true, live: true, lifetime: new AbortController() };
  const agent = {
    key: "agent-key",
    pubkey: "agent-pubkey",
    owner: "fixture-viewer",
    live: () => {
      if (!state.live) throw new Error("ask for its handle again");
    },
    lifetime: () => state.lifetime.signal,
  } as unknown as AgentHandle;
  const invocation = new AppInvocation(agent, { channel: "origin-a" }, () => {
    if (!state.open) throw new Error("The tool call has ended");
  });
  const origin = { invocation, relay: "wss://relay.test", destination };
  return { state, origin };
}
const reviewedInvokes = () =>
  vi
    .mocked(invoke)
    .mock.calls.filter(([name]) => name === "plugin_host_reviewed_invoke");

it.each([
  ["root that was absent", { root: "" }],
  ["root it was not asked", { root: "thread" }],
  ["channel", { channel: "origin-b" }],
  ["community", { community: "other-community" }],
])("refuses to send an agent's review to another %s", async (_name, change) => {
  const { host, fiber } = await oncePlugin();
  const { origin } = agentOrigin();
  const review = (host as HostService).reviewAndInvokeOnce.bind(host);
  try {
    const request = {
      ...reviewedRequest,
      destination: { ...reviewedRequest.destination, ...change },
    };
    await expect(review(request, { callId }, origin)).rejects.toThrow(
      "can only send where it was asked",
    );
    const forged = { ...origin, invocation: { ...origin.invocation } };
    await expect(
      review(reviewedRequest, { callId }, forged as never),
    ).rejects.toThrow("can only send where it was asked");
    expect(invoke).not.toHaveBeenCalled();
  } finally {
    await fiber.dispose();
  }
});

const taskDestination = {
  ...reviewedRequest.destination,
  root: "task",
  sourceRoot: "source",
};
it.each([
  ["without its source thread", { sourceRoot: undefined }],
  ["in another source thread", { sourceRoot: "other" }],
  ["in its task as the source thread", { sourceRoot: "task" }],
])("refuses to send a task review %s", async (_name, change) => {
  const { host, fiber } = await oncePlugin();
  const { origin } = agentOrigin(taskDestination);
  const review = (host as HostService).reviewAndInvokeOnce.bind(host);
  try {
    const { sourceRoot: _, ...rest } = taskDestination;
    const destination =
      change.sourceRoot === undefined ? rest : { ...rest, ...change };
    await expect(
      review({ ...reviewedRequest, destination }, { callId }, origin),
    ).rejects.toThrow("can only send where it was asked");
    expect(invoke).not.toHaveBeenCalled();
  } finally {
    await fiber.dispose();
  }
});

it("binds a task review only to a reader in its source thread", async () => {
  const { root, host, fiber } = await oncePlugin();
  const { origin } = agentOrigin(taskDestination);
  const request = { ...reviewedRequest, destination: taskDestination };
  const terminal = reviewGate<ReviewedInvocationReceipt>();
  const started = reviewGate<Native>();
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "plugin_host_call_context") return onceContext;
    if (command !== "plugin_host_reviewed_invoke") return undefined;
    const ipc = args as Record<string, { onmessage(value: unknown): void }>;
    started.resolve({
      args: args as Record<string, unknown>,
      review: (projection) => ipc.onReview?.onmessage(projection),
      progress: () => {},
    });
    return terminal.promise;
  });
  const result = (host as HostService)
    .reviewAndInvokeOnce(request, { callId }, origin)
    .catch((error: unknown) => error);
  try {
    const native = await started.promise;
    native.review({
      callId,
      pluginId: "example.plugin",
      revision: "abc",
      request,
      author: { pubkey: "agent-pubkey", relay: "wss://relay.test" },
      digest,
      expiresAt: Date.now() + 60_000,
    });
    const reviewed = (root.host as HostService).reviewed;
    const reader = (thread: string | undefined) => ({
      session: reviewed.snapshot()?.session,
      channel: "origin-a",
      root: "task",
      thread,
    });
    const mount = {};
    for (const thread of ["other", "task", undefined])
      expect(reviewed.bind(callId, mount, reader(thread))).toBe(false);
    expect(reviewed.bind(callId, mount, reader("source"))).toBe(true);
  } finally {
    terminal.resolve({
      ...reviewedReceipt,
      destination: taskDestination,
      outcome: "unknown",
    });
    await result;
    await fiber.dispose();
  }
});

it("refuses a source thread without the task it holds before IPC", async () => {
  const { host, fiber } = await oncePlugin();
  const destination = { ...reviewedRequest.destination, sourceRoot: "source" };
  const { origin } = agentOrigin(destination);
  const review = (host as HostService).reviewAndInvokeOnce.bind(host);
  try {
    await expect(
      review({ ...reviewedRequest, destination }, { callId }, origin),
    ).rejects.toThrow("Invalid reviewed invocation");
    expect(invoke).not.toHaveBeenCalled();
  } finally {
    await fiber.dispose();
  }
});

it.each(["at its start", "after the native context wait"])(
  "starts no agent review once its tool call has ended %s",
  async (when) => {
    const { host, fiber } = await oncePlugin();
    const held = deferredOnceContext();
    const { state, origin } = agentOrigin();
    const review = (host as HostService).reviewAndInvokeOnce.bind(host);
    try {
      if (when === "at its start") state.open = false;
      const onStarted = vi.fn();
      const pending = review(reviewedRequest, { callId, onStarted }, origin);
      state.open = false;
      held.resolve(onceContext);
      await expect(pending).rejects.toThrow(
        when === "at its start"
          ? "The tool call has ended"
          : "caller eligibility refused",
      );
      expect(reviewedInvokes()).toHaveLength(0);
      expect(onStarted).not.toHaveBeenCalled();
    } finally {
      held.resolve(onceContext);
      await fiber.dispose();
    }
  },
);

it("keeps a started agent review approvable after its call ends, until the agent stops", async () => {
  const { root, host, fiber } = await oncePlugin();
  const { state, origin } = agentOrigin();
  const terminal = reviewGate<ReviewedInvocationReceipt>();
  const started = reviewGate<Native>();
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "plugin_host_call_context") return onceContext;
    if (command !== "plugin_host_reviewed_invoke") return undefined;
    const ipc = args as Record<string, { onmessage(value: unknown): void }>;
    started.resolve({
      args: args as Record<string, unknown>,
      review: (projection) => ipc.onReview?.onmessage(projection),
      progress: () => {},
    });
    return terminal.promise;
  });
  const result = (host as HostService)
    .reviewAndInvokeOnce(reviewedRequest, { callId }, origin)
    .catch((error: unknown) => error);
  try {
    const native = await started.promise;
    const author = { pubkey: "agent-pubkey", relay: "wss://relay.test" };
    expect(native.args.author).toEqual(author);
    state.open = false;
    native.review({
      callId,
      pluginId: "example.plugin",
      revision: "abc",
      request: reviewedRequest,
      author,
      digest,
      expiresAt: Date.now() + 60_000,
    });
    const reviewed = (root.host as HostService).reviewed;
    const operation = reviewed.snapshot();
    expect(operation?.projection?.author).toEqual(author);
    expect(Object.isFrozen(operation?.projection?.author)).toBe(true);
    const reader = {
      session: operation?.session,
      channel: "origin-a",
      root: undefined,
      thread: undefined,
    };
    const mount = {};
    expect(reviewed.bind(callId, mount, reader)).toBe(true);
    const retirements = () =>
      vi
        .mocked(invoke)
        .mock.calls.filter(([name]) => name === "plugin_host_reviewed_retire");
    // The turn ending above retired nothing; the agent stopping does.
    expect(retirements()).toEqual([]);
    state.live = false;
    expect(reviewed.bind(callId, mount, reader)).toBe(false);
    state.lifetime.abort();
    expect(retirements()).toEqual([
      ["plugin_host_reviewed_retire", { callId }],
    ]);
    expect(reviewed.snapshot()?.status).toBe("retired");
  } finally {
    terminal.resolve({ ...reviewedReceipt, outcome: "unknown" });
    await result;
    await fiber.dispose();
  }
});

/** A review whose call context, native projection and terminal the test releases. */
async function startCall(
  options: Record<string, unknown> = {},
  origin?: ReturnType<typeof agentOrigin>["origin"],
) {
  const { root, host, fiber } = await oncePlugin();
  const context = reviewGate<typeof onceContext>();
  const terminal = reviewGate<ReviewedInvocationReceipt>();
  const dispatched = reviewGate<Native>();
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "plugin_host_call_context") return context.promise;
    if (command !== "plugin_host_reviewed_invoke") return undefined;
    const ipc = args as Record<string, { onmessage(value: unknown): void }>;
    dispatched.resolve({
      args: args as Record<string, unknown>,
      review: (projection) => ipc.onReview?.onmessage(projection),
      progress: (response) => ipc.onProgress?.onmessage(response),
    });
    return terminal.promise;
  });
  const onStarted = vi.fn();
  const onCreateResponse = vi.fn();
  const callOptions = { callId, onCreateResponse, onStarted, ...options };
  const settled = (host as HostService)
    .reviewAndInvokeOnce(credentialRequest, callOptions, origin)
    .then(
      (receipt) => ({ receipt }),
      (error: unknown) => ({ error }),
    );
  const projection = {
    callId,
    pluginId: "example.plugin",
    revision: "abc",
    request: credentialRequest,
    ...(origin && {
      author: { pubkey: origin.invocation.pubkey, relay: origin.relay },
    }),
    digest,
    expiresAt: Date.now() + 60_000,
  };
  const native = async () => {
    context.resolve(onceContext);
    return dispatched.promise;
  };
  const receipt = { ...reviewedReceipt, digest, outcome: "unknown" as const };
  const end = async () => {
    context.resolve(onceContext);
    terminal.resolve(receipt);
    const outcome = await settled;
    await fiber.dispose();
    return outcome;
  };
  const reviewed = (root.host as HostService).reviewed;
  return {
    fiber,
    callOptions,
    reviewed,
    native,
    projection,
    onStarted,
    onCreateResponse,
    terminal,
    receipt,
    settled,
    end,
  };
}

it("signals an agent's review start once native holds it, while its tool call stays open and before approval", async () => {
  const { state, origin } = agentOrigin();
  const call = await startCall({}, origin);
  try {
    // The tool call is still open while native authority is pending.
    expect(call.onStarted).not.toHaveBeenCalled();
    const native = await call.native();
    // Dispatching to native is not starting: native may still refuse it.
    expect(state.open).toBe(true);
    expect(call.onStarted).not.toHaveBeenCalled();
    native.review(call.projection);
    expect(call.onStarted).toHaveBeenCalledExactlyOnceWith();
    expect(call.reviewed.snapshot()).toMatchObject({
      status: "pending",
      projection: { digest },
    });
    // The tool call returns on start; the review stays approvable and blocked.
    state.open = false;
    native.review(call.projection);
    native.progress(createResponse);
    expect(call.onStarted).toHaveBeenCalledOnce();
    expect(call.onCreateResponse).not.toHaveBeenCalled();
    expect(call.reviewed.snapshot()?.status).toBe("pending");
    expect(retires()).toEqual([]);
    expect(reviewedInvokes()).toHaveLength(1);
  } finally {
    expect(await call.end()).toEqual({ receipt: call.receipt });
  }
});

it("refuses a non-function start callback before native authority", async () => {
  const { host, fiber } = await oncePlugin();
  try {
    await expect(
      host.reviewAndInvokeOnce?.(credentialRequest, {
        callId,
        onCreateResponse: () => {},
        onStarted: "yes" as never,
      }),
    ).rejects.toThrow("Invalid reviewed invocation");
    expect(invoke).not.toHaveBeenCalled();
  } finally {
    await fiber.dispose();
  }
});

it("copies the start callback before the first wait", async () => {
  const call = await startCall();
  const later = vi.fn();
  call.callOptions.onStarted = later;
  (await call.native()).review(call.projection);
  expect(call.onStarted).toHaveBeenCalledOnce();
  expect(later).not.toHaveBeenCalled();
  await call.end();
});

it.each([
  ["context refusal", "context"],
  ["IPC rejection", "reject"],
  ["synchronous dispatch failure", "throw"],
])("settles without starting on %s", async (_name, failure) => {
  const { host, fiber } = await oncePlugin();
  const onStarted = vi.fn();
  vi.mocked(invoke).mockImplementation(((command: string) => {
    if (command === "plugin_host_call_context")
      return failure === "context"
        ? Promise.reject(new Error("no context"))
        : Promise.resolve(onceContext);
    if (command !== "plugin_host_reviewed_invoke")
      return Promise.resolve(undefined);
    if (failure === "throw") throw new Error("dispatch");
    return Promise.reject(new Error("refused"));
  }) as never);
  try {
    await expect(
      host.reviewAndInvokeOnce?.(credentialRequest, {
        callId,
        onCreateResponse: () => {},
        onStarted,
      }),
    ).rejects.toThrow();
    expect(onStarted).not.toHaveBeenCalled();
    expect(reviewedInvokes()).toHaveLength(failure === "context" ? 0 : 1);
  } finally {
    await fiber.dispose();
  }
});

it("does not start on an invalid projection, and settles", async () => {
  const call = await startCall();
  const native = await call.native();
  native.review({ ...call.projection, digest: "not-a-digest" });
  native.review(call.projection);
  expect(call.onStarted).not.toHaveBeenCalled();
  expect(retires()).toHaveLength(1);
  expect(call.reviewed.snapshot()?.status).toBe("retired");
  expect(await call.end()).toEqual({ receipt: call.receipt });
  expect(reviewedInvokes()).toHaveLength(1);
});

it("contains a throwing start callback by retiring that exact call", async () => {
  const call = await startCall({
    onStarted: vi.fn(() => {
      throw new Error("plugin bug");
    }),
  });
  const native = await call.native();
  expect(() => native.review(call.projection)).not.toThrow();
  expect(retires()).toEqual([["plugin_host_reviewed_retire", { callId }]]);
  expect(call.reviewed.snapshot()?.status).toBe("retired");
  // Native still reports how the retired call ended; nothing is recreated.
  expect(await call.end()).toEqual({ receipt: call.receipt });
  expect(reviewedInvokes()).toHaveLength(1);
});

it.each(["agent stop", "retirement", "reentrant retirement", "disposal"])(
  "suppresses the start signal when %s wins first",
  async (stop) => {
    const { state, origin } = agentOrigin();
    const call = await startCall({}, origin);
    const native = await call.native();
    let disposing: Promise<unknown> | undefined;
    if (stop === "agent stop") state.lifetime.abort();
    if (stop === "retirement") void call.reviewed.retire(callId);
    if (stop === "reentrant retirement")
      call.reviewed.subscribe(() => {
        if (call.reviewed.snapshot()?.projection)
          void call.reviewed.retire(callId);
      });
    if (stop === "disposal") {
      disposing = Promise.resolve(call.fiber.dispose());
      await vi.waitFor(() => expect(retires()).toHaveLength(1));
    }
    native.review(call.projection);
    expect(call.onStarted).not.toHaveBeenCalled();
    expect(retires()).toHaveLength(1);
    call.terminal.resolve(call.receipt);
    await disposing;
    expect(await call.end()).toMatchObject(
      stop === "disposal" ? {} : { receipt: call.receipt },
    );
    expect(reviewedInvokes()).toHaveLength(1);
  },
);

it("ends a started review normally on a later stop, without a second signal", async () => {
  const { state, origin } = agentOrigin();
  const call = await startCall({}, origin);
  const native = await call.native();
  native.review(call.projection);
  state.lifetime.abort();
  native.review(call.projection);
  expect(call.onStarted).toHaveBeenCalledOnce();
  expect(retires()).toEqual([["plugin_host_reviewed_retire", { callId }]]);
  expect(await call.end()).toEqual({ receipt: call.receipt });
  expect(reviewedInvokes()).toHaveLength(1);
});

it("settles a review that ends before it starts, and ignores a late projection", async () => {
  const call = await startCall();
  const native = await call.native();
  call.terminal.resolve(call.receipt);
  expect(await call.settled).toEqual({ receipt: call.receipt });
  native.review(call.projection);
  expect(call.onStarted).not.toHaveBeenCalled();
  await call.end();
});

it.each([
  ["another agent", { pubkey: "other", relay: "wss://relay.test" }],
  ["another community", { pubkey: "agent-pubkey", relay: "wss://other.test" }],
  ["no agent", undefined],
])(
  "retires an agent review whose native projection names %s",
  async (_name, author) => {
    const { root, host, fiber } = await oncePlugin();
    const { origin } = agentOrigin();
    const terminal = reviewGate<ReviewedInvocationReceipt>();
    const started = reviewGate<Native>();
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "plugin_host_call_context") return onceContext;
      if (command !== "plugin_host_reviewed_invoke") return undefined;
      const ipc = args as Record<string, { onmessage(value: unknown): void }>;
      started.resolve({
        args: args as Record<string, unknown>,
        review: (projection) => ipc.onReview?.onmessage(projection),
        progress: () => {},
      });
      return terminal.promise;
    });
    const result = (host as HostService)
      .reviewAndInvokeOnce(reviewedRequest, { callId }, origin)
      .catch((error: unknown) => error);
    try {
      const native = await started.promise;
      native.review({
        callId,
        pluginId: "example.plugin",
        revision: "abc",
        request: reviewedRequest,
        ...(author && { author }),
        digest,
        expiresAt: Date.now() + 60_000,
      });
      const reviewed = (root.host as HostService).reviewed;
      expect(reviewed.snapshot()?.projection).toBeUndefined();
      expect(retires()).toHaveLength(1);
    } finally {
      terminal.resolve({ ...reviewedReceipt, outcome: "unknown" });
      await result;
      await fiber.dispose();
    }
  },
);

it("requires a create-response callback and complete effect before native authority", async () => {
  const { host, fiber } = await oncePlugin();
  try {
    await expect(
      host.reviewAndInvokeOnce?.(credentialRequest, { callId }),
    ).rejects.toThrow("Invalid reviewed invocation");
    const { disclosure: _, ...partial } = credentialRequest;
    await expect(
      host.reviewAndInvokeOnce?.(partial, {
        callId,
        onCreateResponse: () => {},
      }),
    ).rejects.toThrow("Invalid reviewed invocation");
    expect(invoke).not.toHaveBeenCalled();
  } finally {
    await fiber.dispose();
  }
});

const parentUrl = "https://api.example.test/v1/tasks/task";
const parentReply = (change: Record<string, unknown> = {}) => ({
  status: 200,
  headers: {},
  body: '{"status":"RUNNING"}',
  parent: {
    version: 1,
    callId,
    digest,
    destination: reviewedRequest.destination,
    sequence: 2,
    ...change,
  },
});
const parentReads = () =>
  vi
    .mocked(invoke)
    .mock.calls.filter(([name]) => name === "plugin_host_request");
async function continued() {
  const call = await credentialCall();
  call.approve();
  call.native.progress(createResponse);
  return call;
}

it("continues only the approved create, with frozen scalars and no fallback", async () => {
  const call = await credentialCall();
  const read = { url: parentUrl, parent: { version: 1 as const, callId } };
  const admission = "host-parent-read/v1/js-admission";
  try {
    await expect(call.host.request(read)).rejects.toThrow(admission);
    call.approve();
    await expect(call.host.request(read)).rejects.toThrow(admission);
    call.native.progress(createResponse);
    expect(parentReads()).toHaveLength(0);
    for (const refused of [
      { ...read, method: "POST" as const },
      { ...read, body: "{}" },
      { ...read, headers: { authorization: "x" } },
      { ...read, secret: "api-key" },
      { ...read, parent: { version: 2 as unknown as 1, callId } },
      { ...read, parent: { version: 1 as const, callId: crypto.randomUUID() } },
    ])
      await expect(call.host.request(refused)).rejects.toThrow(admission);
    expect(parentReads()).toHaveLength(0);

    vi.mocked(invoke).mockImplementationOnce(async () => parentReply());
    const input = structuredClone(read);
    const pending = call.host.request(input);
    input.url = "https://other.example.test";
    input.parent.callId = crypto.randomUUID();
    const response = await pending;
    expect(parentReads()[0]?.[1]).toEqual({
      id: "example.plugin",
      revision: "abc",
      request: { url: parentUrl, method: "GET" },
      parent: { version: 1, callId },
    });
    expect(response).toEqual(parentReply());
    expect(Object.isFrozen(response.parent)).toBe(true);

    vi.mocked(invoke).mockRejectedValueOnce(new Error("Refused"));
    await expect(call.host.request(read)).rejects.toThrow("Refused");
    expect(parentReads()).toHaveLength(2);
    expect(parentReads()[1]?.[1]).toHaveProperty("parent");
    // A native code is the exact rejected string, and the call continues.
    vi.mocked(invoke).mockRejectedValueOnce(
      "host-parent-read/v1/native-status",
    );
    const native = await call.host
      .request(read)
      .catch((error: unknown) => error);
    expect(native).toBeInstanceOf(Error);
    expect((native as Error).message).toBe("host-parent-read/v1/native-status");
    vi.mocked(invoke).mockImplementationOnce(async () =>
      parentReply({ sequence: 3 }),
    );
    expect((await call.host.request(read)).parent?.sequence).toBe(3);
    expect(retires()).toHaveLength(0);
  } finally {
    await call.finish();
  }
  await expect(
    call.host.request({ url: parentUrl, parent: { version: 1, callId } }),
  ).rejects.toThrow(admission);
});

it.each([
  ["call", { callId: "00000000-1234-4234-8234-123456789abc" }],
  ["digest", { digest: "ef".repeat(32) }],
  [
    "destination",
    { destination: { ...reviewedRequest.destination, channel: "x" } },
  ],
  [
    "source thread",
    { destination: { ...reviewedRequest.destination, sourceRoot: "x" } },
  ],
  ["sequence", { sequence: 1 }],
  ["missing", undefined],
])(
  "retires the call on a parent read with the wrong %s",
  async (_name, change) => {
    const call = await continued();
    try {
      const reply = parentReply(change);
      vi.mocked(invoke).mockImplementationOnce(async () =>
        change === undefined ? { ...reply, parent: undefined } : reply,
      );
      await expect(
        call.host.request({ url: parentUrl, parent: { version: 1, callId } }),
      ).rejects.toThrow("host-parent-read/v1/js-correlation");
      expect(retires()).toHaveLength(1);
    } finally {
      await call.finish();
    }
  },
);

it.each([
  ["success", true],
  ["native rejection", false],
])(
  "suppresses a held parent read's %s after retirement, then sends nothing",
  async (_name, succeeds) => {
    const call = await continued();
    const read = { url: parentUrl, parent: { version: 1 as const, callId } };
    try {
      let settle = () => {};
      vi.mocked(invoke).mockImplementationOnce(
        () =>
          new Promise((resolve, reject) => {
            settle = () =>
              succeeds
                ? resolve(parentReply())
                : reject("host-parent-read/v1/native-transport");
          }),
      );
      const pending = call.host.request(read).catch((error: unknown) => error);
      await call.reviewed.retire(callId).catch(() => {});
      settle();
      expect(String(await pending)).toBe(
        "Error: host-parent-read/v1/js-lifecycle",
      );
      await expect(call.host.request(read)).rejects.toThrow(
        "host-parent-read/v1/js-lifecycle",
      );
      expect(parentReads()).toHaveLength(1);
    } finally {
      await call.finish();
    }
  },
);

const resultInput = {
  url: "https://api.example.test/output.mp4",
  maxBytes: 3,
  parent: { version: 1 as const, callId },
};
const resultFrame = (change: Record<string, unknown> = {}) =>
  byteFrame(new Uint8Array([1, 2, 3]), {
    status: 200,
    headers: {},
    parent: parentReply().parent,
    source: { sha256: "b".repeat(64), size: 3 },
    ...change,
  });
const resultReads = () =>
  vi
    .mocked(invoke)
    .mock.calls.filter(([name]) => name === "plugin_host_request_bytes");

it("reads one parent result source with frozen scalars and no fallback", async () => {
  const call = await credentialCall();
  try {
    await expect(call.host.requestBytes?.(resultInput)).rejects.toThrow(
      "unavailable",
    );
    call.approve();
    call.native.progress(createResponse);
    for (const refused of [
      { ...resultInput, maxBytes: 0 },
      { ...resultInput, parent: { version: 2 as unknown as 1, callId } },
      {
        ...resultInput,
        parent: { version: 1 as const, callId: crypto.randomUUID() },
      },
    ])
      await expect(call.host.requestBytes?.(refused)).rejects.toThrow();
    expect(resultReads()).toHaveLength(0);

    vi.mocked(invoke).mockImplementationOnce(async () => resultFrame());
    const input = structuredClone(resultInput);
    const pending = call.host.requestBytes?.(input);
    input.url = "https://other.example.test";
    input.maxBytes = 99;
    const response = await pending;
    expect(resultReads()[0]?.[1]).toEqual({
      id: "example.plugin",
      revision: "abc",
      request: { url: resultInput.url, maxBytes: 3 },
      parent: { version: 1, callId },
    });
    expect(response?.body).toEqual(new Uint8Array([1, 2, 3]));
    expect(response?.source).toEqual({ sha256: "b".repeat(64), size: 3 });
    expect(response?.parent?.sequence).toBe(2);
    expect(Object.isFrozen(response)).toBe(true);

    vi.mocked(invoke).mockRejectedValueOnce(new Error("Refused"));
    await expect(call.host.requestBytes?.(resultInput)).rejects.toThrow(
      "Refused",
    );
    expect(resultReads()).toHaveLength(2);
    expect(retires()).toHaveLength(0);
  } finally {
    await call.finish();
  }
  await expect(call.host.requestBytes?.(resultInput)).rejects.toThrow(
    "unavailable",
  );
});

it.each([
  ["sequence", { parent: { ...parentReply().parent, sequence: 1 } }],
  [
    "call",
    { parent: { ...parentReply().parent, callId: crypto.randomUUID() } },
  ],
  ["size", { source: { sha256: "b".repeat(64), size: 2 } }],
  ["hash", { source: { sha256: "not-a-hash", size: 3 } }],
  ["missing source", { source: undefined }],
  ["headers", { headers: { "x-test": "bytes" } }],
  ["status", { status: 206 }],
])(
  "retires the call on a result read with the wrong %s",
  async (_name, change) => {
    const call = await continued();
    try {
      vi.mocked(invoke).mockImplementationOnce(async () => resultFrame(change));
      await expect(call.host.requestBytes?.(resultInput)).rejects.toThrow(
        "Invalid parent read",
      );
      expect(retires()).toHaveLength(1);
    } finally {
      await call.finish();
    }
  },
);

it("suppresses a result read that returns after retirement", async () => {
  const call = await continued();
  try {
    const held = reviewGate<unknown>();
    vi.mocked(invoke).mockImplementationOnce(() => held.promise);
    const pending = call.host
      .requestBytes?.(resultInput)
      .catch((error: unknown) => error);
    await call.reviewed.retire(callId).catch(() => {});
    held.resolve(resultFrame());
    expect(String(await pending)).toContain("unavailable");
  } finally {
    await call.finish();
  }
});

const media = {
  version: 1 as const,
  kind: "video" as const,
  container: "mp4" as const,
  codec: "h264" as const,
  width: 1280,
  height: 720,
  durationMs: 5000,
  toleranceMs: 50,
  maxBytes: 16 * 1024 * 1024,
};
const mediaRequest = { ...credentialRequest, expectedMedia: media };
const prepared = {
  version: 1,
  callId,
  digest,
  destination: credentialRequest.destination,
  phase: "prepared",
};
const selections = () =>
  vi
    .mocked(invoke)
    .mock.calls.filter(([name]) => name === "plugin_host_reviewed_result");
const pending = async (result: Promise<unknown> | undefined) =>
  Promise.race([
    result?.then(() => "settled"),
    new Promise((resolve) => setTimeout(() => resolve("pending"), 0)),
  ]);
/** A media call whose native peer serves one result read and one selection. */
async function mediaCall(
  select: (host: Host) => unknown,
  ack: (step: { phase: string }) => unknown = () => prepared,
  input: Record<string, unknown> = mediaRequest,
  origin?: ReturnType<typeof agentOrigin>["origin"],
) {
  let host: Host | undefined;
  const call = await credentialCall(
    vi.fn(() => select(host as Host)),
    input,
    origin,
  );
  host = call.host;
  const base = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "plugin_host_request_bytes")
      return resultFrame({
        parent: { ...parentReply().parent, destination: input.destination },
      });
    if (command === "plugin_host_reviewed_result")
      return ack((args as { step: { phase: string } }).step);
    return base?.(command, args);
  });
  return call;
}
const readAndSelect = async (host: Host) => {
  const read = await host.requestBytes?.(resultInput);
  return { source: read?.source };
};

it("freezes expected media scalars and retires a changed projection", async () => {
  const input = structuredClone(mediaRequest);
  const call = await credentialCall(vi.fn(), input);
  input.expectedMedia.durationMs = 9000;
  input.expectedMedia.maxBytes = 1;
  try {
    expect(call.native.args.request).toEqual(mediaRequest);
    call.approve({ ...mediaRequest, expectedMedia: { ...media, width: 1920 } });
    expect(call.reviewed.snapshot()?.projection).toBeUndefined();
    expect(retires()).toHaveLength(1);
  } finally {
    await call.finish();
  }
});

it("refuses malformed expected media before native authority", async () => {
  const { host, fiber } = await oncePlugin();
  try {
    for (const change of [
      { version: 2 },
      { kind: "image" },
      { container: "mov" },
      { codec: "hevc" },
      { width: 1280.5 },
      { durationMs: "5000" },
      { maxBytes: Number.POSITIVE_INFINITY },
    ])
      await expect(
        host.reviewAndInvokeOnce?.(
          {
            ...credentialRequest,
            expectedMedia: { ...media, ...change } as typeof media,
          },
          { callId, onCreateResponse: () => {} },
        ),
      ).rejects.toThrow("Invalid reviewed invocation");
    expect(invoke).not.toHaveBeenCalled();
  } finally {
    await fiber.dispose();
  }
});

it("reports expected media support only as the exact version", async () => {
  const { host, fiber } = await oncePlugin();
  const http = nativeSupport.credentialHttp;
  try {
    const supported = {
      ...nativeSupport,
      credentialHttp: { ...http, expectedMedia: 1 },
    };
    vi.mocked(invoke).mockResolvedValueOnce(supported);
    expect(await host.reviewedInvocationSupport?.()).toEqual({
      ...supported,
      reviewStart: 1,
    });
    for (const expectedMedia of [2, true, "1", null]) {
      vi.mocked(invoke).mockResolvedValueOnce({
        ...nativeSupport,
        credentialHttp: { ...http, expectedMedia },
      });
      expect(await host.reviewedInvocationSupport?.()).toEqual(unsupported);
    }
  } finally {
    await fiber.dispose();
  }
});

// MOCKED IPC: this is the literal the registered native capabilities command
// returns (asserted natively in host_secrets/tests/reviewed_http.rs).
const nativeResultSupport = {
  version: 1,
  synthetic: true,
  credentialHttp: {
    version: 1,
    createResponse: true,
    continuation: true,
    expectedMedia: 1,
    result: true,
    delivery: true,
    resultUrl: 1,
  },
};

it("qualifies the native result URL capability strictly", async () => {
  const { host, fiber } = await oncePlugin();
  const http = nativeResultSupport.credentialHttp;
  try {
    vi.mocked(invoke).mockResolvedValueOnce(nativeResultSupport);
    expect(await host.reviewedInvocationSupport?.()).toEqual({
      ...nativeResultSupport,
      reviewStart: 1,
    });
    for (const resultUrl of [2, true, "1", null])
      for (const reply of [
        { ...nativeResultSupport, credentialHttp: { ...http, resultUrl } },
        {
          ...nativeResultSupport,
          credentialHttp: { ...http, resultUrl: 1, extra: resultUrl },
        },
      ]) {
        vi.mocked(invoke).mockResolvedValueOnce(reply);
        expect(await host.reviewedInvocationSupport?.()).toEqual(unsupported);
      }
  } finally {
    await fiber.dispose();
  }
});

it("reads the native-selected result by the latest sequence, never a URL", async () => {
  const call = await credentialCall();
  const select = {
    maxBytes: 3,
    parent: { version: 1 as const, callId },
    result: { version: 1 as const, sequence: 2 },
  };
  const read = { url: parentUrl, parent: { version: 1 as const, callId } };
  try {
    call.approve(credentialRequest, { resultUrl: 1 });
    expect(call.reviewed.snapshot()?.projection?.resultUrl).toBe(1);
    call.native.progress(createResponse);
    vi.mocked(invoke).mockImplementationOnce(async () => parentReply());
    await call.host.request(read);
    for (const refused of [
      { ...select, url: resultInput.url },
      { ...select, parent: undefined },
      { ...select, result: { version: 2 as unknown as 1, sequence: 2 } },
      { ...select, result: { version: 1 as const, sequence: 1 } },
      { ...select, result: { version: 1 as const, sequence: 3 } },
      { ...select, result: { ...select.result, url: resultInput.url } },
      {
        ...select,
        parent: { version: 1 as const, callId: crypto.randomUUID() },
      },
    ])
      await expect(
        call.host.requestBytes?.(refused as typeof select),
      ).rejects.toThrow("unavailable");
    expect(resultReads()).toHaveLength(0);

    vi.mocked(invoke).mockImplementationOnce(async () =>
      resultFrame({ parent: { ...parentReply().parent, sequence: 3 } }),
    );
    const input = structuredClone(select);
    const pending = call.host.requestBytes?.(input);
    input.result.sequence = 9;
    const response = await pending;
    expect(resultReads()[0]?.[1]).toEqual({
      id: "example.plugin",
      revision: "abc",
      request: { result: { version: 1, sequence: 2 }, maxBytes: 3 },
      parent: { version: 1, callId },
    });
    expect(response?.source).toEqual({ sha256: "b".repeat(64), size: 3 });
    // The download advanced the sequence; its own read selects nothing.
    await expect(call.host.requestBytes?.(select)).rejects.toThrow(
      "unavailable",
    );
    expect(retires()).toHaveLength(0);
  } finally {
    await call.finish();
  }
});

it("retires a projection with an unknown result URL grant", async () => {
  const call = await credentialCall();
  try {
    call.approve(credentialRequest, { resultUrl: 2 });
    expect(call.reviewed.snapshot()?.projection).toBeUndefined();
    expect(retires()).toHaveLength(1);
  } finally {
    await call.finish();
  }
});

it("prepares only the call's own retained source, privately, and stays pending", async () => {
  const call = await mediaCall(readAndSelect);
  try {
    call.approve(mediaRequest);
    call.native.progress(createResponse);
    await vi.waitFor(() => expect(selections()).toHaveLength(1));
    expect(selections()[0]?.[1]).toEqual({
      id: "example.plugin",
      revision: "abc",
      parent: { version: 1, callId },
      step: { phase: "prepare", source: { sha256: "b".repeat(64), size: 3 } },
    });
    expect(await pending(call.result)).toBe("pending");
    expect(call.reviewed.snapshot()?.status).toBe("dispatching");
    expect(retires()).toHaveLength(0);
    // A plugin's own review keeps its prepared media native: nothing uploads.
    expect(selections()).toHaveLength(1);
    // The callback ran once; nothing re-selects or completes the call.
    call.native.progress(createResponse);
    expect(call.onCreateResponse).toHaveBeenCalledOnce();
  } finally {
    await call.finish();
  }
});

/** An agent's media review, in a community at its HTTPS origin and thread. */
const delivered = {
  ...mediaRequest.destination,
  community: "https://fixture.test",
  root: "a".repeat(64),
};
const preparedSha = "d".repeat(64);
const uploadReceipt = {
  url: `https://fixture.test/media/${preparedSha}.mp4`,
  type: "video/mp4",
  size: 5,
  sha256: preparedSha,
  dim: "1280x720",
};
const steps = (upload: object = uploadReceipt, destination = delivered) =>
  ({
    prepare: {
      ...prepared,
      destination,
      prepared: { sha256: preparedSha, size: 5 },
    },
    upload: { ...prepared, destination, phase: "uploaded", upload },
    publish: { ...prepared, destination, phase: "publishing" },
  }) as Record<string, unknown>;
/** An agent's media call through creation, under `ack`'s native steps. */
async function agentMediaCall(
  ack: (step: { phase: string }) => unknown = (step) => steps()[step.phase],
  destination: ReviewedInvocationDestination = delivered,
) {
  const { state, origin } = agentOrigin(destination);
  const media = { ...mediaRequest, destination };
  const call = await mediaCall(readAndSelect, ack, media, origin);
  call.approve(media);
  call.native.progress({ ...createResponse, destination });
  return { ...call, state };
}
/** A task subthread's media: task `root` under the physical `sourceRoot`. */
const routed = { ...delivered, sourceRoot: "f".repeat(64) };
const phases = () =>
  selections().map(([, args]) => (args as { step: { phase: string } }).step);

it("uploads an agent's prepared media once and admits one attachment-only message", async () => {
  const call = await agentMediaCall();
  const receipt = {
    callId,
    destination: delivered,
    digest,
    outcome: "unknown" as const,
    delivery: {
      upload: "uploaded" as const,
      status: "posted" as const,
      eventId: "e".repeat(64),
    },
  };
  try {
    await vi.waitFor(() => expect(selections()).toHaveLength(3));
    const url = uploadReceipt.url;
    expect(phases()).toEqual([
      { phase: "prepare", source: { sha256: "b".repeat(64), size: 3 } },
      { phase: "upload" },
      {
        phase: "publish",
        event: {
          kind: 9,
          content: `![video.mp4](<${url}>)`,
          tags: [
            ["h", "origin-a"],
            ["e", delivered.root, "", "reply"],
            [
              "imeta",
              `url ${url}`,
              "m video/mp4",
              "size 5",
              `x ${preparedSha}`,
              "filename video.mp4",
              "dim 1280x720",
            ],
          ],
        },
      },
    ]);
    expect(retires()).toHaveLength(0);
  } finally {
    await call.finish(receipt);
  }
  const result = (await call.result) as ReviewedInvocationReceipt;
  expect(result.delivery).toEqual(receipt.delivery);
  expect(Object.isFrozen(result.delivery)).toBe(true);
});

it("publishes a task's media in its source thread, replying to the task", async () => {
  const call = await agentMediaCall(
    (step) => steps(uploadReceipt, routed)[step.phase],
    routed,
  );
  try {
    await vi.waitFor(() => expect(selections()).toHaveLength(3));
    const [, , publish] = phases() as { event?: { tags: string[][] } }[];
    expect(publish?.event?.tags.slice(0, 3)).toEqual([
      ["h", "origin-a"],
      ["e", routed.sourceRoot, "", "root"],
      ["e", routed.root, "", "reply"],
    ]);
    expect(retires()).toHaveLength(0);
  } finally {
    await call.finish({
      callId,
      destination: routed,
      digest,
      outcome: "unknown",
    });
  }
});

it.each([
  ["without its source thread", { ...routed, sourceRoot: undefined }],
  ["in another source thread", { ...routed, sourceRoot: "c".repeat(64) }],
])("refuses a task's terminal receipt %s", async (_name, destination) => {
  const { sourceRoot, ...rest } = destination;
  const call = await agentMediaCall(() => undefined, routed);
  await call.finish({
    callId,
    destination: sourceRoot === undefined ? rest : destination,
    digest,
    outcome: "unknown",
  });
  expect(String(await call.result)).toContain(
    "Invalid reviewed invocation receipt",
  );
});

it("retires a task's media on an acknowledgement without its source thread", async () => {
  const call = await agentMediaCall(
    (step) =>
      step.phase === "upload"
        ? steps()[step.phase]
        : steps(uploadReceipt, routed)[step.phase],
    routed,
  );
  try {
    await vi.waitFor(() => expect(retires()).toHaveLength(1));
    expect(phases().map(({ phase }) => phase)).toEqual(["prepare", "upload"]);
  } finally {
    await call.finish();
  }
});

it.each([
  // A consistent receipt for other bytes than were prepared.
  [
    "hash",
    {
      sha256: "c".repeat(64),
      url: `https://fixture.test/media/${"c".repeat(64)}.mp4`,
    },
  ],
  ["size", { size: 4 }],
  ["origin", { url: `https://other.test/media/${preparedSha}.mp4` }],
  ["type", { type: "video/webm" }],
])(
  "posts nothing for an upload receipt with the wrong %s",
  async (_name, change) => {
    const call = await agentMediaCall(
      (step) => steps({ ...uploadReceipt, ...change })[step.phase],
    );
    try {
      await vi.waitFor(() => expect(retires()).toHaveLength(1));
      expect(phases().map((step) => step.phase)).toEqual(["prepare", "upload"]);
    } finally {
      await call.finish();
    }
  },
);

it("asks for no message once the agent's handle is gone", async () => {
  let call: Awaited<ReturnType<typeof agentMediaCall>> | undefined;
  call = await agentMediaCall((step) => {
    // The handle goes while the upload is in flight.
    if (step.phase === "upload" && call) call.state.live = false;
    return steps()[step.phase];
  });
  try {
    await vi.waitFor(() => expect(retires()).toHaveLength(1));
    expect(phases().map((step) => step.phase)).toEqual(["prepare", "upload"]);
  } finally {
    await call.finish();
  }
});

it.each([
  ["upload", { upload: "maybe", status: "failed" }],
  ["status", { upload: "uploaded", status: "sent" }],
  ["event ID", { upload: "uploaded", status: "posted", eventId: "x" }],
])(
  "refuses a terminal delivery with an invalid %s",
  async (_name, delivery) => {
    const call = await agentMediaCall(() => undefined);
    await call.finish({
      callId,
      destination: delivered,
      digest,
      outcome: "unknown",
      delivery,
    } as unknown as ReviewedInvocationReceipt);
    expect(String(await call.result)).toContain(
      "Invalid reviewed invocation receipt",
    );
  },
);

it.each([
  ["hash", () => ({ source: { sha256: "c".repeat(64), size: 3 } })],
  ["size", () => ({ source: { sha256: "b".repeat(64), size: 2 } })],
  [
    "extra selection key",
    () => ({ source: { sha256: "b".repeat(64), size: 3 }, path: "/tmp/x" }),
  ],
  [
    "extra source key",
    () => ({ source: { sha256: "b".repeat(64), size: 3, url: "x" } }),
  ],
  ["null", () => null],
  ["string", () => "source"],
])("retires on a selection with the wrong %s", async (_name, selection) => {
  const call = await mediaCall(async (host) => {
    await host.requestBytes?.(resultInput);
    return selection();
  });
  try {
    call.approve(mediaRequest);
    call.native.progress(createResponse);
    await vi.waitFor(() => expect(retires()).toHaveLength(1));
    expect(selections()).toHaveLength(0);
  } finally {
    await call.finish();
  }
});

it.each([
  [
    "no retained source",
    () => ({ source: { sha256: "b".repeat(64), size: 3 } }),
  ],
  [
    "a throw",
    () => {
      throw new Error("plugin");
    },
  ],
  ["a rejection", () => Promise.reject(new Error("plugin"))],
])("retires an expected-media call on %s", async (_name, select) => {
  const call = await mediaCall(select);
  try {
    call.approve(mediaRequest);
    call.native.progress(createResponse);
    await vi.waitFor(() => expect(retires()).toHaveLength(1));
    expect(selections()).toHaveLength(0);
  } finally {
    await call.finish();
  }
});

it("selects nothing on a void callback and keeps legacy callbacks unchanged", async () => {
  for (const [input, select] of [
    [mediaRequest, () => undefined],
    [mediaRequest, async () => undefined],
    [credentialRequest, readAndSelect],
    [
      credentialRequest,
      () => {
        throw new Error("plugin");
      },
    ],
  ] as const) {
    vi.mocked(invoke).mockClear();
    const call = await mediaCall(select, undefined, input);
    try {
      call.approve(input);
      call.native.progress(createResponse);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(call.onCreateResponse).toHaveBeenCalledOnce();
      expect(selections()).toHaveLength(0);
      expect(retires()).toHaveLength(0);
      expect(await pending(call.result)).toBe("pending");
    } finally {
      await call.finish();
    }
  }
});

it.each([
  ["phase", () => ({ ...prepared, phase: "result" })],
  ["call", () => ({ ...prepared, callId: crypto.randomUUID() })],
  ["digest", () => ({ ...prepared, digest: "ef".repeat(32) })],
  [
    "destination",
    () => ({
      ...prepared,
      destination: { ...prepared.destination, channel: "other" },
    }),
  ],
  ["missing", () => undefined],
  [
    "native refusal",
    () => {
      throw new Error("Refused");
    },
  ],
])(
  "retires on a prepared acknowledgement with the wrong %s",
  async (_name, ack) => {
    const call = await mediaCall(readAndSelect, ack);
    try {
      call.approve(mediaRequest);
      call.native.progress(createResponse);
      await vi.waitFor(() => expect(retires()).toHaveLength(1));
      expect(selections()).toHaveLength(1);
    } finally {
      await call.finish();
    }
  },
);

it("suppresses a selection or acknowledgement after retirement", async () => {
  const held = reviewGate<unknown>();
  const late = reviewGate<unknown>();
  const call = await mediaCall(
    async (host) => {
      await readAndSelect(host);
      return held.promise;
    },
    () => late.promise,
  );
  try {
    call.approve(mediaRequest);
    call.native.progress(createResponse);
    await vi.waitFor(() => expect(call.onCreateResponse).toHaveBeenCalled());
    await call.reviewed.retire(callId).catch(() => {});
    held.resolve({ source: { sha256: "b".repeat(64), size: 3 } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(selections()).toHaveLength(0);
    expect(retires()).toHaveLength(1);
  } finally {
    await call.finish();
  }
  // A held native acknowledgement after retirement is ignored too.
  const second = await mediaCall(readAndSelect, () => late.promise);
  vi.mocked(invoke).mockClear();
  try {
    second.approve(mediaRequest);
    second.native.progress(createResponse);
    await vi.waitFor(() => expect(selections()).toHaveLength(1));
    await second.reviewed.retire(callId).catch(() => {});
    late.resolve({ ...prepared, phase: "wrong" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(retires()).toHaveLength(1);
  } finally {
    await second.finish();
  }
});
