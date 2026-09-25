import { expect, it, vi } from "vitest";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { nativeAgentControlHost } from "./control-native";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: vi.fn() }));
it("browser constructs no native capability", () => {
  vi.mocked(isTauri).mockReturnValue(false);
  expect(nativeAgentControlHost()).toBeNull();
});
it("all command names and camelCase payloads match the native contract", async () => {
  vi.mocked(isTauri).mockReturnValue(true);
  const host = nativeAgentControlHost();
  if (!host) throw new Error("Missing fixture host");
  await host.snapshot();
  const edit = {
    name: "Agent",
    systemPrompt: "Prompt",
    workspace: "/fixture",
    harness: { command: "acp", args: [""], model: "", provider: "" },
    environment: { KEY: null },
  };
  await host.save("exact-id", 3, edit);
  await host.action("exact-id", "stop");
  await host.setStartOnAppLaunch?.("exact-id", false);
  await host.previewImport("development", "wss://chosen.example");
  await host.commitImport("exact-preview", ["exact-id"]);
  expect(vi.mocked(invoke).mock.calls).toEqual([
    ["agent_control_snapshot"],
    ["agent_control_save", { id: "exact-id", expectedRevision: 3, edit }],
    ["agent_control_action", { id: "exact-id", action: "stop" }],
    ["agent_control_start_on_app_launch", { id: "exact-id", enabled: false }],
    [
      "agent_control_import_preview",
      { source: "development", destination: "wss://chosen.example" },
    ],
    [
      "agent_control_import_commit",
      { token: "exact-preview", ids: ["exact-id"] },
    ],
  ]);
});
it("model operations use explicit ticket commands and no construction-time invocation", async () => {
  vi.mocked(invoke).mockClear();
  vi.mocked(isTauri).mockReturnValue(true);
  const models = nativeAgentControlHost()?.models;
  expect(invoke).not.toHaveBeenCalled();
  const request = {
    id: "sample",
    expectedRevision: 1,
    edit: {
      name: "Sample",
      systemPrompt: "",
      workspace: "/tmp",
      harness: {
        command: "buzz-agent",
        args: [],
        model: "",
        provider: "databricks_v2",
      },
      environment: {},
    },
    host: "https://example.com",
    filter: "",
    action: "refresh" as const,
  };
  await models?.begin();
  await models?.run(12, request);
  await models?.cancel(12);
  expect(vi.mocked(invoke).mock.calls).toEqual([
    ["agent_models_begin"],
    ["agent_models_run", { ticket: 12, request }],
    ["agent_models_cancel", { ticket: 12 }],
  ]);
});

it("mention replay floor is transient IPC input on the existing Start command", async () => {
  vi.mocked(invoke).mockClear();
  vi.mocked(isTauri).mockReturnValue(true);
  await nativeAgentControlHost()?.action("exact-id", "start", 1234567890);
  expect(invoke).toHaveBeenCalledExactlyOnceWith("agent_control_action", {
    id: "exact-id",
    action: "start",
    replayFloor: 1234567890,
  });
});
