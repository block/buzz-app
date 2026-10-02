// A workspace backed by a real temporary directory and a real bash, with the rules
// native enforces for the app: file calls stay inside, commands only start there.
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import type { AgentWorkspace } from "@buzz/author";

export function nodeWorkspace(): AgentWorkspace & { commands: string[] } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ai-sdk-agent-")));
  const inside = (path: string) => {
    const full = resolve(root, path);
    if (full !== root && !full.startsWith(root + sep))
      throw new Error("Path is outside the agent's workspace");
    return full;
  };
  const commands: string[] = [];
  return {
    path: root,
    commands,
    readFile: async (path) => readFile(inside(path), "utf8"),
    writeFile: async (path, content) => {
      await mkdir(dirname(inside(path)), { recursive: true });
      await writeFile(inside(path), content);
    },
    list: async (path) =>
      (await readdir(inside(path), { withFileTypes: true })).map((entry) => ({
        name: entry.name,
        directory: entry.isDirectory(),
      })),
    exec: (command, options = {}) =>
      new Promise((done, fail) => {
        commands.push(command);
        const child = spawn("/bin/bash", ["-c", `exec 2>&1\n${command}`], {
          cwd: root,
          stdio: ["ignore", "pipe", "ignore"],
          // Its own process group, so stopping it also stops what it started.
          detached: true,
        });
        let failure: Error | undefined;
        const stop = (message: string) => {
          failure = new Error(message);
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        };
        const timer = options.timeoutMs
          ? setTimeout(() => stop("Command timed out"), options.timeoutMs)
          : undefined;
        const cancel = () => stop("Command was cancelled");
        options.signal?.addEventListener("abort", cancel);
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (text: string) => options.onData?.(text));
        child.on("close", (code) => {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", cancel);
          if (failure) fail(failure);
          else done(code);
        });
      }),
  };
}
