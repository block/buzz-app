import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { portForPath } from "../../scripts/worktree-port.mjs";
import { runtimeFixture } from "./agent-runtime-fixture.mjs";

function recipeWithRuntime(failRuntime, name, ...args) {
  return run({ failRuntime }, name, ...args);
}

function run({ failRuntime = false, env = {}, envFile }, name, ...args) {
  const directory = mkdtempSync(path.join(tmpdir(), "buzz-dev-command-"));
  const callsFile = path.join(directory, "calls.jsonl");
  try {
    copyFileSync(
      new URL("../../justfile", import.meta.url),
      path.join(directory, "justfile"),
    );
    mkdirSync(path.join(directory, "scripts"));
    for (const file of [
      "desktop-build.mjs",
      "desktop-config.mjs",
      "desktop-dev.mjs",
      "worktree-icon.mjs",
      "worktree-port.mjs",
    ])
      copyFileSync(
        new URL(`../../scripts/${file}`, import.meta.url),
        path.join(directory, "scripts", file),
      );
    mkdirSync(path.join(directory, "src/features/communities"), {
      recursive: true,
    });
    copyFileSync(
      new URL("../../src/features/communities/destination.ts", import.meta.url),
      path.join(directory, "src/features/communities/destination.ts"),
    );
    if (envFile !== undefined)
      writeFileSync(path.join(directory, ".env.local"), envFile);
    runtimeFixture(directory);
    if (failRuntime) writeFileSync(path.join(directory, "fail-build"), "");
    // Run the real recipes, adapter and preparation; never open a native app.
    symlinkSync(process.execPath, path.join(directory, "node"));
    writeFileSync(
      path.join(directory, "pnpm"),
      `#!${process.execPath}\nrequire("node:fs").appendFileSync(process.env.BUZZ_TEST_CALLS, JSON.stringify(process.argv.slice(2)) + "\\n");
require("node:fs").writeFileSync(process.env.BUZZ_TEST_CALLS + ".env", JSON.stringify(Object.fromEntries(["BUZZ_RELAY_URL", "BUZZ_DEV_OPEN_RELAY", "BUZZ_DEV_VIEWER"].map((key) => [key, process.env[key]]))));
if (process.argv[2] === "tauri" && process.argv[3] === "dev" && !process.argv.includes("--help") && !process.argv.includes("-h")) {
  if (!require("node:fs").existsSync("src-tauri/resources/agent-runtime/manifest.json")) process.exit(19);
}\n`,
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
          ...env,
        },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    assert.ifError(result.error);
    const calls = existsSync(callsFile)
      ? readFileSync(callsFile, "utf8").trim().split("\n").map(JSON.parse)
      : [];
    const built = existsSync(path.join(directory, "build-calls.jsonl"));
    const launchEnv = existsSync(`${callsFile}.env`)
      ? JSON.parse(readFileSync(`${callsFile}.env`, "utf8"))
      : undefined;
    // The fixture is not a Git checkout, so the launcher hashes its own root for
    // its port; Node resolves that through symlinks when loading the script.
    const root = realpathSync(directory);
    return {
      ...result,
      calls,
      built,
      launchEnv,
      root,
      port: portForPath(root),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function recipe(name, ...args) {
  return recipeWithRuntime(false, name, ...args);
}

test("runtime preparation failure prevents desktop launch, while help does not build", () => {
  const result = recipeWithRuntime(true, "desktop");
  assert.notEqual(result.status, 0);
  assert.equal(result.built, true);
  assert.deepEqual(result.calls, [["install", "--frozen-lockfile"]]);
  const help = recipeWithRuntime(true, "desktop", "--help");
  assert.equal(help.status, 0, help.stderr);
  assert.equal(help.built, false);
});

function launched(target, ...args) {
  const result = recipe(target, ...args);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls[0], ["install", "--frozen-lockfile"]);
  assert.equal(result.calls.length, 2);
  return { ...result, call: result.calls[1] };
}

const build = (port) => ({
  devUrl: `http://localhost:${port}`,
  beforeDevCommand: `pnpm dev:desktop --port ${port}`,
});

const overlay = (port) => ({
  build: build(port),
});

const announced = (port, { derived = true } = {}) =>
  new RegExp(
    `^Desktop dev server on http://localhost:${port}` +
      (derived
        ? " \\(derived from the worktree path; pass --port to override\\)"
        : "") +
      "$",
    "m",
  );

test("web preserves the no-argument command", () => {
  assert.deepEqual(launched("web").call, ["dev"]);
});

test("desktop derives a port from the worktree path and leaves the OS scheme alone", () => {
  const { call, port, stdout } = launched("desktop");
  assert.ok(port >= 10010 && port <= 65009, String(port));
  assert.deepEqual(call.slice(0, 3), ["tauri", "dev", "--config"]);
  assert.equal(call.length, 4);
  const config = JSON.parse(call[3]);
  assert.deepEqual(config, overlay(port));
  assert.match(stdout, announced(port));
  assert.doesNotMatch(stdout, /deep links open as/);
});

test("stock tauri.conf.json starts Vite on its own devUrl port without the launcher", () => {
  // vite.config.ts defaults to the worktree-derived port, so a plain
  // `pnpm tauri dev` only works if the stock config passes its port explicitly.
  const { build: stock } = JSON.parse(
    readFileSync(
      new URL("../../src-tauri/tauri.conf.json", import.meta.url),
      "utf8",
    ),
  );
  const port = Number(new URL(stock.devUrl).port);
  assert.ok(port >= 1 && port <= 65535, stock.devUrl);
  assert.deepEqual(stock, { ...stock, ...build(port) });
});

test("web forwards Vite arguments without reinterpreting or splitting them", () => {
  const args = [
    "--port",
    "1431",
    "--host",
    "127.0.0.1",
    "--base",
    "/two words/",
  ];
  assert.deepEqual(launched("web", ...args).call, ["dev", ...args]);
});

for (const value of ["1431", "1", "65535", "01431"]) {
  for (const args of [["--port", value], [`--port=${value}`]]) {
    test(`desktop translates ${args.join(" ")} to matched endpoints`, () => {
      const { call, stdout } = launched("desktop", ...args);
      assert.deepEqual(call.slice(0, 3), ["tauri", "dev", "--config"]);
      assert.equal(call.length, 4);
      assert.deepEqual(JSON.parse(call[3]), overlay(Number(value)));
      // Nothing is derived, so nothing is offered for override.
      assert.match(stdout, announced(Number(value), { derived: false }));
    });
  }
}

for (const args of [["--scheme", "buzz-dev"], ["--scheme=buzz-dev"]]) {
  test(`launchers forward unsupported ${args.join(" ")} without overlaying a scheme`, () => {
    const desktop = launched("desktop", ...args);
    assert.deepEqual(JSON.parse(desktop.call[3]), overlay(desktop.port));
    assert.deepEqual(desktop.call.slice(4), args);
    assert.match(desktop.stdout, announced(desktop.port));
    const bundle = launched("desktop-bundle", ...args);
    assert.deepEqual(bundle.call, [
      "tauri",
      "build",
      "--debug",
      "--bundles",
      "app",
      ...args,
    ]);
    assert.doesNotMatch(bundle.stdout, /Bundling with deep links/);
  });
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
  const { call } = launched(
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
  assert.deepEqual(JSON.parse(call[3]), overlay(1432));
  assert.deepEqual(call.slice(4), [
    "--config",
    config,
    "--no-watch",
    ...runnerArgs,
  ]);
});

test("desktop derives the port for help and runner-only arguments", () => {
  const help = launched("desktop", "--help");
  assert.deepEqual(help.call.slice(0, 3), ["tauri", "dev", "--config"]);
  assert.deepEqual(JSON.parse(help.call[3]), overlay(help.port));
  assert.deepEqual(help.call.slice(4), ["--help"]);
  assert.doesNotMatch(help.stdout, /Desktop dev server/, "help starts nothing");
  // Arguments after -- belong to the application, not to the launcher.
  const args = [
    "--no-watch",
    "--",
    "--port",
    "application-port",
    "--scheme",
    "x",
  ];
  const runner = launched("desktop", ...args);
  assert.deepEqual(runner.call.slice(0, 3), ["tauri", "dev", "--config"]);
  assert.deepEqual(JSON.parse(runner.call[3]), overlay(runner.port));
  assert.deepEqual(runner.call.slice(4), args);
  assert.match(runner.stdout, announced(runner.port));
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
  const { call } = launched(
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

test("desktop-bundle builds a debug app bundle with no overlay by default", () => {
  // The fixture is not a linked worktree, so it has no icon to overlay.
  const { call, stdout } = launched("desktop-bundle");
  assert.deepEqual(call, ["tauri", "build", "--debug", "--bundles", "app"]);
  assert.doesNotMatch(stdout, /Bundling with deep links/);
});

test("desktop-bundle keeps a chosen bundle format and forwards the rest", () => {
  const { call } = launched(
    "desktop-bundle",
    "--bundles",
    "dmg",
    "--verbose",
    "--",
    "--features",
    "feature",
  );
  assert.deepEqual(call, [
    "tauri",
    "build",
    "--debug",
    "--bundles",
    "dmg",
    "--verbose",
    "--",
    "--features",
    "feature",
  ]);
});

test("desktop-bundle preserves no-bundle and ignores bundle flags after --", () => {
  assert.deepEqual(launched("desktop-bundle", "--no-bundle").call, [
    "tauri",
    "build",
    "--debug",
    "--no-bundle",
  ]);
  assert.deepEqual(launched("desktop-bundle", "--", "--bundles", "dmg").call, [
    "tauri",
    "build",
    "--debug",
    "--bundles",
    "app",
    "--",
    "--bundles",
    "dmg",
  ]);
});

function relayLaunch(options, name, ...args) {
  const result = run(options, name, ...args);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.calls.length, 2);
  return { ...result, config: JSON.parse(result.calls[1][3]) };
}

const staging = { BUZZ_STAGING_RELAY_URL: undefined, BUZZ_DEV_VIEWER: "" };

test("staging and production open their relay on a port derived from the worktree and relay", () => {
  for (const [name, key] of [
    ["staging", "BUZZ_STAGING_RELAY_URL"],
    ["production", "BUZZ_PRODUCTION_RELAY_URL"],
  ]) {
    const { config, launchEnv, root, port, stdout } = relayLaunch(
      { env: { [key]: "wss://Relay.example.com/", BUZZ_DEV_VIEWER: "" } },
      name,
    );
    const relayPort = portForPath(`${root}\nhttps://relay.example.com`);
    assert.notEqual(relayPort, port);
    assert.deepEqual(config, overlay(relayPort));
    assert.deepEqual(launchEnv, {
      BUZZ_RELAY_URL: "wss://Relay.example.com/",
      BUZZ_DEV_OPEN_RELAY: "1",
      BUZZ_DEV_VIEWER: "",
    });
    assert.match(stdout, /and https:\/\/relay\.example\.com; pass --port/);
  }
  const explicit = relayLaunch(
    { env: { BUZZ_STAGING_RELAY_URL: "wss://relay.example.com" } },
    "staging",
    "--port",
    "1431",
  );
  assert.deepEqual(explicit.config, overlay(1431));
});

test("staging reads .env.local when the shell leaves the key unset, and the shell wins", () => {
  const envFile = "BUZZ_STAGING_RELAY_URL=wss://file.example.com\n";
  const fromFile = relayLaunch({ env: staging, envFile }, "staging");
  assert.equal(fromFile.launchEnv.BUZZ_RELAY_URL, "wss://file.example.com");
  const fromShell = relayLaunch(
    {
      env: { ...staging, BUZZ_STAGING_RELAY_URL: "wss://shell.example.com" },
      envFile,
    },
    "staging",
  );
  assert.equal(fromShell.launchEnv.BUZZ_RELAY_URL, "wss://shell.example.com");
});

test("staging leaves a set viewer pin untouched so the broker serves it", () => {
  const viewer = "a".repeat(64);
  const { launchEnv } = relayLaunch(
    {
      env: {
        BUZZ_STAGING_RELAY_URL: "wss://relay.example.com",
        BUZZ_DEV_VIEWER: viewer,
      },
    },
    "staging",
  );
  assert.equal(launchEnv.BUZZ_DEV_VIEWER, viewer);
});

test("staging stops before preparing or launching when the relay is missing or invalid", () => {
  for (const [options, message] of [
    [
      { env: staging },
      /Set BUZZ_STAGING_RELAY_URL in your shell or \.env\.local to the relay URL/,
    ],
    [
      { env: staging, envFile: "BUZZ_STAGING_RELAY_URL=\n" },
      /Set BUZZ_STAGING_RELAY_URL/,
    ],
    [
      { env: { BUZZ_STAGING_RELAY_URL: "ws://relay.example.com/path" } },
      /BUZZ_STAGING_RELAY_URL: Enter a wss:\/\//,
    ],
  ]) {
    const result = run(options, "staging");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, message);
    assert.equal(result.built, false);
    assert.deepEqual(result.calls, [["install", "--frozen-lockfile"]]);
  }
});
