import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buzzPin } from "../../scripts/build-buzz-cli.mjs";

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
