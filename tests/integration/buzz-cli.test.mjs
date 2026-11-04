import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buzzPin,
  cliBuildDir,
  cliTarget,
} from "../../scripts/build-buzz-cli.mjs";

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

test("each block/buzz revision builds in its own directory", () => {
  const other = "0e6037c74d67930de36143ed4661f469039d8dc7";
  assert.equal(cliBuildDir("/t", rev), join("/t", "buzz-cli-build", rev));
  assert.notEqual(cliBuildDir("/t", rev), cliBuildDir("/t", other));
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
  const release = read(".github/workflows/desktop-build.yml");
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

// With the real pin but no cargo on PATH, a build fails, so a test fails if the
// script ignores BUZZ_CLI_BINARY.
function stageWithPrebuilt(t, writePrebuilt) {
  const directory = mkdtempSync(join(tmpdir(), "buzz-cli-prebuilt-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "scripts"));
  mkdirSync(join(directory, "src-tauri"));
  for (const path of ["scripts/build-buzz-cli.mjs", "src-tauri/Cargo.toml"])
    copyFileSync(
      new URL(`../../${path}`, import.meta.url),
      join(directory, path),
    );
  const prebuilt = join(directory, "prebuilt-buzz");
  if (writePrebuilt) writeFileSync(prebuilt, "packager's buzz");
  const result = spawnSync(
    process.execPath,
    [join(directory, "scripts/build-buzz-cli.mjs")],
    {
      encoding: "utf8",
      env: {
        PATH: "",
        TAURI_ENV_TARGET_TRIPLE: "x86_64-unknown-linux-gnu",
        BUZZ_CLI_BINARY: prebuilt,
      },
    },
  );
  return { result, staged: join(directory, "src-tauri/resources/bin/buzz") };
}

test("buzz staging uses a packager's prebuilt binary without building", (t) => {
  const { result, staged } = stageWithPrebuilt(t, true);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(staged, "utf8"), "packager's buzz");
});

test("buzz staging fails on a missing prebuilt binary instead of building", (t) => {
  const { result, staged } = stageWithPrebuilt(t, false);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ENOENT[^\n]*prebuilt-buzz/);
  assert.doesNotMatch(result.stderr, /spawnSync cargo/);
  assert.equal(existsSync(staged), false);
});
