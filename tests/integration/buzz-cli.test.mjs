import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { buzzPin, cliTarget } from "../../scripts/build-buzz-cli.mjs";

const read = (path) =>
  readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const rev = "7e6461242aa7d98f132919dd672f7cc5f4abbba6";

test("the bundled buzz CLI builds from the revision of the block/buzz dependency", () => {
  const { git, rev: pinned } = buzzPin(read("src-tauri/Cargo.toml"));
  assert.equal(git, "https://github.com/block/buzz.git");
  assert.ok(
    read("Cargo.lock").includes(
      `source = "git+${git}?rev=${pinned}#${pinned}"`,
    ),
    "Cargo.lock locks a different block/buzz revision than Cargo.toml",
  );
});

test("a manifest without a pinned revision is rejected", () => {
  for (const manifest of [
    "",
    'buzz-audio-client = { git = "https://github.com/block/buzz.git" }',
    `buzz-audio-client = { git = "https://example.com/buzz.git", rev = "${rev}" }`,
    'buzz-audio-client = { git = "https://github.com/block/buzz.git", rev = "main" }',
  ])
    assert.throws(() => buzzPin(manifest), /no buzz-audio-client git revision/);
});

test("linked worktrees share the main checkout's buzz CLI build", (t) => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "buzz-cli-")));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  // Without GIT_* from a calling hook, so git discovers the scratch repositories.
  const env = { PATH: process.env.PATH };
  const main = join(scratch, "main");
  const linked = join(scratch, "linked");
  const git = (...args) =>
    execFileSync("git", args, { cwd: scratch, env, stdio: "ignore" });
  git("init", "-q", main);
  git(
    "-C",
    main,
    "-c",
    "user.name=Example",
    "-c",
    "user.email=dev@example.org",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "init",
  );
  git("-C", main, "worktree", "add", "-q", linked);

  assert.equal(cliTarget(linked, env), join(main, "target"));
  assert.equal(cliTarget(main, env), join(main, "target"));
  assert.equal(cliTarget(scratch, env), join(scratch, "target"));
  assert.equal(
    cliTarget(linked, { ...env, CARGO_TARGET_DIR: join(scratch, "custom") }),
    join(scratch, "custom"),
  );
});

test("CLI staging isolates revision, profile and target build artifacts and retires old installs", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "buzz-cli-staging-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "scripts"));
  mkdirSync(join(directory, "src-tauri"));
  copyFileSync(
    new URL("../../scripts/build-buzz-cli.mjs", import.meta.url),
    join(directory, "scripts/build-buzz-cli.mjs"),
  );
  // Model Cargo reusing a fresh named build artifact and skipping an existing
  // install. The staging script must keep incompatible inputs out of both.
  writeFileSync(
    join(directory, "cargo"),
    `#!${process.execPath}
const { existsSync, mkdirSync, writeFileSync, copyFileSync } = require("node:fs");
const { join } = require("node:path");
const args = process.argv.slice(2);
const value = flag => args[args.indexOf(flag) + 1];
const root = value("--root"), build = value("--target-dir");
const target = args.includes("--target") ? value("--target") : "host";
const profile = args.includes("--debug") ? "debug" : "release";
const name = target.includes("windows") ? "buzz.exe" : "buzz";
mkdirSync(join(root, "bin"), { recursive: true });
mkdirSync(build, { recursive: true });
const installed = join(root, "bin", name), artifact = join(build, name);
if (!existsSync(installed)) {
  if (!existsSync(artifact)) writeFileSync(artifact, [value("--rev"), target, profile].join(":"));
  copyFileSync(artifact, installed);
}
`,
    { mode: 0o755 },
  );
  const target = join(directory, "target");
  const oldInstall = join(target, "buzz-cli", rev, "host", "debug", "bin");
  mkdirSync(oldInstall, { recursive: true });
  writeFileSync(join(oldInstall, "buzz"), "stale legacy install");
  for (const [revision, dev, triple] of [
    [rev, true, ""],
    ["c8d736642e1cddaca5797c54c0c625d16a1724ed", true, ""],
    [rev, false, ""],
    [rev, true, "aarch64-unknown-linux-gnu"],
    [rev, true, ""],
  ]) {
    writeFileSync(
      join(directory, "src-tauri/Cargo.toml"),
      `buzz-audio-client = { git = "https://github.com/block/buzz.git", rev = "${revision}" }`,
    );
    const result = spawnSync(
      process.execPath,
      [
        join(directory, "scripts/build-buzz-cli.mjs"),
        ...(dev ? ["--dev"] : []),
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${directory}${delimiter}${process.env.PATH}`,
          CARGO_TARGET_DIR: target,
          TAURI_ENV_TARGET_TRIPLE: triple || undefined,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      readFileSync(join(directory, "src-tauri/resources/bin/buzz"), "utf8"),
      [revision, triple || "host", dev ? "debug" : "release"].join(":"),
    );
  }
});

test("desktop builds stage buzz after the other helpers", () => {
  const { beforeBuildCommand } = JSON.parse(
    read("src-tauri/tauri.conf.json"),
  ).build;
  assert.match(
    beforeBuildCommand,
    /build-agent-command\.mjs && node scripts\/build-buzz-cli\.mjs && pnpm build$/,
  );
});

test("every release job checks that its packaged buzz exists and runs", () => {
  const release = read(".github/workflows/release.yml");
  for (const check of [
    'cli="$app/Contents/Resources/bin/buzz"',
    '"$cli" --help',
    '"$destination\\bin\\buzz.exe" --help',
    '"$RUNNER_TEMP/deb/usr/lib/Buzz Foundation/bin/buzz" --help',
    '"$RUNNER_TEMP/appimage/squashfs-root/usr/lib/Buzz Foundation/bin/buzz"',
  ])
    assert.ok(release.includes(check), check);
  assert.match(
    release,
    /codesign --verify --strict --verbose=2 \\\n[^\n]*"\$cli"/,
  );
});
