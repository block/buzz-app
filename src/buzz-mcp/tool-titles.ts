// The Buzz tools' display titles by name alone, without the tool set, so the
// renderer can show them without importing every tool. Each tool definition
// takes its MCP `title` from here, so a tool cannot be defined without one.

/** Sentence case, verb first. Shown to people, never read as an interface. */
export const TOOL_TITLES = {
  buzz_help: "Read Buzz help",
  agent_types: "List agent types",
  agent_create: "Draft new agent",
  agent_update: "Draft agent changes",
  agent_read: "Read agent",
  team_read: "Read team",
  team_update: "Draft team changes",
  send: "Send message",
  reply_in_subthread: "Reply in subthread",
  self_handoff: "Hand off to self",
  edit: "Edit message",
  delete: "Delete message",
  react: "React to message",
  pin: "Pin message",
  read: "Read messages",
  search: "Search messages",
  channel_list: "List channels",
  channel_get: "Get channel details",
  workspace_list: "List workspaces",
  channel_create: "Create channel",
  channel_move: "Move conversation",
  channel_update: "Update channel",
  channel_join: "Join channel",
  channel_leave: "Leave channel",
  channel_archive: "Archive channel",
  channel_unarchive: "Unarchive channel",
  channel_delete: "Delete channel",
  member_list: "List channel members",
  member_add: "Add channel members",
  member_remove: "Remove channel members",
  users: "Look up profiles",
  dm: "Open DM",
  mem_get: "Read memory",
  mem_set: "Write memory",
  mem_rm: "Delete memory",
  table_create: "Create table",
  table_list: "List tables",
  table_fields: "Read table fields",
  table_query: "Query table",
  table_save: "Save table",
  notes_get: "Read notes",
  notes_set: "Publish note",
  notes_rm: "Delete note",
  canvas_get: "Read canvas",
  canvas_set: "Replace canvas",
  canvas_history: "List canvas revisions",
  canvas_restore: "Restore canvas revision",
  media_get: "Get media file",
  repo: "Get channel repository",
  tabs: "Manage thread tabs",
  interest_set: "Set Interest",
  interest_show: "Show Interest",
  interest_list: "List Interests",
  interest_remove: "Remove Interest",
  watch_add: "Add watch",
  watch_update: "Update watch",
  watch_enable: "Enable watch",
  watch_disable: "Disable watch",
  watch_remove: "Remove watch",
  watch_rearm: "Rearm timer",
  watch_show: "Show watch",
  watch_list: "List watches",
  solo_worker_connections: "List Solo worker connections",
  solo_worker_readiness: "Check Solo worker readiness",
  solo_worker_create: "Start Solo worker",
  solo_worker_send: "Message Solo worker",
  solo_worker_read: "Read Solo worker",
  solo_worker_stop: "Stop Solo worker",
  solo_worker_archive: "Archive Solo worker chat",
  solo_worker_list: "List Solo workers",
  plugin_list: "List plugins",
  plugin_discover: "Discover plugins",
  plugin_disable: "Disable plugin",
  plugin_request: "Request plugin change",
  plugin_request_status: "Check plugin request",
  settings_list: "List settings",
  settings_get: "Get setting",
  settings_set: "Change setting",
  bestie_get: "Get Bestie",
  bestie_set: "Set Bestie",
  bestie_clear: "Clear Bestie",
} satisfies Record<string, string>;

export type BuzzToolName = keyof typeof TOOL_TITLES;

/** A Buzz tool's title, by its exact name; nothing for any other name. */
export const toolTitle = (name: string): string | undefined =>
  Object.hasOwn(TOOL_TITLES, name)
    ? TOOL_TITLES[name as BuzzToolName]
    : undefined;

/** The Buzz server's tool name in a title, as each harness writes it:
 * `mcp__buzz__read` (Claude Code), `buzz__read` or `buzz: read` (goose), or
 * `buzz.read` (Codex and the local transcripts). The qualifier is required: a
 * bare `read` may be any server's tool. Another server's prefix never
 * matches. */
const BUZZ_TOOL = /^(?:(?:mcp__)?buzz__|buzz\.|buzz: )([a-z_]+)$/;

/** The title of the Buzz tool a harness's tool title names; nothing for any
 * title that does not name the Buzz server and one of its tools exactly. */
export const namedToolTitle = (title: string): string | undefined => {
  const name = BUZZ_TOOL.exec(title.trim())?.[1];
  return name ? toolTitle(name) : undefined;
};
