import { expect, it } from "vitest";
import {
  buzzToolAllowed,
  goosePlatform,
  hookedToolName,
  missingToolPolicyDenial,
  nativeCapability,
  nativeToolAllowed,
  nativeToolDenial,
  pickToolConfig,
  toolPolicy,
  toolPolicyKey,
  toolPolicyProblem,
} from "./tool-access";

it("preserves full access for old configs and normalizes override lists", () => {
  expect(toolPolicy(undefined)).toEqual({
    preset: "full",
    allow: [],
    deny: [],
  });
  expect(toolPolicy({ toolPreset: "unknown" }).preset).toBe("full");
  expect(
    toolPolicy({
      toolPreset: "research",
      toolAllow: "mem_set, send, mem_set",
      toolDeny: "search, search",
    }),
  ).toEqual({
    preset: "research",
    allow: ["mem_set", "send"],
    deny: ["search"],
  });
  expect(toolPolicyKey({})).toBe("");
  expect(toolPolicyKey({ toolPreset: "chat" })).not.toBe("");
  expect(
    pickToolConfig({ toolPreset: "chat", toolAllow: 4, other: "keep" }),
  ).toEqual({
    toolPreset: "chat",
  });
});

it("applies role baselines and explicit Buzz overrides", () => {
  expect(buzzToolAllowed("send", { toolPreset: "chat" })).toBe(true);
  expect(buzzToolAllowed("mem_set", { toolPreset: "chat" })).toBe(false);
  expect(buzzToolAllowed("mem_get", { toolPreset: "research" })).toBe(true);
  expect(buzzToolAllowed("mem_set", { toolPreset: "research" })).toBe(false);
  expect(buzzToolAllowed("watch_add", { toolPreset: "coordinator" })).toBe(
    true,
  );
  expect(
    buzzToolAllowed("mem_set", { toolPreset: "chat", toolAllow: "mem_set" }),
  ).toBe(true);
  expect(buzzToolAllowed("send", { toolDeny: "send" })).toBe(false);
});

it("fails conflicting overrides closed and reports them to the editor", () => {
  const policy = toolPolicy({
    toolPreset: "full",
    toolAllow: "send,native:shell",
    toolDeny: "send,native:shell",
  });
  expect(toolPolicyProblem(policy)).toMatch(/conflicting/);
  expect(buzzToolAllowed("send", policy)).toBe(false);
  expect(nativeToolAllowed("Bash", policy)).toBe(false);
});

it.each([
  ["full", true],
  ["coding", true],
  ["coordinator", false],
  ["research", false],
  ["chat", false],
] as const)(
  "maps Shell consistently across native names for %s",
  (preset, expected) => {
    for (const name of [
      "Bash",
      "shell_command",
      "unified_exec",
      "bash",
      "developer__shell",
    ])
      expect(nativeToolAllowed(name, { toolPreset: preset })).toBe(expected);
  },
);

it("allows only safe native capabilities for restricted roles", () => {
  expect(nativeToolAllowed("Read", { toolPreset: "research" })).toBe(true);
  expect(nativeToolAllowed("Write", { toolPreset: "research" })).toBe(false);
  expect(nativeToolAllowed("WebSearch", { toolPreset: "research" })).toBe(true);
  expect(nativeToolAllowed("Task", { toolPreset: "coordinator" })).toBe(true);
  expect(nativeToolAllowed("Read", { toolPreset: "coordinator" })).toBe(false);
  expect(nativeToolAllowed("ToolSearch", { toolPreset: "chat" })).toBe(true);
  expect(nativeToolAllowed("unreviewed_mcp_tool", { toolPreset: "chat" })).toBe(
    false,
  );
  expect(
    nativeToolAllowed("unreviewed_mcp_tool", { toolPreset: "coding" }),
  ).toBe(true);
  expect(
    nativeToolAllowed("Write", {
      toolPreset: "chat",
      toolAllow: "native:write",
    }),
  ).toBe(true);
  expect(nativeCapability("native:write")).toBe("native:write");
});

it("never mistakes Buzz MCP tools for unknown native tools", () => {
  expect(nativeToolAllowed("mcp__buzz__send", { toolPreset: "chat" })).toBe(
    true,
  );
  expect(nativeToolAllowed("buzz__watch_add", { toolPreset: "chat" })).toBe(
    true,
  );
  expect(nativeToolAllowed("buzz.search", { toolPreset: "chat" })).toBe(true);
  expect(nativeToolAllowed("buzz_send", { toolPreset: "chat" })).toBe(true);
  expect(nativeCapability("mcp__other__read_file")).toBe("native:other");
  expect(
    nativeToolAllowed("mcp__other__read_file", { toolPreset: "research" }),
  ).toBe(false);
  expect(
    nativeToolAllowed("mcp__buzzfeed__write", { toolPreset: "research" }),
  ).toBe(false);
  expect(
    nativeToolAllowed("mcp__other__buzz__write", { toolPreset: "research" }),
  ).toBe(false);
  expect(nativeToolAllowed("mcp__buzz__send", { toolPreset: "chat" })).toBe(
    true,
  );
});

it("returns native denials only for tool events and in each harness shape", () => {
  const config = { toolPreset: "chat" };
  expect(
    nativeToolDenial("claude", "UserPromptSubmit", "", config),
  ).toBeUndefined();
  expect(
    nativeToolDenial("claude", "PreToolUse", "Read", config),
  ).toMatchObject({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: expect.stringContaining("disabled"),
    },
  });
  expect(nativeToolDenial("pi", "beforeTool", "Bash", config)).toEqual({
    block: expect.stringContaining("disabled"),
  });
  expect(nativeToolDenial("codex", "PreToolUse", "Read", config)).toMatchObject(
    {
      hookSpecificOutput: { permissionDecision: "deny" },
    },
  );
  expect(hookedToolName({ tool_name: "Bash" })).toBe("Bash");
  expect(hookedToolName({ call: { name: "bash" } })).toBe("bash");
  expect(hookedToolName({ name: "read" })).toBe("read");
});

it("fails closed when a running agent's live policy is unavailable", () => {
  expect(missingToolPolicyDenial("pi", "policy", "bash")).toEqual({
    block:
      "bash is disabled because this agent's live Tools setting is unavailable.",
  });
  for (const harness of ["claude", "codex"] as const)
    expect(
      missingToolPolicyDenial(harness, "PreToolUse", "Bash"),
    ).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
      },
    });
  expect(missingToolPolicyDenial("pi", "SessionStart", "")).toBeUndefined();
});

it("maps Goose's actual tools and never uses an empty allow-all tool list", () => {
  expect(goosePlatform({ toolPreset: "full" })).toBeUndefined();
  expect(goosePlatform({ toolPreset: "coding" })).toBeUndefined();
  expect(goosePlatform({ toolPreset: "research" })).toEqual({
    type: "platform",
    name: "developer",
    available_tools: ["tree", "read_image"],
  });
  expect(goosePlatform({ toolPreset: "chat" })).toBeNull();
  expect(goosePlatform({ toolPreset: "coordinator" })).toBeNull();
  expect(
    goosePlatform({
      toolPreset: "coordinator",
      toolAllow: "native:write,native:shell",
    }),
  ).toEqual({
    type: "platform",
    name: "developer",
    available_tools: ["shell", "write", "edit"],
  });
});

it("covers Pi 1.5's concrete CodingTools names", () => {
  for (const [name, capability] of [
    ["read", "native:read"],
    ["write", "native:write"],
    ["edit", "native:write"],
    ["bash", "native:shell"],
  ] as const)
    expect(nativeCapability(name)).toBe(capability);
});
