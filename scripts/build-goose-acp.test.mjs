import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function fixture(triple = "aarch64-apple-darwin") {
  const dir = mkdtempSync(join(tmpdir(), "goose-staged-"));
  dirs.push(dir);
  for (const path of ["scripts", "runtime", "commands"])
    mkdirSync(join(dir, path));
  for (const path of ["scripts/build-goose-acp.mjs", "runtime/goose-acp.json"])
    copyFileSync(join(root, path), join(dir, path));
  const pin = JSON.parse(readFileSync(join(dir, "runtime/goose-acp.json")));
  const name = triple.includes("windows") ? "goose-acp.exe" : "goose-acp";
  const binary = join(dir, "src-tauri/resources/bin", name);
  const stamp = join(dir, "target/goose-acp-build/staged.json");
  const output = join(dir, "target/goose-acp-build", triple, pin.profile, name);
  const command = (name, source) =>
    writeFileSync(
      join(dir, "commands", name),
      `#!${process.execPath}\n${source}`,
      {
        mode: 0o755,
      },
    );
  command("git", "process.exit(0);");
  command(
    "cargo",
    `const fs = require('node:fs');
fs.mkdirSync(${JSON.stringify(dirname(output))}, {recursive:true});
fs.writeFileSync(${JSON.stringify(output)}, 'compiled Goose fixture', {mode:0o755});`,
  );
  command(
    "otool",
    "console.log('goose-acp:\\n\\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0)');",
  );
  const run = () =>
    spawnSync(process.execPath, [join(dir, "scripts/build-goose-acp.mjs")], {
      cwd: dir,
      encoding: "utf8",
      env: { PATH: join(dir, "commands"), TAURI_ENV_TARGET_TRIPLE: triple },
    });
  const built = run();
  assert.equal(built.status, 0, built.stderr);
  // Any cache rejection must enter the real build path, without network or Cargo.
  command("git", "console.error('SOURCE_BUILD_REQUIRED'); process.exit(73);");
  return { dir, binary, stamp, run };
}

test.each([
  "aarch64-apple-darwin",
  "x86_64-pc-windows-msvc",
  "x86_64-unknown-linux-gnu",
])(
  "reuses the staged executable after an archive round-trip for %s",
  (triple) => {
    const { dir, binary, stamp, run } = fixture(triple);
    const paths = [binary, stamp].map((path) => path.slice(dir.length + 1));
    assert.equal(
      spawnSync("tar", ["-cf", "cache.tar", ...paths], { cwd: dir }).status,
      0,
    );
    rmSync(binary);
    rmSync(stamp);
    assert.equal(
      spawnSync("tar", ["-xf", "cache.tar"], { cwd: dir }).status,
      0,
    );
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /goose-acp ready/);
  },
);

test.each([
  [
    "modified executable",
    ({ binary }) => writeFileSync(binary, "corrupt bytes"),
  ],
  ["empty executable", ({ binary }) => writeFileSync(binary, "")],
  ["non-executable file", ({ binary }) => chmodSync(binary, 0o644)],
  ["missing executable", ({ binary }) => rmSync(binary)],
  ["missing stamp", ({ stamp }) => rmSync(stamp)],
  ["malformed stamp", ({ stamp }) => writeFileSync(stamp, "not json")],
  [
    "symlinked executable",
    ({ binary, stamp }) => {
      rmSync(binary);
      symlinkSync(stamp, binary);
    },
  ],
  [
    "legacy stamp",
    ({ stamp }) => {
      const { sha256: _sha256, ...inputs } = JSON.parse(readFileSync(stamp));
      writeFileSync(stamp, `${JSON.stringify(inputs, null, 2)}\n`);
    },
  ],
  ...["revision", "features", "profile", "triple", "sha256"].map((field) => [
    `mismatched ${field}`,
    ({ stamp }) => {
      const inputs = JSON.parse(readFileSync(stamp));
      writeFileSync(
        stamp,
        `${JSON.stringify({ ...inputs, [field]: "stale" }, null, 2)}\n`,
      );
    },
  ]),
])("rebuilds a cached pair with %s", (_name, damage) => {
  const staged = fixture();
  damage(staged);
  const result = staged.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SOURCE_BUILD_REQUIRED/);
});
