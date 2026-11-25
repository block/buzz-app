import { describe, expect, it } from "vitest";
import { claudeInherited } from "./inherited";

const files: Record<string, unknown> = {
  "~/.claude.json": { mcpServers: { github: {}, shared: {} } },
  "/work/.mcp.json": { mcpServers: { db: {}, shared: {} } },
};
const readFile = async (path: string, options?: { cwd?: string }) => {
  const key = options?.cwd ? `${options.cwd}/${path}` : path;
  if (!(key in files)) throw new Error("No such file");
  return new TextEncoder().encode(JSON.stringify(files[key]));
};

describe("claudeInherited", () => {
  it("lists the user's and the project's servers, each with its source", async () => {
    expect(await claudeInherited(readFile, "/work")).toEqual([
      { name: "github", source: "From your Claude Code config" },
      { name: "shared", source: "From your Claude Code config" },
      { name: "db", source: "From this project's .mcp.json" },
    ]);
  });

  it("reads only the user's without a project or files", async () => {
    expect((await claudeInherited(readFile)).map((i) => i.name)).toEqual([
      "github",
      "shared",
    ]);
    expect(await claudeInherited(readFile, "/none")).toHaveLength(2);
    expect(await claudeInherited(undefined, "/work")).toEqual([]);
  });
});
