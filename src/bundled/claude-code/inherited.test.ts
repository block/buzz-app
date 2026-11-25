import { describe, expect, it } from "vitest";
import {
  claudeChanged,
  claudeInherited,
  claudeSnapshot,
  claudeUserConfig,
} from "./inherited";

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

describe("claudeChanged", () => {
  const disk = (): Record<string, string> => ({
    "~/.claude.json": JSON.stringify({
      mcpServers: { github: { command: "gh", env: { TOKEN: "a" } } },
    }),
    "~/one/.mcp.json": JSON.stringify({
      mcpServers: { db: { url: "http://a" } },
    }),
    "~/two/.mcp.json": JSON.stringify({
      mcpServers: { db: { url: "http://b" } },
    }),
  });
  let now = disk();
  let userReads = 0;
  const read = async (path: string, options?: { cwd?: string }) => {
    const key = options?.cwd ? `${options.cwd}/${path}` : path;
    if (key === "~/.claude.json") userReads++;
    const text = now[key];
    if (text === undefined) throw new Error("No such file");
    return new TextEncoder().encode(text);
  };
  /** A process's baseline, as its spawn reads it. */
  const spawned = async (folder: string) => ({
    folder,
    print: Promise.resolve((await claudeSnapshot(read, folder)).print),
  });
  const edit = (path: string, servers: unknown) => {
    now = { ...now, [path]: JSON.stringify({ mcpServers: servers }) };
  };

  it("shows nothing when nothing is running, or the config is as it started", async () => {
    now = disk();
    expect(await claudeChanged(read, [])).toBe(false);
    expect(await claudeChanged(read, [await spawned("~/one")])).toBe(false);
  });

  it("shows a change to a server's definition, but not to a value", async () => {
    now = disk();
    const started = [await spawned("~/one")];
    edit("~/.claude.json", { github: { command: "gh", env: { TOKEN: "b" } } });
    expect(await claudeChanged(read, started)).toBe(false);
    edit("~/.claude.json", { github: { command: "gh", args: ["--x"] } });
    expect(await claudeChanged(read, started)).toBe(true);
  });

  it("shows a change when one of two processes is stale", async () => {
    now = disk();
    const one = await spawned("~/one");
    edit("~/one/.mcp.json", { db: { url: "http://c" } });
    const fresh = await spawned("~/one");
    expect(await claudeChanged(read, [fresh, one])).toBe(true);
  });

  it("compares each process with its own folder, each read once", async () => {
    now = disk();
    const a = [await spawned("~/one"), await spawned("~/one")];
    const b = [await spawned("~/two")];
    userReads = 0;
    expect(await claudeChanged(read, [...a, ...b])).toBe(false);
    expect(userReads).toBe(1);
    edit("~/two/.mcp.json", { db: { url: "http://d" } });
    expect(await claudeChanged(read, a)).toBe(false);
    expect(await claudeChanged(read, b)).toBe(true);
  });

  it("counts a config it can't parse as unchanged, not as empty", async () => {
    now = disk();
    const started = [await spawned("~/one")];
    now = { ...now, "~/one/.mcp.json": "{" };
    expect((await claudeSnapshot(read, "~/one")).print).toBeUndefined();
    expect(await claudeChanged(read, started)).toBe(false);
  });

  it("shows an on/off change in the folder's local scope alone", async () => {
    const user = (disabled: string[]) =>
      JSON.stringify({
        mcpServers: { github: { command: "gh" } },
        projects: { "/home/me/one": { disabledMcpServers: disabled } },
      });
    now = { ...disk(), "~/.claude.json": user([]) };
    const started = {
      folder: "~/one",
      print: claudeSnapshot(read, "~/one", resolve).then((s) => s.print),
    };
    expect(await claudeChanged(read, [started], resolve)).toBe(false);
    now = { ...now, "~/.claude.json": user(["db"]) };
    expect(await claudeChanged(read, [started], resolve)).toBe(true);
  });

  it("counts a file it can't read as unchanged, not as missing", async () => {
    now = disk();
    const started = [await spawned("~/one")];
    const denied = async (path: string, options?: { cwd?: string }) => {
      if (path === ".mcp.json") throw new Error("Permission denied");
      return read(path, options);
    };
    expect((await claudeSnapshot(denied, "~/one")).print).toBeUndefined();
    expect(await claudeChanged(denied, started)).toBe(false);
  });

  it("shares the reads a settings request already made", async () => {
    now = disk();
    const started = [await spawned("~/one")];
    userReads = 0;
    const user = claudeUserConfig(read);
    const listing = claudeSnapshot(read, "~/one", undefined, user);
    const reads = {
      user,
      folders: new Map([["~/one", listing.then((s) => s.print)]]),
    };
    expect(await claudeChanged(read, started, undefined, reads)).toBe(false);
    await listing;
    expect(userReads).toBe(1);
  });
});
