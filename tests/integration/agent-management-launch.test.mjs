import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("management launcher preserves only explicit build defaults and never enables preview or broker", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-launch-contract-"));
  try {
    await mkdir(join(root, "scripts"));
    await mkdir(join(root, "bin"));
    await copyFile(
      new URL("../../scripts/agent-control-management.mjs", import.meta.url),
      join(root, "scripts/agent-control-management.mjs"),
    );
    const capture = join(root, "capture.json");
    // Fake only the process sink. Run the unchanged launcher in a separate Node
    // process; no native app/dev server or OS credential adapter can be launched.
    await writeFile(
      join(root, "bin/pnpm"),
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify({args:process.argv.slice(2),env:process.env}));\n`,
    );
    await chmod(join(root, "bin/pnpm"), 0o755);
    const env = {
      PATH: process.env.PATH,
      HOME: root,
      BUZZ_PRIVATE_KEY: "synthetic-secret",
      NOSTR_PRIVATE_KEY: "synthetic-secret",
      BUZZ_DEV_VIEWER: "synthetic-viewer",
      BUZZ_AGENT_CONTROL_HOME: "/do-not-use",
      BUZZ_AGENT_CONTROL_PREVIEW: "1",
      BUZZODZ_HOME: "/do-not-use",
      VITE_BUZZ_LIVE: "1",
      DATABRICKS_TOKEN: "synthetic-token",
      BUZZ_BUILD_AGENT_ENV: '{"DATABRICKS_HOST":"https://workspace.example"}',
    };
    const script = join(root, "scripts/agent-control-management.mjs");
    const result = spawnSync(process.execPath, [script], {
      env,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const actual = JSON.parse(await readFile(capture, "utf8"));
    assert.deepEqual(actual.args.slice(0, 5), [
      "exec",
      "tauri",
      "dev",
      "--no-watch",
      "--config",
    ]);
    const config = JSON.parse(actual.args[5]);
    assert.equal(config.identifier, undefined);
    assert.equal(
      config.build.beforeDevCommand,
      "pnpm exec vite --config dev/agent-control-preview.vite.mjs",
    );
    assert.equal(config.build.devUrl, "http://127.0.0.1:1445");
    const passed = Object.keys(actual.env).filter((key) =>
      /^(BUZZ_|BUZZODZ_|NOSTR_|VITE_|DATABRICKS_)/.test(key),
    );
    assert.deepEqual(passed, ["BUZZ_BUILD_AGENT_ENV"]);
    assert.equal(actual.env.BUZZ_BUILD_AGENT_ENV, env.BUZZ_BUILD_AGENT_ENV);
    await rm(capture);
    assert.equal(
      spawnSync(process.execPath, [script, "--prepare-only"], { env }).status,
      0,
    );
    await assert.rejects(readFile(capture), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
