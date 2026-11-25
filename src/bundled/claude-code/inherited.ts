// The MCP servers in Claude Code's own user config, which its agents run too
// (a strict launch never does). Claude keeps user-scope servers in
// `~/.claude.json`, local-scope ones under that file's `projects[<folder>]`,
// and a project's in its `.mcp.json`.
import type { McpInherited } from "../../features/agents/mcp-servers";

type ReadFile = (
  path: string,
  options?: Readonly<{ cwd?: string }>,
) => Promise<Uint8Array>;

/** A config file, parsed: undefined when it isn't there, `null` when it
 * can't be parsed, which is not the same as an empty config. */
async function json(
  readFile: ReadFile,
  path: string,
  cwd?: string,
): Promise<unknown> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(path, cwd ? { cwd } : undefined);
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) ?? {};
  } catch {
    return null;
  }
}

/** The `mcpServers` table in a parsed config; empty when absent. */
function table(config: unknown): Readonly<Record<string, unknown>> {
  const servers = (config as { mcpServers?: unknown } | undefined)?.mcpServers;
  return servers && typeof servers === "object"
    ? (servers as Record<string, unknown>)
    : {};
}

const sorted = (value: unknown) =>
  value && typeof value === "object" ? Object.keys(value).sort() : [];

/** What Claude Code starts a server with, without the values of its
 * variables or headers. */
function definition(server: unknown) {
  const s = (server ?? {}) as Record<string, unknown>;
  return [
    s.type ?? null,
    s.command ?? null,
    s.args ?? null,
    s.url ?? null,
    s.disabled ?? null,
    sorted(s.env),
    sorted(s.headers),
  ];
}

/** One read of `~/.claude.json`, which every folder's snapshot can share. */
export const claudeUserConfig = (readFile: ReadFile) =>
  json(readFile, "~/.claude.json");

export type ClaudeSnapshot = Readonly<{
  servers: readonly McpInherited[];
  /** The servers' definitions, without secrets; undefined when a file
   * couldn't be parsed. */
  print: string | undefined;
}>;

/** The servers in `~/.claude.json` and, for a session in `cwd`, its local
 * scope there (keyed by the folder's absolute path, which `resolve` gives)
 * and that project's `.mcp.json`. A name in more than one is listed once,
 * from the first: as Claude Code ranks them, local, then project, then user.
 * `user` is a shared read of `~/.claude.json`. */
export async function claudeSnapshot(
  readFile: ReadFile | undefined,
  cwd?: string,
  resolve?: (path: string) => Promise<string>,
  user?: Promise<unknown>,
): Promise<ClaudeSnapshot> {
  if (!readFile) return { servers: [], print: "[]" };
  const [mine, project, folder] = await Promise.all([
    user ?? claudeUserConfig(readFile),
    cwd ? json(readFile, ".mcp.json", cwd) : undefined,
    cwd && resolve ? resolve(cwd).catch(() => undefined) : undefined,
  ]);
  const projects = (mine as { projects?: Record<string, unknown> } | undefined)
    ?.projects;
  const local =
    folder && projects && Object.hasOwn(projects, folder)
      ? projects[folder]
      : undefined;
  const tables = [
    [local, "From your Claude Code config for this folder"],
    [project, "From this project's .mcp.json"],
    [mine, "From your Claude Code config"],
  ] as const;
  const seen = new Set<string>();
  const servers = tables.flatMap(([config, source]) =>
    Object.keys(table(config)).flatMap((name) => {
      if (seen.has(name)) return [];
      seen.add(name);
      return [{ name, source }];
    }),
  );
  const print =
    mine === null || project === null
      ? undefined
      : JSON.stringify(
          tables.map(([config]) =>
            Object.entries(table(config))
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([name, server]) => [name, definition(server)]),
          ),
        );
  return { servers, print };
}

/** The inherited servers alone. */
export const claudeInherited = async (
  ...args: Parameters<typeof claudeSnapshot>
): Promise<readonly McpInherited[]> => (await claudeSnapshot(...args)).servers;

/** Whether any process `started` with other servers than its folder has
 * now. Each folder is read once, sharing one read of `~/.claude.json`; a
 * print that can't be read, then or now, counts as unchanged. */
export async function claudeChanged(
  readFile: ReadFile | undefined,
  started: readonly Readonly<{
    folder: string;
    print: Promise<string | undefined>;
  }>[],
  resolve?: (path: string) => Promise<string>,
): Promise<boolean> {
  if (!readFile || !started.length) return false;
  const user = claudeUserConfig(readFile);
  const now = new Map<string, Promise<string | undefined>>();
  const fresh = (folder: string) => {
    let print = now.get(folder);
    if (!print) {
      print = claudeSnapshot(readFile, folder, resolve, user).then(
        (s) => s.print,
      );
      now.set(folder, print);
    }
    return print;
  };
  const changed = await Promise.all(
    started.map(async ({ folder, print }) => {
      const [then, current] = await Promise.all([print, fresh(folder)]);
      return then !== undefined && current !== undefined && then !== current;
    }),
  );
  return changed.some(Boolean);
}
