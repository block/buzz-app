// The owner's per-agent tool policy. The same normalized config drives every
// harness's advertised Buzz tools, Buzz dispatch and native tool gates.
export const TOOL_PRESETS = [
  "full",
  "coordinator",
  "coding",
  "research",
  "chat",
] as const;
export type ToolPreset = (typeof TOOL_PRESETS)[number];
export type ToolConfig = Readonly<{
  toolPreset?: string;
  /** Comma-separated Buzz tool names or native capability ids. */
  toolAllow?: string;
  toolDeny?: string;
}>;
export type ToolPolicy = Readonly<{
  preset: ToolPreset;
  allow: readonly string[];
  deny: readonly string[];
}>;

export type NativeCapability =
  | "native:read"
  | "native:write"
  | "native:shell"
  | "native:web"
  | "native:agents"
  | "native:meta"
  | "native:other";

export const NATIVE_TOOLS: readonly Readonly<{
  id: NativeCapability;
  label: string;
  description: string;
}>[] = [
  {
    id: "native:read",
    label: "Files: read",
    description: "Read, list and search local files without changing them.",
  },
  {
    id: "native:write",
    label: "Files: write",
    description: "Create and edit local files.",
  },
  {
    id: "native:shell",
    label: "Shell",
    description: "Run commands and manage command processes.",
  },
  {
    id: "native:web",
    label: "Web",
    description: "Fetch pages and search the public web.",
  },
  {
    id: "native:agents",
    label: "Subagents",
    description:
      "Delegate to and communicate with native subagents, which inherit this policy.",
  },
  {
    id: "native:meta",
    label: "Planning and tool search",
    description:
      "Discover deferred tools and maintain task plans; not access to another service.",
  },
  {
    id: "native:other",
    label: "Other native tools",
    description:
      "Native tools outside the capability groups above. Restricted presets refuse unknown tools.",
  },
];

export function pickToolConfig(raw: unknown): ToolConfig {
  const value =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return Object.fromEntries(
    ["toolPreset", "toolAllow", "toolDeny"]
      .filter((name) => typeof value[name] === "string")
      .map((name) => [name, value[name]]),
  );
}

export function hookedToolName(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = input as Record<string, unknown>;
  const nested =
    value.call && typeof value.call === "object"
      ? (value.call as Record<string, unknown>)
      : undefined;
  const name = value.tool_name ?? value.name ?? nested?.name;
  return typeof name === "string" ? name : undefined;
}

export const PRESET_INFO: readonly Readonly<{
  id: ToolPreset;
  label: string;
  description: string;
}>[] = [
  {
    id: "full",
    label: "Full access",
    description: "All available Buzz and native tools.",
  },
  {
    id: "coordinator",
    label: "Coordinator",
    description:
      "Act in Buzz and delegate, without direct coding, file or shell tools.",
  },
  {
    id: "coding",
    label: "Coding",
    description: "All available Buzz and native tools for implementation work.",
  },
  {
    id: "research",
    label: "Research",
    description:
      "Read-only research tools, web and file reads, plus sending findings.",
  },
  {
    id: "chat",
    label: "Chat only",
    description:
      "Read, search and reply in Buzz; no file, shell, web or delegation tools.",
  },
];

const CHAT = new Set([
  "send",
  "reply_in_subthread",
  "read",
  "search",
  "channel_list",
  "channel_get",
]);
const RESEARCH = new Set([
  ...CHAT,
  "buzz_help",
  "agent_types",
  "agent_read",
  "team_read",
  "solo_workspace_list",
  "member_list",
  "users",
  "mem_get",
  "notes_get",
  "canvas_get",
  "canvas_history",
  "media_get",
  "interest_show",
  "interest_list",
  "watch_show",
  "watch_list",
  "solo_worker_connections",
  "solo_worker_readiness",
  "solo_worker_read",
  "solo_worker_list",
  "plugin_list",
  "plugin_discover",
  "plugin_request_status",
  "settings_list",
  "settings_get",
]);

const list = (value: string | undefined): readonly string[] => [
  ...new Set(
    (value ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
  ),
];
export const joinToolOverrides = (names: readonly string[]) =>
  [...new Set(names.map((name) => name.trim()).filter(Boolean))]
    .sort()
    .join(",");

/** Missing settings preserve the behavior of agents saved before tool access. */
export function toolPolicy(
  config: ToolConfig | ToolPolicy | unknown,
): ToolPolicy {
  const value =
    config && typeof config === "object"
      ? (config as ToolConfig & ToolPolicy)
      : undefined;
  const preset = TOOL_PRESETS.includes(value?.preset as ToolPreset)
    ? (value?.preset as ToolPreset)
    : TOOL_PRESETS.includes(value?.toolPreset as ToolPreset)
      ? (value?.toolPreset as ToolPreset)
      : "full";
  return {
    preset,
    allow: Array.isArray(value?.allow) ? value.allow : list(value?.toolAllow),
    deny: Array.isArray(value?.deny) ? value.deny : list(value?.toolDeny),
  };
}

/** Empty preserves existing saved-session fingerprints for the default policy. */
export function toolPolicyKey(config: ToolConfig | ToolPolicy | unknown) {
  const policy = toolPolicy(config);
  return policy.preset === "full" && !policy.allow.length && !policy.deny.length
    ? ""
    : JSON.stringify(policy);
}

export function toolPolicyProblem(policy: ToolPolicy): string | undefined {
  const allowed = new Set(policy.allow);
  const conflicts = policy.deny.filter((name) => allowed.has(name));
  return conflicts.length
    ? `Remove the conflicting allow and deny overrides for ${conflicts.join(", ")}.`
    : undefined;
}

const overridden = (name: string, policy: ToolPolicy) => {
  // A malformed synced config fails closed where it contradicts itself.
  if (policy.deny.includes(name)) return false;
  if (policy.allow.includes(name)) return true;
  return undefined;
};

export function buzzToolAllowed(
  name: string,
  config: ToolConfig | ToolPolicy | unknown,
) {
  const policy = toolPolicy(config);
  const override = overridden(name, policy);
  if (override !== undefined) return override;
  switch (policy.preset) {
    case "chat":
      return CHAT.has(name);
    case "research":
      return RESEARCH.has(name);
    default:
      return true;
  }
}

/** Maps each harness's native spelling to a capability without treating Buzz's
 * own MCP tools as native tools; their names and arguments are gated centrally. */
export function isBuzzNativeTool(name: string) {
  const normalized = name.toLowerCase();
  return (
    normalized.startsWith("buzz_") ||
    normalized.startsWith("buzz.") ||
    normalized.includes("mcp__buzz") ||
    normalized.includes("__buzz__")
  );
}

const canonical = (name: string) =>
  (name.split("/").at(-1) ?? "")
    .replace(/^mcp__[^_]+__/, "")
    .replace(/^developer__/, "")
    .replace(/[.-]/g, "_")
    .toLowerCase();
const groups: readonly [readonly string[], NativeCapability][] = [
  [
    [
      "read",
      "read_file",
      "readfile",
      "glob",
      "grep",
      "find",
      "ls",
      "list_files",
      "listfiles",
      "search_files",
      "tree",
      "read_image",
      "view_image",
    ],
    "native:read",
  ],
  [
    [
      "write",
      "edit",
      "notebookedit",
      "apply_patch",
      "text_editor",
      "create_file",
      "str_replace_editor",
    ],
    "native:write",
  ],
  [
    [
      "bash",
      "shell",
      "shell_command",
      "unified_exec",
      "execute",
      "run_command",
      "kill_shell",
      "killbash",
      "bashoutput",
    ],
    "native:shell",
  ],
  [
    [
      "webfetch",
      "websearch",
      "web_fetch",
      "web_search",
      "search_query",
      "fetch",
    ],
    "native:web",
  ],
  [
    [
      "task",
      "agent",
      "spawn_agent",
      "send_input",
      "wait",
      "wait_agent",
      "close_agent",
      "task_output",
      "taskoutput",
    ],
    "native:agents",
  ],
  [
    [
      "toolsearch",
      "tool_search",
      "enable_tools",
      "update_plan",
      "exit_plan_mode",
      "todowrite",
      "todoread",
      "thinking",
    ],
    "native:meta",
  ],
];
export function nativeCapability(name: string): NativeCapability {
  if (NATIVE_TOOLS.some((tool) => tool.id === name))
    return name as NativeCapability;
  // Another MCP server's spelling is not evidence of a native capability.
  // Buzz's MCP server is exempted centrally before this classification.
  if (/^mcp__/i.test(name)) return "native:other";
  const normalized = canonical(name);
  return (
    groups.find(([names]) => names.includes(normalized))?.[1] ?? "native:other"
  );
}

export function nativeToolAllowed(
  name: string,
  config: ToolConfig | ToolPolicy | unknown,
) {
  if (isBuzzNativeTool(name)) return true;
  const policy = toolPolicy(config);
  const capability = nativeCapability(name);
  const override = overridden(capability, policy);
  if (override !== undefined) return override;
  switch (policy.preset) {
    case "full":
    case "coding":
      return true;
    case "coordinator":
      return capability === "native:agents" || capability === "native:meta";
    case "research":
      return ["native:read", "native:web", "native:meta"].includes(capability);
    case "chat":
      return capability === "native:meta";
  }
}

/** Native hook output in the selected harness's existing trusted format. */
export function nativeToolDenial(
  harness: "claude" | "codex" | "pi",
  event: string,
  name: string,
  config: ToolConfig | ToolPolicy | unknown,
): Record<string, unknown> | undefined {
  if (!name || nativeToolAllowed(name, config)) return undefined;
  const reason = `${name} is disabled by this agent's Tools setting (${nativeCapability(name)}).`;
  if (harness === "pi") return { block: reason };
  return {
    hookSpecificOutput: {
      hookEventName: event,
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

/** Goose's actual developer tools. Every real name goes through the same
 * capability policy as the other harnesses; no assumed aggregate editor. */
const GOOSE_DEVELOPER_TOOLS = ["shell", "write", "edit", "tree", "read_image"];

/** Undefined preserves Goose's unrestricted launch. Null expressly enables
 * no platform extension: Goose treats an empty `available_tools` list as all
 * tools, so a role allowing none must omit the developer extension instead. */
export function goosePlatform(config: ToolConfig | ToolPolicy | unknown):
  | Readonly<{
      type: "platform";
      name: "developer";
      available_tools: readonly string[];
    }>
  | null
  | undefined {
  const policy = toolPolicy(config);
  const unrestricted = policy.preset === "full" || policy.preset === "coding";
  if (unrestricted) return;
  const available = GOOSE_DEVELOPER_TOOLS.filter((name) =>
    nativeToolAllowed(name, config),
  );
  if (!available.length) return null;
  return {
    type: "platform",
    name: "developer",
    available_tools: available,
  };
}
