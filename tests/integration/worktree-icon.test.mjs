import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runtimeFixture } from "./agent-runtime-fixture.mjs";

// Real Git worktrees and subprocesses; only Swift rendering and pnpm are stubs.
// The macOS-only launcher wiring also runs on a Mac, without opening an app.
function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "buzz-worktree-icon-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const env = { ...process.env };
  // Git hooks export repository selectors; never let fixtures touch the real repo.
  for (const key of [
    "GIT_DIR",
    "GIT_COMMON_DIR",
    "GIT_WORK_TREE",
    "GIT_IMPLICIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_PREFIX",
  ])
    delete env[key];
  const git = (...args) =>
    execFileSync("git", args, { env, stdio: "pipe" }).toString().trim();
  const main = path.join(directory, "main");
  const linked = path.join(directory, 'linked "checkout"');
  const emptyHooks = path.join(directory, "hooks");
  mkdirSync(emptyHooks);
  git("init", "--initial-branch=main", main);
  git("-C", main, "config", "core.hooksPath", emptyHooks);
  git(
    "-C",
    main,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--allow-empty",
    "-m",
    "fixture",
  );
  git("-C", main, "worktree", "add", "-b", "person/first-label", linked);
  const tools = path.join(directory, "tools");
  mkdirSync(tools);
  const render = (body) =>
    writeFileSync(
      path.join(tools, "swift"),
      `#!${process.execPath}\n${body}\n`,
      { mode: 0o755 },
    );
  render('require("node:fs").writeFileSync(process.argv[4], process.argv[5]);');
  writeFileSync(
    path.join(tools, "pnpm"),
    `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)));`,
    { mode: 0o755 },
  );
  env.PATH = `${tools}${path.delimiter}${env.PATH}`;
  for (const cwd of [main, linked]) {
    runtimeFixture(cwd);
    for (const file of ["desktop-dev.mjs", "worktree-icon.mjs"]) {
      copyFileSync(
        new URL(`../../scripts/${file}`, import.meta.url),
        path.join(cwd, "scripts", file),
      );
    }
  }
  const run = (cwd, args) => {
    const result = spawnSync(process.execPath, args, {
      cwd,
      env,
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return result;
  };
  const icon = (cwd, platform = "darwin") => {
    const result = run(cwd, [
      "--input-type=module",
      "-e",
      `import { worktreeIcon } from './scripts/worktree-icon.mjs'; console.log(JSON.stringify(worktreeIcon(process.cwd(), ${JSON.stringify(platform)})));`,
    ]);
    return { ...result, icon: JSON.parse(result.stdout.trim()) };
  };
  return { main, linked, git, render, icon, run };
}

test("only linked macOS worktrees receive a content-keyed, current-branch icon", (t) => {
  const { main, linked, git, icon } = fixture(t);
  assert.equal(icon(main).icon, null);
  for (const platform of ["linux", "win32"])
    assert.equal(icon(linked, platform).icon, null);
  const first = icon(linked).icon;
  assert.equal(readFileSync(first, "utf8"), "first-label");
  assert.equal(
    icon(linked).icon,
    first,
    "unchanged bytes keep a stable configuration",
  );
  const head = git("-C", linked, "rev-parse", "HEAD");
  git("-C", linked, "branch", "-m", "person/second-label");
  assert.equal(git("-C", linked, "rev-parse", "HEAD"), head);
  const second = icon(linked).icon;
  assert.notEqual(
    second,
    first,
    "new bytes must change Tauri config for warm Cargo builds",
  );
  assert.equal(readFileSync(second, "utf8"), "second-label");
  assert.equal(
    readFileSync(first, "utf8"),
    "first-label",
    "in-flight builds retain their original bytes",
  );
  git("-C", linked, "checkout", "--detach");
  assert.equal(readFileSync(icon(linked).icon, "utf8"), path.basename(linked));
  assert.ok(
    readdirSync(path.dirname(first)).every((name) => name.endsWith(".icns")),
    "staging files are cleaned up",
  );
});

test("failed generation warns, removes partial output, and falls back", (t) => {
  const { linked, render, icon } = fixture(t);
  render(
    'require("node:fs").writeFileSync(process.argv[4], "partial"); process.exit(1);',
  );
  const result = icon(linked);
  assert.equal(result.icon, null);
  assert.match(result.stderr, /using the ordinary Buzz icon/);
  assert.deepEqual(
    readdirSync(path.join(linked, "src-tauri/target/dev-icons")),
    [],
  );
});

test("macOS launcher combines icon and port before explicit config and runner arguments", {
  skip: process.platform !== "darwin",
}, (t) => {
  const { linked, run, render } = fixture(t);
  const forwarded = [
    "--config",
    '{"bundle":{"icon":["custom.icns"]}}',
    "--runner",
    "echo",
    "two words",
    "--",
    "--port",
    "app-port",
    "$(pnpm injected)",
  ];
  const launch = () =>
    JSON.parse(
      run(linked, ["scripts/desktop-dev.mjs", "--port=1431", ...forwarded])
        .stdout.trim()
        .split("\n")
        .at(-1),
    );
  const call = launch();
  assert.deepEqual(call.slice(0, 3), ["tauri", "dev", "--config"]);
  const config = JSON.parse(call[3]);
  assert.equal(readFileSync(config.bundle.icon[0], "utf8"), "first-label");
  assert.deepEqual(config.build, {
    devUrl: "http://localhost:1431",
    beforeDevCommand: "pnpm dev:desktop --port 1431",
  });
  assert.deepEqual(call.slice(4), forwarded);
  render("process.exit(1);");
  const fallback = launch();
  assert.deepEqual(JSON.parse(fallback[3]), { build: config.build });
  assert.deepEqual(fallback.slice(4), forwarded);
});

test("real macOS renderer accepts long display labels", {
  skip: process.platform !== "darwin",
}, (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "buzz-icon-render-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const output = path.join(directory, "icon.icns");
  // Valid Git suffix, but too long when combined with a prefix and UUID as a path.
  const label = "a".repeat(220);
  const result = spawnSync(
    "swift",
    [
      path.join(root, "scripts/generate-dev-icon.swift"),
      path.join(root, "src-tauri/icons/icon.icns"),
      output,
      label,
    ],
    { encoding: "utf8", timeout: 60_000 },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  // Decode the generated artifact rather than asserting artwork or internal names.
  execFileSync("/usr/bin/iconutil", [
    "-c",
    "iconset",
    output,
    "-o",
    path.join(directory, "decoded.iconset"),
  ]);
});
