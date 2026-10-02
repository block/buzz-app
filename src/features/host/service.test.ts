import { Context } from "@deepseek-ai/cordis";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HostService } from "./service";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: vi.fn(),
  invoke: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(invoke).mockReset();
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

const identity = "ab".repeat(32);
const agentPubkey = "cd".repeat(32);
const authorization = ["auth", identity, "", "ef".repeat(64)];

it("prepares a structured NIP-OA proof with the native identity without a community", async () => {
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

it.each(["browser", "live desktop"])(
  "uses the dev broker identity for %s authorization without a selected relay",
  async (mode) => {
    vi.mocked(isTauri).mockReturnValue(mode !== "browser");
    vi.stubEnv("VITE_BUZZ_LIVE", "1");
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

it.each([
  ["auth", agentPubkey, "", authorization[3]],
  ["auth", identity, "kind=0", authorization[3]],
  ["auth", identity, "", "invalid"],
])(
  "rejects a malformed or different-owner authorization: %j",
  async (...tag) => {
    const { plugin } = pluginContext();
    vi.mocked(invoke)
      .mockResolvedValueOnce(identity)
      .mockResolvedValueOnce(tag);
    await expect(
      plugin.host.prepareRemoteAgentAuthorization?.(agentPubkey),
    ).rejects.toThrow("Invalid remote agent authorization");
  },
);

it("reports a native owner mismatch as an Error", async () => {
  const { plugin } = pluginContext();
  vi.mocked(invoke)
    .mockResolvedValueOnce(identity)
    .mockRejectedValueOnce("The agent owner is not your signed-in identity");
  await expect(
    plugin.host.prepareRemoteAgentAuthorization?.(agentPubkey),
  ).rejects.toThrow("signed-in identity");
});

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
