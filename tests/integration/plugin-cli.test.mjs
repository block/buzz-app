import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";

const root = fileURLToPath(new URL("../../", import.meta.url));
const compiled = spawnSync(
  "cargo",
  ["build", "--quiet", "--locked", "-p", "buzzodz-plugins", "--bin", "buzzodz"],
  { cwd: root, encoding: "utf8" },
);
assert.equal(compiled.status, 0, compiled.stderr);
const metadata = spawnSync(
  "cargo",
  ["metadata", "--format-version=1", "--no-deps", "--locked"],
  { cwd: root, encoding: "utf8" },
);
assert.equal(metadata.status, 0, metadata.stderr);
const binary = path.join(
  JSON.parse(metadata.stdout).target_directory,
  "debug",
  process.platform === "win32" ? "buzzodz.exe" : "buzzodz",
);
function cli(...args) {
  return spawnSync(binary, args, { cwd: root, encoding: "utf8" });
}
async function project(run) {
  const directory = await mkdtemp(path.join(tmpdir(), "buzzodz-build-"));
  const source = path.join(directory, "page");
  try {
    const initialized = cli("plugin", "init", source, "test.page", "Test page");
    assert.equal(initialized.status, 0, initialized.stderr);
    assert.match(initialized.stdout, /Created test.page/);
    // Install the generated project's own dependencies; pnpm reuses its package cache.
    const installed = spawnSync("pnpm", ["install", "--ignore-scripts"], {
      cwd: source,
      encoding: "utf8",
    });
    assert.equal(installed.status, 0, installed.stdout + installed.stderr);
    await run(directory, source);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
test("CLI help and errors are readable text with appropriate exit codes", () => {
  const help = cli("--help");
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^buzzodz .*\n\nCommands:/);
  assert.doesNotMatch(help.stdout, /\\n/);
  const error = cli("plugin", "unknown");
  assert.equal(error.status, 1);
  assert.match(error.stderr, /^Error: Unknown command/);
});
test("scaffold builds through pnpm and installs a usable standalone JSX page", async () => {
  await project(async (directory, source) => {
    const built = cli("plugin", "build", source);
    assert.equal(built.status, 0, `${built.stdout}\n${built.stderr}`);
    assert.match(built.stdout, /Built /);
    const module = await import(
      pathToFileURL(path.join(source, "dist/plugin.js"))
    );
    let Page;
    const root = new Context();
    root.provide("pages", {
      register: ({ component }) => {
        Page = component;
      },
    });
    root.provide("react", {
      useState: () => [0, () => {}],
      createElement: (...args) => args,
    });
    await root.plugin({ inject: module.inject, apply: module.apply });
    assert.equal(Page()[0], "section");
    await root.fiber.dispose();
    const installed = cli(
      "--home",
      directory,
      "plugin",
      "install",
      path.join(source, "dist"),
    );
    assert.equal(installed.status, 0, installed.stderr);
    assert.match(installed.stdout, /Installed test.page \(disabled\)/);
    const enabled = cli("--home", directory, "plugin", "enable", "test.page");
    assert.equal(enabled.status, 0, enabled.stderr);
    assert.match(enabled.stdout, /Enabled test.page/);
    const listed = cli("--home", directory, "plugin", "list");
    assert.match(listed.stdout, /test.page\s+enabled\s+external\s+Test page/);
  });
});
test("failed source builds preserve the installed revision", async () => {
  await project(async (directory, source) => {
    assert.equal(cli("plugin", "build", source).status, 0);
    assert.equal(
      cli("--home", directory, "plugin", "install", path.join(source, "dist"))
        .status,
      0,
    );
    const registryPath = path.join(directory, "profiles/default/registry.json");
    const before = await readFile(registryPath, "utf8");
    for (const invalid of [
      "export const wrong = 1;",
      "this is not javascript!",
      'import { Context } from "@deepseek-ai/cordis"; export function apply() { new Context(); }',
      'import * as React from "react"; export function apply(_ctx) { _ctx.pages.register({id: "main", title: "Main", component: () => React.createElement("h1")}); }',
    ]) {
      await writeFile(path.join(source, "src/index.tsx"), invalid);
      const built = cli("plugin", "build", source);
      assert.notEqual(built.status, 0);
      assert.match(built.stderr, /Error: Plugin build failed/);
      assert.equal(await readFile(registryPath, "utf8"), before);
    }
  });
});
