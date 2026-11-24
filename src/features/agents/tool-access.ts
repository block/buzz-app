// The owner's per-agent tool policy. One normalized config drives every
// harness's native tool gates and the Buzz MCP server's listing and calls.
export const TOOL_PRESETS = [
  "super-agent",
  "reviewer",
  "coder",
  "custom",
] as const;
export type ToolPreset = (typeof TOOL_PRESETS)[number];
/** Saved by earlier drafts of this setting. */
const LEGACY_PRESETS: Readonly<Record<string, ToolPreset>> = {
  full: "coder",
  coding: "coder",
  coordinator: "super-agent",
  research: "reviewer",
  chat: "reviewer",
};
export type ToolConfig = Readonly<{
  toolPreset?: string;
  /** Comma-separated capability or tool ids a Custom role allows. */
  toolAllow?: string;
}>;
export type ToolPolicy = Readonly<{
  preset: ToolPreset;
  allow: readonly string[];
}>;

export type NativeCapability =
  | "native:read"
  | "native:write"
  | "native:shell"
  | "native:web"
  | "native:agents"
  | "native:meta"
  | "native:other";
export type BuzzCapability =
  | "buzz:read"
  | "buzz:message"
  | "buzz:coordinate"
  | "buzz:deliverable";
/** Every tool from another MCP server the harness connects to; a server's
 * own tools are `connected:<server>`, and one of them `connected:<server>/<tool>`. */
export const CONNECTED = "connected";
export type Capability = NativeCapability | BuzzCapability | typeof CONNECTED;

type Described<Id extends string> = Readonly<{
  id: Id;
  label: string;
  description: string;
}>;

export const NATIVE_TOOLS: readonly Described<NativeCapability>[] = [
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
    description: "Run commands, such as tests, builds and git.",
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
      "Delegate to native subagents, which inherit this agent's access.",
  },
  {
    id: "native:meta",
    label: "Planning and tool search",
    description: "Discover deferred tools and keep task plans.",
  },
  {
    id: "native:other",
    label: "Other native tools",
    description: "Native tools outside the groups above.",
  },
];

export const BUZZ_TOOL_GROUPS: readonly Described<BuzzCapability>[] = [
  {
    id: "buzz:read",
    label: "Buzz: read",
    description: "Read messages, channels, people, notes, canvases and status.",
  },
  {
    id: "buzz:message",
    label: "Buzz: messages",
    description: "Send, edit and react to messages, and open DMs.",
  },
  {
    id: "buzz:coordinate",
    label: "Buzz: coordinate",
    description:
      "Memory, attention, handoffs, solo workers, agent drafts and plugin tools that manage work, such as Tasks.",
  },
  {
    id: "buzz:deliverable",
    label: "Buzz: deliverables",
    description:
      "Repositories, canvases, notes, channels, members, settings and plugin tools that create or change work.",
  },
];

export const CONNECTED_TOOLS: Described<typeof CONNECTED> = {
  id: CONNECTED,
  label: "Connected tools",
  description:
    "Tools from every other MCP server the harness connects to, such as GitHub or Linear.",
};

/** What a plugin tool does, which decides the roles it is available to.
 * A plugin tool that declares none is treated as changing deliverables. */
export type ToolEffect = "read" | "message" | "coordinate" | "deliverable";

const BUZZ_TOOL_EFFECTS: Readonly<Record<ToolEffect, readonly string[]>> = {
  read: [
    "buzz_help",
    "agent_types",
    "agent_read",
    "team_read",
    "read",
    "search",
    "channel_list",
    "channel_get",
    "workspace_list",
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
    "bestie_get",
  ],
  message: [
    "send",
    "reply_in_subthread",
    "edit",
    "delete",
    "react",
    "pin",
    "dm",
  ],
  coordinate: [
    "agent_create",
    "agent_update",
    "team_update",
    "self_handoff",
    "channel_join",
    "channel_leave",
    "mem_set",
    "mem_rm",
    "tabs",
    "interest_set",
    "interest_remove",
    "watch_add",
    "watch_update",
    "watch_enable",
    "watch_disable",
    "watch_remove",
    "watch_rearm",
    "solo_worker_create",
    "solo_worker_send",
    "solo_worker_stop",
    "solo_worker_archive",
    "bestie_set",
    "bestie_clear",
  ],
  deliverable: [
    "channel_create",
    "channel_move",
    "channel_update",
    "channel_archive",
    "channel_unarchive",
    "channel_delete",
    "member_add",
    "member_remove",
    "notes_set",
    "notes_rm",
    "canvas_set",
    "canvas_restore",
    "repo",
    "plugin_disable",
    "plugin_request",
    "settings_set",
  ],
};
const BUZZ_EFFECT = new Map(
  Object.entries(BUZZ_TOOL_EFFECTS).flatMap(([effect, names]) =>
    names.map((name) => [name, effect as ToolEffect]),
  ),
);
/** Exported so a test can keep every built-in Buzz tool classified. */
export const classifiedBuzzTool = (name: string) => BUZZ_EFFECT.has(name);

const ROLES: Readonly<
  Record<Exclude<ToolPreset, "coder" | "custom">, readonly Capability[]>
> = {
  "super-agent": [
    "native:read",
    "native:web",
    "native:agents",
    "native:meta",
    "buzz:read",
    "buzz:message",
    "buzz:coordinate",
  ],
  reviewer: [
    "native:read",
    "native:web",
    "native:meta",
    "buzz:read",
    "buzz:message",
  ],
};

export function pickToolConfig(raw: unknown): ToolConfig {
  const value =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return Object.fromEntries(
    ["toolPreset", "toolAllow"]
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

export const PRESET_INFO: readonly Described<ToolPreset>[] = [
  {
    id: "super-agent",
    label: "Super-agent",
    description:
      "Reads, coordinates, delegates and manages Tasks. Can't change files, run commands or change deliverables.",
  },
  {
    id: "reviewer",
    label: "Reviewer",
    description:
      "Inspects files, diffs and the web, and reports findings in Buzz. Can't change files, run commands or delegate.",
  },
  {
    id: "coder",
    label: "Coder",
    description:
      "Edits, tests and prepares PRs with every tool the agent's harness allows.",
  },
  {
    id: "custom",
    label: "Custom",
    description: "Only the tools you select below.",
  },
];

const list = (value: string | undefined): readonly string[] => [
  ...new Set(
    (value ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
  ),
];
export const joinToolSelection = (names: readonly string[]) =>
  [...new Set(names.map((name) => name.trim()).filter(Boolean))]
    .sort()
    .join(",");

const presetOf = (value: unknown): ToolPreset | undefined =>
  TOOL_PRESETS.includes(value as ToolPreset)
    ? (value as ToolPreset)
    : typeof value === "string"
      ? LEGACY_PRESETS[value]
      : undefined;

/** Missing settings preserve the behavior of agents saved before tool access. */
export function toolPolicy(
  config: ToolConfig | ToolPolicy | unknown,
): ToolPolicy {
  const value =
    config && typeof config === "object"
      ? (config as ToolConfig & Partial<ToolPolicy>)
      : undefined;
  const preset =
    presetOf(value?.preset) ?? presetOf(value?.toolPreset) ?? "coder";
  return {
    preset,
    allow:
      preset !== "custom"
        ? []
        : Array.isArray(value?.allow)
          ? value.allow
          : list(value?.toolAllow),
  };
}

/** Empty preserves existing saved-session fingerprints for the default policy. */
export function toolPolicyKey(config: ToolConfig | ToolPolicy | unknown) {
  const policy = toolPolicy(config);
  return policy.preset === "coder" ? "" : JSON.stringify(policy);
}

/** What a role starts Custom from, so switching keeps its access. */
export function presetSelection(preset: ToolPreset): readonly string[] {
  if (preset === "custom") return [];
  if (preset === "coder")
    return [
      ...NATIVE_TOOLS.map((tool) => tool.id),
      ...BUZZ_TOOL_GROUPS.map((group) => group.id),
      CONNECTED,
    ];
  return ROLES[preset];
}

/** Whether the role allows any of `ids`, the tool's own id then its group. */
function allows(policy: ToolPolicy, ids: readonly string[]) {
  if (policy.preset === "coder") return true;
  const allowed: readonly string[] =
    policy.preset === "custom" ? policy.allow : ROLES[policy.preset];
  return ids.some((id) => allowed.includes(id));
}

/** Maps each harness's native spelling to a capability. Buzz's own MCP tools
 * are always available and are not subject to this native capability policy. */
/** Codex names a Buzz dynamic tool by its namespace and name joined, as
 * `buzzsend`; the Buzz MCP server gates those calls by the role itself. */
export function isCodexBuzzTool(name: string, buzzTools: readonly string[]) {
  return name.startsWith("buzz") && buzzTools.includes(name.slice(4));
}

export function isBuzzNativeTool(name: string) {
  const normalized = name.toLowerCase();
  return (
    normalized.startsWith("buzz_") ||
    normalized.startsWith("buzz.") ||
    normalized.startsWith("mcp__buzz__")
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
/** Another MCP server's tool, from `mcp__<server>__<tool>`. */
export function connectedTool(name: string) {
  const match = /^mcp__(.+?)__(.+)$/i.exec(name);
  return match && { server: match[1] as string, tool: match[2] as string };
}

export function nativeCapability(name: string): NativeCapability {
  if (NATIVE_TOOLS.some((tool) => tool.id === name))
    return name as NativeCapability;
  if (/^mcp__/i.test(name)) return "native:other";
  const normalized = canonical(name);
  return (
    groups.find(([names]) => names.includes(normalized))?.[1] ?? "native:other"
  );
}

/** A tool the harness itself runs, by its own name for it. Buzz's tools are
 * decided by the Buzz MCP server instead, which `buzzToolAllowed` gates. */
export function nativeToolAllowed(
  name: string,
  config: ToolConfig | ToolPolicy | unknown,
) {
  if (isBuzzNativeTool(name)) return true;
  const policy = toolPolicy(config);
  const connected = connectedTool(name);
  return connected
    ? allows(policy, [
        `${CONNECTED}:${connected.server}/${connected.tool}`,
        `${CONNECTED}:${connected.server}`,
        CONNECTED,
      ])
    : allows(policy, [nativeCapability(name)]);
}

/** The group a Buzz or plugin tool belongs to. */
export function buzzToolEffect(
  name: string,
  added: readonly Readonly<{ name: string; effect?: ToolEffect }>[] = [],
): ToolEffect {
  const plugin = added.find((tool) => tool.name === name);
  if (plugin) return plugin.effect ?? "deliverable";
  return BUZZ_EFFECT.get(name) ?? "deliverable";
}

/** A Buzz or plugin tool, which the Buzz MCP server lists and calls only
 * when this allows it. A plugin tool can also be selected on its own. */
export function buzzToolAllowed(
  name: string,
  config: ToolConfig | ToolPolicy | unknown,
  added: readonly Readonly<{ name: string; effect?: ToolEffect }>[] = [],
) {
  const policy = toolPolicy(config);
  const own = added.some((tool) => tool.name === name)
    ? `plugin:${name}`
    : `buzz:${name}`;
  return allows(policy, [own, `buzz:${buzzToolEffect(name, added)}`]);
}

const nativeDenial = (
  harness: "claude" | "codex" | "pi",
  event: string,
  reason: string,
) => {
  if (harness === "pi") return { block: reason };
  return {
    hookSpecificOutput: {
      hookEventName: event,
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
};

/** Native hook output in the selected harness's existing trusted format. */
export function nativeToolDenial(
  harness: "claude" | "codex" | "pi",
  event: string,
  name: string,
  config: ToolConfig | ToolPolicy | unknown,
): Record<string, unknown> | undefined {
  if (!name || nativeToolAllowed(name, config)) return undefined;
  return nativeDenial(
    harness,
    event,
    `${name} is disabled by this agent's Tools setting.`,
  );
}

/** Full access is the compatibility default for saved configs, never for a
 * running native call whose agent config disappeared from the live snapshot. */
export function missingToolPolicyDenial(
  harness: "claude" | "codex" | "pi",
  event: string,
  name: string,
) {
  if (!name) return;
  return nativeDenial(
    harness,
    event,
    `${name} is disabled because this agent's live Tools setting is unavailable.`,
  );
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
  if (toolPolicy(config).preset === "coder") return;
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
