// The MCP servers in Claude Code's own user config, which its agents run too
// (a strict launch never does). Claude keeps user-scope servers in
// `~/.claude.json`; a project's `.mcp.json` asks Claude for approval first.
import type { McpInherited } from "../../features/agents/mcp-servers";

type ReadFile = (path: string) => Promise<Uint8Array>;

export async function claudeInherited(
  readFile: ReadFile | undefined,
): Promise<readonly McpInherited[]> {
  if (!readFile) return [];
  let text: string;
  try {
    text = new TextDecoder().decode(await readFile("~/.claude.json"));
  } catch {
    return [];
  }
  try {
    const { mcpServers } = JSON.parse(text) as { mcpServers?: unknown };
    return mcpServers && typeof mcpServers === "object"
      ? Object.keys(mcpServers).map((name) => ({
          name,
          source: "From your Claude Code config",
        }))
      : [];
  } catch {
    return [];
  }
}
