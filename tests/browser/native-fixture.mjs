import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { accessSync, constants, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./run-command.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
/** CI consumes a same-run immutable build; each test still supplies its own home. */
export function verifiedFixture(directory, revision) {
  assert.equal(
    readFileSync(join(directory, "revision"), "utf8").trim(),
    revision,
  );
  const binary = join(directory, "fixture-bridge");
  const checksum = readFileSync(join(directory, "SHA256SUMS"), "utf8").trim();
  assert.match(checksum, /^[a-f0-9]{64} {2}fixture-bridge$/);
  assert.equal(
    createHash("sha256").update(readFileSync(binary)).digest("hex"),
    checksum.slice(0, 64),
  );
  accessSync(binary, constants.X_OK);
  return binary;
}
export function nativeFixture() {
  const directory = process.env.BUZZ_BROWSER_FIXTURE_DIR;
  if (directory)
    return verifiedFixture(
      resolve(root, directory),
      run("git", ["rev-parse", "HEAD"]).trim(),
    );
  assert.ok(
    !process.env.CI,
    "CI must supply its verified native fixture; no download or build fallback",
  );
  run("cargo", [
    "build",
    "--locked",
    "-p",
    "buzzodz-plugins",
    "--example",
    "fixture-bridge",
  ]);
  const metadata = JSON.parse(
    run("cargo", ["metadata", "--no-deps", "--format-version=1"]),
  );
  return join(metadata.target_directory, "debug/examples/fixture-bridge");
}

/** Test-owned session: real Rust Manager, synthetic picker/IPC, no default home. */
export function nativeFixtureSession(home) {
  const child = spawn(nativeFixture(), [home, "session"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = [];
  let failure;
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (text) => {
    stderr += text;
  });
  function fail(error) {
    failure = error;
    for (const request of pending.splice(0)) request.reject(error);
  }
  child.on("error", fail);
  child.stdin.on("error", fail);
  createInterface({ input: child.stdout }).on("line", (line) => {
    const request = pending.shift();
    if (!request)
      return fail(new Error(`Unexpected native fixture response: ${line}`));
    try {
      const response = JSON.parse(line);
      if ("error" in response) request.reject(new Error(response.error));
      else request.resolve(response.ok);
    } catch (error) {
      request.reject(error);
      fail(error);
    }
  });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    // Drain stdout before resolving/rejecting the session's final requests.
    child.once("close", (code, signal) => {
      const error = new Error(
        `Native fixture exited (${code ?? signal}): ${stderr}`,
      );
      if (pending.length) fail(error);
      failure ??= error;
      if (code === 0) resolve();
      else reject(error);
    });
  });
  // Surface early exits through request/close without an unhandled rejection.
  void exited.catch(() => {});
  return {
    request(command, args = {}) {
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => {
        pending.push({ resolve, reject });
        child.stdin.write(`${JSON.stringify({ command, args })}\n`);
      });
    },
    async close() {
      child.stdin.end();
      await exited;
    },
  };
}
