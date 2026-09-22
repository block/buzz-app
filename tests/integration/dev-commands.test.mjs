import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

function recipe(name, ...args) {
  const directory = mkdtempSync(path.join(tmpdir(), "buzz-dev-command-"));
  const callsFile = path.join(directory, "calls.jsonl");
  try {
    copyFileSync(
      new URL("../../justfile", import.meta.url),
      path.join(directory, "justfile"),
    );
    mkdirSync(path.join(directory, "scripts"));
    copyFileSync(
      new URL("../../scripts/desktop-dev.mjs", import.meta.url),
      path.join(directory, "scripts/desktop-dev.mjs"),
    );
    // Run the real recipes and adapter, recording only the package-manager boundary.
    symlinkSync(process.execPath, path.join(directory, "node"));
    writeFileSync(
      path.join(directory, "pnpm"),
      `#!${process.execPath}\nrequire("node:fs").appendFileSync(process.env.BUZZ_TEST_CALLS, JSON.stringify(process.argv.slice(2)) + "\\n");\n`,
      { mode: 0o755 },
    );
    // Set PATH inside the recipe shell: Hermit proxies restore their own PATH.
    const result = spawnSync(
      "just",
      [
        "--shell",
        "env",
        "--shell-arg",
        `PATH=${directory}${path.delimiter}${process.env.PATH}`,
        "--shell-arg",
        "sh",
        "--shell-arg",
        "-cu",
        "--justfile",
        "justfile",
        name,
        ...args,
      ],
      {
        cwd: directory,
        env: {
          ...process.env,
          BUZZ_TEST_CALLS: callsFile,
        },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    assert.ifError(result.error);
    const calls = existsSync(callsFile)
      ? readFileSync(callsFile, "utf8").trim().split("\n").map(JSON.parse)
      : [];
    return { ...result, calls };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function launched(target, ...args) {
  const result = recipe(target, ...args);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls[0], ["install", "--frozen-lockfile"]);
  assert.equal(result.calls.length, 2);
  return result.calls[1];
}

for (const target of ["web", "desktop"]) {
  test(`${target} preserves the no-argument command`, () => {
    assert.deepEqual(
      launched(target),
      target === "web" ? ["dev"] : ["tauri", "dev"],
    );
  });
}

test("web forwards Vite arguments without reinterpreting or splitting them", () => {
  const args = [
    "--port",
    "1431",
    "--host",
    "127.0.0.1",
    "--base",
    "/two words/",
  ];
  assert.deepEqual(launched("web", ...args), ["dev", ...args]);
});

for (const value of ["1431", "1", "65535", "01431"]) {
  for (const args of [["--port", value], [`--port=${value}`]]) {
    test(`desktop translates ${args.join(" ")} to matched endpoints`, () => {
      const call = launched("desktop", ...args);
      assert.deepEqual(call.slice(0, 3), ["tauri", "dev", "--config"]);
      assert.equal(call.length, 4);
      assert.deepEqual(JSON.parse(call[3]), {
        build: {
          devUrl: `http://localhost:${Number(value)}`,
          beforeDevCommand: `pnpm dev:desktop --port ${Number(value)}`,
        },
      });
    });
  }
}

test("desktop prepends port config and preserves user config and arguments", () => {
  const config =
    '{"productName":"Two words","build":{"devUrl":"http://localhost:9999"}}';
  const runnerArgs = [
    "--",
    "--features",
    "feature",
    "--",
    "--port",
    "app-port",
    "$(pnpm injected)",
  ];
  const call = launched(
    "desktop",
    "--port",
    "1431",
    "--config",
    config,
    "--no-watch",
    "--port=1432",
    ...runnerArgs,
  );
  assert.deepEqual(call.slice(0, 3), ["tauri", "dev", "--config"]);
  assert.equal(JSON.parse(call[3]).build.devUrl, "http://localhost:1432");
  assert.equal(
    JSON.parse(call[3]).build.beforeDevCommand,
    "pnpm dev:desktop --port 1432",
  );
  assert.deepEqual(call.slice(4), [
    "--config",
    config,
    "--no-watch",
    ...runnerArgs,
  ]);
});

test("desktop forwards help and runner arguments without a port override", () => {
  assert.deepEqual(launched("desktop", "--help"), ["tauri", "dev", "--help"]);
  const args = ["--no-watch", "--", "--port", "application-port"];
  assert.deepEqual(launched("desktop", ...args), ["tauri", "dev", ...args]);
});

test("desktop rejects invalid or missing ports before launching Tauri", () => {
  for (const args of [
    ["--port"],
    ["--port", "--no-watch"],
    ["--port="],
    ...[
      "",
      "0",
      "65536",
      "999999999999999999999999999999999999999999999",
      "not-a-port",
      "1431.5",
      " 1431",
      "1431; pnpm injected",
      "1431'",
      '1431"',
      "$(pnpm injected)",
      "1431\npnpm injected",
    ].map((value) => ["--port", value]),
  ]) {
    const result = recipe("desktop", ...args);
    assert.notEqual(result.status, 0, `Accepted ${JSON.stringify(args)}`);
    assert.match(
      result.stderr,
      /--port must be an integer between 1 and 65535/,
    );
    assert.deepEqual(result.calls, [["install", "--frozen-lockfile"]]);
  }
});

test("desktop config precedes Tauri's implicit runner-argument boundary", () => {
  const call = launched(
    "desktop",
    "--port",
    "1431",
    "--runner",
    "echo",
    "hello",
  );
  assert.deepEqual(call.slice(0, 3), ["tauri", "dev", "--config"]);
  assert.equal(JSON.parse(call[3]).build.devUrl, "http://localhost:1431");
  assert.deepEqual(call.slice(4), ["--runner", "echo", "hello"]);
});
