import { expect, it } from "vitest";
import { callSessionTool, sessionTools } from "../../buzz-mcp/session-tools";
import {
  buzzToolAllowed,
  isCodexBuzzTool,
  classifiedBuzzTool,
  hookedToolName,
  missingToolPolicyDenial,
  nativeCapability,
  nativeToolAllowed,
  nativeToolDenial,
  pickToolConfig,
  roleTools,
  toolPolicy,
  toolPolicyKey,
} from "./tool-access";

const SUPER = { toolPreset: "super-agent" };
const REVIEWER = { toolPreset: "reviewer" };
const CODER = { toolPreset: "coder" };
const TASKS = [{ name: "tasks_update", effect: "coordinate" as const }];
const UNDECLARED = [{ name: "apps_deploy" }];

it("keeps full access for old configs and maps earlier draft presets", () => {
  expect(toolPolicy(undefined)).toEqual({ preset: "coder", allow: [] });
  expect(toolPolicy({ toolPreset: "unknown" }).preset).toBe("coder");
  expect(toolPolicy({ toolPreset: "full" }).preset).toBe("coder");
  expect(toolPolicy({ toolPreset: "coordinator" }).preset).toBe("super-agent");
  expect(toolPolicy({ toolPreset: "chat" }).preset).toBe("reviewer");
  expect(
    toolPolicy({ toolPreset: "reviewer", toolAllow: "native:shell" }),
  ).toEqual({ preset: "reviewer", allow: [] });
  expect(
    toolPolicy({ toolPreset: "custom", toolAllow: "send, native:read, send" }),
  ).toEqual({ preset: "custom", allow: ["send", "native:read"] });
  expect(toolPolicyKey({})).toBe("");
  expect(toolPolicyKey(REVIEWER)).not.toBe("");
  expect(
    pickToolConfig({ toolPreset: "custom", toolAllow: 4, toolDeny: "x" }),
  ).toEqual({ toolPreset: "custom" });
});

it.each([
  ["Read", true, true, true],
  ["WebFetch", true, true, true],
  ["Task", true, false, true],
  ["ToolSearch", true, true, true],
  ["Skill", true, true, true],
  ["Edit", false, false, true],
  ["apply_patch", false, false, true],
  ["Bash", false, false, true],
  ["shell_command", false, false, true],
  ["developer__shell", false, false, true],
  ["unreviewed_native_tool", false, false, true],
  ["mcp__github__create_pull_request", false, false, true],
  ["mcp__buzz__send", true, true, true],
] as const)(
  "native %s: Super-agent %s, Reviewer %s, Coder %s",
  (name, superAgent, reviewer, coder) => {
    expect(
      [SUPER, REVIEWER, CODER].map((config) => nativeToolAllowed(name, config)),
    ).toEqual([superAgent, reviewer, coder]);
  },
);

it.each([
  ["read", true, true, true],
  ["send", true, true, true],
  ["mem_set", true, false, true],
  ["watch_add", true, false, true],
  ["solo_worker_create", true, false, true],
  ["tasks_update", true, false, true],
  ["repo", true, false, true],
  ["canvas_set", true, false, true],
  ["channel_delete", true, false, true],
  ["apps_deploy", false, false, true],
  ["a_future_buzz_tool", true, false, true],
] as const)(
  "Buzz %s: Super-agent %s, Reviewer %s, Coder %s",
  (name, superAgent, reviewer, coder) => {
    const added = [...TASKS, ...UNDECLARED];
    expect(
      [SUPER, REVIEWER, CODER].map((config) =>
        buzzToolAllowed(name, config, added),
      ),
    ).toEqual([superAgent, reviewer, coder]);
  },
);

it("allows exactly a Custom selection, including one connected server or plugin tool", () => {
  const custom = {
    toolPreset: "custom",
    toolAllow: "native:read,buzz:message,connected:github,plugin:apps_deploy",
  };
  expect(nativeToolAllowed("Read", custom)).toBe(true);
  expect(nativeToolAllowed("Edit", custom)).toBe(false);
  expect(nativeToolAllowed("mcp__github__create_issue", custom)).toBe(true);
  expect(nativeToolAllowed("mcp__linear__save_issue", custom)).toBe(false);
  expect(buzzToolAllowed("send", custom)).toBe(true);
  expect(buzzToolAllowed("read", custom)).toBe(false);
  expect(buzzToolAllowed("apps_deploy", custom, UNDECLARED)).toBe(true);
  expect(buzzToolAllowed("tasks_update", custom, TASKS)).toBe(false);
  expect(
    nativeToolAllowed("mcp__linear__save_issue", {
      toolPreset: "custom",
      toolAllow: "connected",
    }),
  ).toBe(true);
});

it("allows one connected tool while another on the same server stays off", () => {
  const custom = {
    toolPreset: "custom",
    toolAllow: "connected:github/get_pull_request",
  };
  expect(nativeToolAllowed("mcp__github__get_pull_request", custom)).toBe(true);
  expect(nativeToolAllowed("mcp__github__merge_pull_request", custom)).toBe(
    false,
  );
  expect(nativeToolAllowed("mcp__linear__get_issue", custom)).toBe(false);
});

it("allows one named native tool without the catch-all, and Skill in every role", () => {
  const named = {
    toolPreset: "custom",
    toolAllow: "native-tool:askuserquestion",
  };
  expect(nativeToolAllowed("AskUserQuestion", named)).toBe(true);
  expect(nativeToolAllowed("NotebookRead", named)).toBe(false);
  const none = { toolPreset: "custom", toolAllow: "" };
  expect(nativeToolAllowed("AskUserQuestion", none)).toBe(false);
  expect(nativeToolAllowed("Skill", none)).toBe(true);
  for (const config of [REVIEWER, SUPER, none])
    expect(nativeToolAllowed("mcp__linear__Skill", config)).toBe(false);
  expect(nativeToolAllowed("developer__skill", none)).toBe(false);
  expect(
    nativeToolAllowed("mcp__linear__Skill", {
      toolPreset: "custom",
      toolAllow: "connected:linear/Skill",
    }),
  ).toBe(true);
  expect(nativeToolAllowed("Bash", none)).toBe(false);
  expect(
    nativeToolAllowed("NotebookRead", {
      toolPreset: "custom",
      toolAllow: "native:other",
    }),
  ).toBe(true);
});

it("gives Orchestrator Buzz's own deliverables but leaves plugin ones opt-in, when listed and called", async () => {
  const listed = sessionTools(UNDECLARED as never, SUPER).map(
    (tool) => tool.name,
  );
  expect(listed).toContain("canvas_set");
  expect(listed).not.toContain("apps_deploy");
  await expect(
    callSessionTool(
      {} as never,
      {} as never,
      "apps_deploy",
      {},
      UNDECLARED as never,
      SUPER,
    ),
  ).rejects.toThrow("disabled by this agent's Tools setting");
});

it("keeps a saved legacy deliverable grant's access", () => {
  const legacy = { toolPreset: "custom", toolAllow: "buzz:deliverable" };
  expect(buzzToolAllowed("canvas_set", legacy)).toBe(true);
  expect(buzzToolAllowed("apps_deploy", legacy, UNDECLARED)).toBe(true);
});

it("lists the built-in tools each role's gates allow", () => {
  const orchestrator = roleTools("super-agent");
  expect(orchestrator.buzz).toContain("canvas_set");
  expect(orchestrator.native).toContain("Task");
  expect(orchestrator.native).not.toContain("Bash");
  const reviewer = roleTools("reviewer");
  expect(reviewer.native).toEqual(expect.arrayContaining(["Read", "Skill"]));
  expect(reviewer.native).not.toContain("Task");
  expect(reviewer.buzz).not.toContain("mem_set");
  expect(roleTools("coder").native).toContain("Bash");
});

it("lets Read / Write edit, run commands and chat, but not use connected, plugin or admin Buzz tools", () => {
  const builder = { toolPreset: "builder" };
  for (const name of ["Read", "Edit", "Bash", "apply_patch", "Task", "Skill"])
    expect(nativeToolAllowed(name, builder)).toBe(true);
  expect(nativeToolAllowed("mcp__github__create_issue", builder)).toBe(false);
  expect(buzzToolAllowed("send", builder)).toBe(true);
  for (const name of [
    "canvas_set",
    "settings_set",
    "plugin_disable",
    "mem_set",
  ])
    expect(buzzToolAllowed(name, builder)).toBe(false);
  expect(buzzToolAllowed("tasks_update", builder, TASKS)).toBe(false);
  expect(buzzToolAllowed("apps_deploy", builder, UNDECLARED)).toBe(false);
});

it("classifies every built-in Buzz tool explicitly", () => {
  expect(
    sessionTools()
      .map((tool) => tool.name)
      .filter((name) => !classifiedBuzzTool(name)),
  ).toEqual([]);
});

it("lists only the Buzz tools a role allows", () => {
  const names = sessionTools(UNDECLARED as never, REVIEWER).map(
    (tool) => tool.name,
  );
  expect(names).toContain("send");
  expect(names).not.toContain("repo");
  expect(names).not.toContain("mem_set");
  expect(names).not.toContain("apps_deploy");
});

it("returns native denials only for tool events and in each harness shape", () => {
  expect(
    nativeToolDenial("claude", "UserPromptSubmit", "", REVIEWER),
  ).toBeUndefined();
  expect(
    nativeToolDenial("claude", "PreToolUse", "Edit", REVIEWER),
  ).toMatchObject({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: expect.stringContaining("disabled"),
    },
  });
  expect(nativeToolDenial("pi", "beforeTool", "bash", REVIEWER)).toEqual({
    block: expect.stringContaining("disabled"),
  });
  expect(hookedToolName({ tool_name: "Bash" })).toBe("Bash");
  expect(hookedToolName({ call: { name: "bash" } })).toBe("bash");
  expect(hookedToolName({ name: "read" })).toBe("read");
});

it("fails closed when a running agent's live policy is unavailable", () => {
  expect(missingToolPolicyDenial("pi", "policy", "bash")).toEqual({
    block:
      "bash is disabled because this agent's live Tools setting is unavailable.",
  });
  expect(missingToolPolicyDenial("pi", "SessionStart", "")).toBeUndefined();
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

it("leaves Codex's Buzz dynamic tools to the Buzz MCP server's own gate", () => {
  const buzz = sessionTools().map((tool) => tool.name);
  expect(isCodexBuzzTool("buzzsend", buzz)).toBe(true);
  expect(isCodexBuzzTool("buzzmem_set", buzz)).toBe(true);
  expect(isCodexBuzzTool("buzzdelete_everything", buzz)).toBe(false);
  expect(isCodexBuzzTool("exec_command", buzz)).toBe(false);
});
