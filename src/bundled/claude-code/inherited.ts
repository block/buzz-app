// The MCP servers in Claude Code's own user config, which its agents run too
// (a strict launch never does). Claude keeps user-scope servers in
// `~/.claude.json` and a project's in its `.mcp.json`.
import type { McpInherited } from "../../features/agents/mcp-servers";

type ReadFile = (
  path: string,
  options?: Readonly<{ cwd?: string }>,
) => Promise<Uint8Array>;

/** The `mcpServers` names in the JSON file at `path`; none when unreadable. */
async function serversIn(
  readFile: ReadFile,
  path: string,
  cwd?: string,
): Promise<readonly string[]> {
  try {
    const text = new TextDecoder().decode(
      await readFile(path, cwd ? { cwd } : undefined),
    );
    const { mcpServers } = JSON.parse(text) as { mcpServers?: unknown };
    return mcpServers && typeof mcpServers === "object"
      ? Object.keys(mcpServers)
      : [];
  } catch {
    return [];
  }
}

/** The servers in `~/.claude.json` and, for a session in `cwd`, that
 * project's `.mcp.json`; a name in both is listed once, as the user's. */
export async function claudeInherited(
  readFile: ReadFile | undefined,
  cwd?: string,
): Promise<readonly McpInherited[]> {
  if (!readFile) return [];
  const [user, project] = await Promise.all([
    serversIn(readFile, "~/.claude.json"),
    cwd ? serversIn(readFile, ".mcp.json", cwd) : [],
  ]);
  return [
    ...user.map((name) => ({ name, source: "From your Claude Code config" })),
    ...project
      .filter((name) => !user.includes(name))
      .map((name) => ({ name, source: "From this project's .mcp.json" })),
  ];
}
