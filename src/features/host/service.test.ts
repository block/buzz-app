import { Context } from "@deepseek-ai/cordis";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { beforeEach, expect, it, vi } from "vitest";
import { HostService } from "./service";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: vi.fn(),
  invoke: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(invoke).mockReset();
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
