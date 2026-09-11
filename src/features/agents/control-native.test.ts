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
  await host.previewImport("development");
  await host.commitImport("exact-preview", ["exact-id"]);
  expect(vi.mocked(invoke).mock.calls).toEqual([
    ["agent_control_snapshot"],
    ["agent_control_save", { id: "exact-id", expectedRevision: 3, edit }],
    ["agent_control_action", { id: "exact-id", action: "stop" }],
    ["agent_control_import_preview", { source: "development" }],
    [
      "agent_control_import_commit",
      { token: "exact-preview", ids: ["exact-id"] },
    ],
  ]);
});
