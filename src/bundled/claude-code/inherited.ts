// The MCP servers in Claude Code's own user config, which its agents run too
// (a strict launch never does). Claude keeps user-scope servers in
// `~/.claude.json`, local-scope ones under that file's `projects[<folder>]`,
// and a project's in its `.mcp.json`.
import type { McpInherited } from "../../features/agents/mcp-servers";

type ReadFile = (
  path: string,
  options?: Readonly<{ cwd?: string }>,
) => Promise<Uint8Array>;

async function json(
  readFile: ReadFile,
  path: string,
  cwd?: string,
): Promise<unknown> {
  try {
    return JSON.parse(
      new TextDecoder().decode(await readFile(path, cwd ? { cwd } : undefined)),
    );
  } catch {
    return undefined;
  }
}

/** The `mcpServers` names in a parsed config; none when absent. */
function serversIn(config: unknown): readonly string[] {
  const servers = (config as { mcpServers?: unknown } | undefined)?.mcpServers;
  return servers && typeof servers === "object" ? Object.keys(servers) : [];
}

/** The servers in `~/.claude.json` and, for a session in `cwd`, its local
 * scope there (keyed by the folder's absolute path, which `resolve` gives)
 * and that project's `.mcp.json`. A name in more than one is listed once,
 * from the first: as Claude Code ranks them, local, then project, then user. */
export async function claudeInherited(
  readFile: ReadFile | undefined,
  cwd?: string,
  resolve?: (path: string) => Promise<string>,
): Promise<readonly McpInherited[]> {
  if (!readFile) return [];
  const [user, project, folder] = await Promise.all([
    json(readFile, "~/.claude.json"),
    cwd ? json(readFile, ".mcp.json", cwd) : undefined,
    cwd && resolve ? resolve(cwd).catch(() => undefined) : undefined,
  ]);
  const projects = (user as { projects?: Record<string, unknown> } | undefined)
    ?.projects;
  const local =
    folder && projects && Object.hasOwn(projects, folder)
      ? projects[folder]
      : undefined;
  const seen = new Set<string>();
  return (
    [
      [local, "From your Claude Code config for this folder"],
      [project, "From this project's .mcp.json"],
      [user, "From your Claude Code config"],
    ] as const
  ).flatMap(([config, source]) =>
    serversIn(config).flatMap((name) =>
      seen.has(name) ? [] : (seen.add(name), [{ name, source }]),
    ),
  );
}
