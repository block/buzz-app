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
import { schemeForPath } from "../../scripts/worktree-scheme.mjs";
import { runtimeFixture } from "./agent-runtime-fixture.mjs";

function recipeWithRuntime(failRuntime, name, ...args) {
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
      "worktree-scheme.mjs",
    ])
      copyFileSync(
        new URL(`../../scripts/${file}`, import.meta.url),
        path.join(directory, "scripts", file),
      );
    runtimeFixture(directory);
    if (failRuntime) writeFileSync(path.join(directory, "fail-build"), "");
    // Run the real recipes, adapter and preparation; never open a native app.
    symlinkSync(process.execPath, path.join(directory, "node"));
    writeFileSync(
      path.join(directory, "pnpm"),
      `#!${process.execPath}\nrequire("node:fs").appendFileSync(process.env.BUZZ_TEST_CALLS, JSON.stringify(process.argv.slice(2)) + "\\n");
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
    // The fixture is not a Git checkout, so the launcher hashes its own root for
    // both its port and its scheme; Node resolves that through symlinks when
    // loading the script.
    const root = realpathSync(directory);
    return {
      ...result,
      calls,
      built,
      port: portForPath(root),
      scheme: schemeForPath(root),
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

// The OS scheme the overlay registers. tauri.conf.json keeps the release value, so a
// development launch must replace the whole list rather than add to it.
const deepLink = (scheme) => ({
  plugins: { "deep-link": { desktop: { schemes: [scheme] } } },
});

const overlay = (port, scheme) => ({ ...deepLink(scheme), build: build(port) });

const announced = (port, scheme, overrides = "--port or --scheme") =>
  new RegExp(
    `^Desktop dev server on http://localhost:${port}; deep links open as ${scheme}://` +
      (overrides
        ? ` \\(derived from the worktree path; pass ${overrides} to override\\)`
        : "") +
      "$",
    "m",
  );

test("web preserves the no-argument command", () => {
  assert.deepEqual(launched("web").call, ["dev"]);
});

test("desktop derives a port and an OS scheme from the worktree path when neither is given", () => {
  const { call, port, scheme, stdout } = launched("desktop");
  assert.ok(port >= 10010 && port <= 65009, String(port));
  assert.match(scheme, /^buzz-dev-[0-9a-f]{6}$/);
  assert.deepEqual(call.slice(0, 3), ["tauri", "dev", "--config"]);
  assert.equal(call.length, 4);
  assert.deepEqual(JSON.parse(call[3]), overlay(port, scheme));
  assert.match(stdout, announced(port, scheme));
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
      const { call, scheme, stdout } = launched("desktop", ...args);
      assert.deepEqual(call.slice(0, 3), ["tauri", "dev", "--config"]);
      assert.equal(call.length, 4);
      assert.deepEqual(JSON.parse(call[3]), overlay(Number(value), scheme));
      // Only the scheme is still derived, so only it is offered for override.
      assert.match(stdout, announced(Number(value), scheme, "--scheme"));
    });
  }
}

for (const args of [
  ["--scheme", "buzz"],
  ["--scheme=buzz-dev-local"],
  ["--scheme", "x"],
]) {
  test(`desktop registers ${args.join(" ")} in place of the derived scheme`, () => {
    const chosen = args.at(-1).replace(/^--scheme=/, "");
    const { call, port, scheme, stdout } = launched("desktop", ...args);
    assert.notEqual(chosen, scheme);
    assert.deepEqual(JSON.parse(call[3]), overlay(port, chosen));
    assert.match(stdout, announced(port, chosen, "--port"));
  });
}

test("desktop lets both endpoints be chosen, and then claims nothing is derived", () => {
  const { call, stdout } = launched(
    "desktop",
    "--port",
    "1431",
    "--scheme",
    "buzz",
  );
  assert.deepEqual(JSON.parse(call[3]), overlay(1431, "buzz"));
  assert.match(stdout, announced(1431, "buzz", ""));
});

test("desktop rejects a scheme the OS could not register, before launching Tauri", () => {
  for (const args of [
    ["--scheme"],
    ["--scheme", "--no-watch"],
    ["--scheme="],
    ...[
      "",
      "Buzz",
      "BUZZ",
      "1buzz",
      "-buzz",
      ".buzz",
      "buzz app",
      "buzz_app",
      "buzz:",
      "buzz://",
      "buzz/general",
      "buzz; pnpm injected",
      "$(pnpm injected)",
      "buzz\npnpm injected",
    ].map((value) => ["--scheme", value]),
  ]) {
    const result = recipe("desktop", ...args);
    assert.notEqual(result.status, 0, `Accepted ${JSON.stringify(args)}`);
    assert.match(result.stderr, /--scheme must be a lowercase URL scheme/);
    assert.deepEqual(result.calls, [["install", "--frozen-lockfile"]]);
  }
});

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
  const { call, scheme } = launched(
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
  assert.deepEqual(JSON.parse(call[3]), overlay(1432, scheme));
  assert.deepEqual(call.slice(4), [
    "--config",
    config,
    "--no-watch",
    ...runnerArgs,
  ]);
});

test("desktop derives both endpoints for help and runner-only arguments", () => {
  const help = launched("desktop", "--help");
  assert.deepEqual(help.call.slice(0, 3), ["tauri", "dev", "--config"]);
  assert.deepEqual(JSON.parse(help.call[3]), overlay(help.port, help.scheme));
  assert.deepEqual(help.call.slice(4), ["--help"]);
  assert.doesNotMatch(help.stdout, /Desktop dev server/, "help starts nothing");
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
  assert.deepEqual(
    JSON.parse(runner.call[3]),
    overlay(runner.port, runner.scheme),
  );
  assert.deepEqual(runner.call.slice(4), args);
  assert.match(runner.stdout, announced(runner.port, runner.scheme));
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

test("desktop-bundle builds a debug app bundle carrying the same scheme overlay", () => {
  const { call, scheme, stdout } = launched("desktop-bundle");
  assert.deepEqual(call.slice(0, 6), [
    "tauri",
    "build",
    "--debug",
    "--bundles",
    "app",
    "--config",
  ]);
  assert.equal(call.length, 7);
  assert.deepEqual(JSON.parse(call[6]), deepLink(scheme));
  assert.match(
    stdout,
    new RegExp(
      `^Bundling with deep links as ${scheme}:// \\(derived from the worktree path; pass --scheme to override\\)$`,
      "m",
    ),
  );
});

test("desktop-bundle takes --scheme, keeps a chosen bundle format, and forwards the rest", () => {
  const { call, scheme, stdout } = launched(
    "desktop-bundle",
    "--scheme=buzz",
    "--bundles",
    "dmg",
    "--verbose",
    "--",
    "--features",
    "feature",
  );
  assert.notEqual(scheme, "buzz");
  assert.deepEqual(call, [
    "tauri",
    "build",
    "--debug",
    "--config",
    JSON.stringify(deepLink("buzz")),
    "--bundles",
    "dmg",
    "--verbose",
    "--",
    "--features",
    "feature",
  ]);
  assert.match(stdout, /^Bundling with deep links as buzz:\/\/$/m);
});

test("desktop-bundle rejects an unregistrable scheme before building anything", () => {
  const result = recipe("desktop-bundle", "--scheme", "Buzz");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--scheme must be a lowercase URL scheme/);
  assert.deepEqual(result.calls, [["install", "--frozen-lockfile"]]);
});
