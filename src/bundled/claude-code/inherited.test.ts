import { describe, expect, it } from "vitest";
import { claudeInherited } from "./inherited";

const files: Record<string, unknown> = {
  "~/.claude.json": {
    mcpServers: { github: {}, shared: {} },
    projects: {
      "/home/me/work": { mcpServers: { notes: {}, db: {} } },
      "/elsewhere": { mcpServers: { other: {} } },
    },
  },
  "~/work/.mcp.json": { mcpServers: { db: {}, shared: {} } },
};
const readFile = async (path: string, options?: { cwd?: string }) => {
  const key = options?.cwd ? `${options.cwd}/${path}` : path;
  if (!(key in files)) throw new Error("No such file");
  return new TextEncoder().encode(JSON.stringify(files[key]));
};
const resolve = async (path: string) => path.replace(/^~/, "/home/me");

describe("claudeInherited", () => {
  it("lists the folder's local, the project's and the user's servers, each once with its source", async () => {
    expect(await claudeInherited(readFile, "~/work", resolve)).toEqual([
      { name: "notes", source: "From your Claude Code config for this folder" },
      { name: "db", source: "From your Claude Code config for this folder" },
      { name: "shared", source: "From this project's .mcp.json" },
      { name: "github", source: "From your Claude Code config" },
    ]);
  });

  it("reads only the user's without a project or files", async () => {
    expect((await claudeInherited(readFile)).map((i) => i.name)).toEqual([
      "github",
      "shared",
    ]);
    expect(await claudeInherited(readFile, "/none", resolve)).toHaveLength(2);
    expect(await claudeInherited(undefined, "~/work", resolve)).toEqual([]);
  });

  it("skips the local scope when the folder can't be resolved", async () => {
    const fails = async () => Promise.reject(new Error("gone"));
    expect(
      (await claudeInherited(readFile, "~/work", fails)).map((i) => i.name),
    ).toEqual(["db", "shared", "github"]);
  });
});
