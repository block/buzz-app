import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import script from "./codex.sh?raw";
import type { Store } from "./rpc";
const command = ["-c", script, "codex.sh"];

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "buzz codex ' $ ")));
  roots.push(root);
  const shared = join(root, "shared");
  const isolated =
    process.platform === "darwin"
      ? join(root, "Library/Application Support/Buzz/codex-home")
      : join(root, "data/buzz/codex-home");
  const bin = join(root, "bin");
  await mkdir(shared);
  await mkdir(bin);
  await writeFile(join(shared, "auth.json"), "synthetic credential");
  await writeFile(join(shared, "config.toml"), "model = 'fixture'\n");
  await writeFile(
    join(bin, "codex"),
    '#!/bin/sh\nprintf "%s\\n" "$CODEX_HOME" "$@"\n',
    { mode: 0o755 },
  );
  for (const home of [
    isolated.slice(0, -5),
    join(root, "Library/Application Support/Buzz/codex"),
  ]) {
    await mkdir(join(home, "0.1.0/bin"), { recursive: true });
    await writeFile(
      join(home, "0.1.0/bin/codex"),
      await readFile(join(bin, "codex")),
      { mode: 0o755 },
    );
    await writeFile(join(home, "current"), "0.1.0");
  }
  const run = (
    store: Store = "isolated",
    source = shared,
    args = ["server", store],
  ) =>
    execute("bash", [...command, ...args], {
      env: {
        ...process.env,
        HOME: root,
        XDG_DATA_HOME: join(root, "data"),
        CODEX_HOME: source,
        CODEX_SQLITE_HOME: shared,
        PATH: `${bin}:${process.env.PATH}`,
      },
    });
  return { root, shared, isolated, bin, run };
}
it("isolates all runtime state while sharing only configuration, instructions, skills and file authentication", async () => {
  const f = await fixture();
  const { stdout } = await f.run();
  expect(stdout.trim().split("\n")).toEqual([
    f.isolated,
    "-c",
    `sqlite_home=${f.isolated}`,
    "app-server",
  ]);
  for (const name of [
    "config.toml",
    "auth.json",
    "AGENTS.md",
    "rules",
    "skills",
  ])
    expect(await readlink(join(f.isolated, name))).toBe(join(f.shared, name));
  for (const name of [
    "sessions",
    "archived_sessions",
    "state_5.sqlite",
    "thread_history_1.sqlite",
    "history.jsonl",
    "session_index.jsonl",
  ])
    await expect(readlink(join(f.isolated, name))).rejects.toMatchObject({
      code: "ENOENT",
    });
  await writeFile(join(f.isolated, "auth.json"), "synthetic refresh");
  expect(await readFile(join(f.shared, "auth.json"), "utf8")).toBe(
    "synthetic refresh",
  );
  expect(await readlink(join(f.isolated, "auth.json"))).toBe(
    join(f.shared, "auth.json"),
  );
  await f.run();
});
it("leaves legacy authentication and state paths unchanged", async () => {
  const f = await fixture();
  const { stdout } = await f.run("legacy");
  expect(stdout.trim().split("\n")).toEqual([f.shared, "app-server"]);
  await expect(readlink(join(f.isolated, "auth.json"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});
it("refuses conflicting files or another source home without replacing existing setup", async () => {
  const f = await fixture();
  await mkdir(f.isolated, { recursive: true });
  await writeFile(join(f.isolated, "config.toml"), "keep me");
  await expect(f.run()).rejects.toMatchObject({
    stderr: expect.stringContaining("setup conflicts"),
  });
  expect(await readFile(join(f.isolated, "config.toml"), "utf8")).toBe(
    "keep me",
  );
  await rm(join(f.isolated, "config.toml"));
  await f.run();
  const other = join(f.root, "other");
  await mkdir(other);
  await expect(f.run("isolated", other)).rejects.toMatchObject({
    stderr: expect.stringContaining("setup conflicts"),
  });
  expect(await readlink(join(f.isolated, "auth.json"))).toBe(
    join(f.shared, "auth.json"),
  );
});
it("contains simultaneous catalog and runtime setup without copying or replacing linked files", async () => {
  const f = await fixture();
  await Promise.all([f.run(), f.run()]);
  expect(await readlink(join(f.isolated, "auth.json"))).toBe(
    join(f.shared, "auth.json"),
  );
});

it("uses the macOS application data directory without exposing the runtime store in the workspace", async () => {
  const f = await fixture();
  await writeFile(join(f.bin, "uname"), '#!/bin/sh\nprintf "Darwin\\n"\n', {
    mode: 0o755,
  });
  const { stdout } = await f.run();
  expect(stdout.trim().split("\n")[0]).toBe(
    join(f.root, "Library/Application Support/Buzz/codex-home"),
  );
});

it("uses the same isolated home for provider sign-in and account checks", async () => {
  const f = await fixture();
  const { stdout } = await f.run("isolated", f.shared, [
    "run",
    "login",
    "status",
  ]);
  expect(stdout.trim().split("\n")).toEqual([
    f.isolated,
    "-c",
    `sqlite_home=${f.isolated}`,
    "login",
    "status",
  ]);
});
