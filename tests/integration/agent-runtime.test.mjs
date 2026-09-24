import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runtimeFixture } from "./agent-runtime-fixture.mjs";

test("native library and bundled tools pin the same immutable source", () => {
  const spec = JSON.parse(
    readFileSync(
      new URL("../../runtime/agent-runtime.json", import.meta.url),
      "utf8",
    ),
  );
  // Let Cargo parse its own manifest rather than duplicating TOML parsing here.
  const metadata = spawnSync(
    fileURLToPath(new URL("../../bin/cargo", import.meta.url)),
    ["metadata", "--format-version=1", "--no-deps", "--locked", "--offline"],
    {
      cwd: new URL("../../", import.meta.url),
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  assert.ifError(metadata.error);
  assert.equal(metadata.status, 0, metadata.stderr);
  const app = JSON.parse(metadata.stdout).packages.find(
    (pkg) => pkg.name === "buzz-foundation",
  );
  assert.ok(app, "native app package must be present");
  const agent = app.dependencies.find(
    (dependency) => dependency.name === "buzz-agent",
  );
  assert.ok(agent, "native app must declare its buzz-agent dependency");
  assert.match(spec.revision, /^[0-9a-f]{40}$/);
  assert.equal(
    agent.source,
    `git+${spec.repository}?rev=${spec.revision}`,
    "Update src-tauri/Cargo.toml and runtime/agent-runtime.json together",
  );
});

test("runtime preparation builds missing resources, reuses verified files, and repairs stale or corrupt bundles", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "buzz-agent-runtime-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  runtimeFixture(directory);
  const run = () => {
    const result = spawnSync(
      process.execPath,
      ["scripts/build-agent-runtime.mjs"],
      {
        cwd: directory,
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const bundle = path.join(directory, "src-tauri/resources/agent-runtime");
  const manifestPath = path.join(bundle, "manifest.json");
  const count = () =>
    readFileSync(path.join(directory, "build-calls.jsonl"), "utf8")
      .trim()
      .split("\n").length;
  assert.match(run(), /Verified inputs staged/);
  assert.equal(count(), 1);
  assert.match(run(), /Agent runtime ready/);
  assert.equal(count(), 1, "warm preparation must not invoke Cargo");
  const filename =
    process.platform === "win32" ? "buzz-agent.exe" : "buzz-agent";
  const binary = path.join(bundle, filename);
  for (const mutation of [
    () => writeFileSync(binary, "corrupt"),
    () => rmSync(binary),
    () => writeFileSync(manifestPath, "not json"),
    () =>
      writeFileSync(
        manifestPath,
        " ".repeat(16385) + readFileSync(manifestPath, "utf8"),
      ),
    () => {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      manifest.unexpected = true;
      writeFileSync(manifestPath, JSON.stringify(manifest));
    },
    ...["revision", "target", "version"].map((key) => () => {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      manifest[key] = "outdated";
      writeFileSync(manifestPath, JSON.stringify(manifest));
    }),
    ...(process.platform === "win32" ? [] : [() => chmodSync(binary, 0o644)]),
  ]) {
    const before = count();
    mutation();
    assert.match(run(), /Verified inputs staged/);
    assert.equal(count(), before + 1);
    assert.ok(existsSync(binary));
    assert.match(run(), /Agent runtime ready/);
    assert.equal(count(), before + 1);
  }
});

test("packaged desktop build prepares runtime before frontend compilation", () => {
  const config = JSON.parse(
    readFileSync(
      new URL("../../src-tauri/tauri.conf.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(
    config.build.beforeBuildCommand,
    "node scripts/build-agent-runtime.mjs && pnpm build",
  );
});
