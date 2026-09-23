#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const trace = process.env.BUZZ_PROFILE_TRACE;
const separator = process.argv.indexOf("--", 2);
const runnerArgs = process.argv.slice(2, separator < 0 ? undefined : separator);
const appArgs = separator < 0 ? [] : process.argv.slice(separator + 1);
if (!trace || runnerArgs[0] !== "run") {
  console.error(
    "Desktop profiler runner requires a Cargo run command and BUZZ_PROFILE_TRACE.",
  );
  process.exit(1);
}

const build = spawnSync("cargo", ["build", ...runnerArgs.slice(1)], {
  stdio: "inherit",
});
if (build.error) console.error(build.error.message);
if (build.signal) process.kill(process.pid, build.signal);
if (build.status !== 0) process.exit(build.status ?? 1);

const metadata = spawnSync(
  "cargo",
  ["metadata", "--no-deps", "--format-version", "1"],
  { encoding: "utf8" },
);
if (metadata.error) console.error(metadata.error.message);
if (metadata.signal) process.kill(process.pid, metadata.signal);
if (metadata.status !== 0) process.exit(metadata.status ?? 1);
const { target_directory: targetDirectory, packages } = JSON.parse(
  metadata.stdout,
);
const packageName = packages.find(
  (entry) => entry.manifest_path === path.resolve("Cargo.toml"),
)?.name;
if (!packageName) {
  console.error("Could not resolve the desktop Cargo package.");
  process.exit(1);
}
const target = runnerArgs.includes("--release") ? "release" : "debug";
const executable = path.join(targetDirectory, target, packageName);
const result = spawnSync(
  "xcrun",
  [
    "xctrace",
    "record",
    "--template",
    "Time Profiler",
    "--output",
    trace,
    "--launch",
    "--",
    executable,
    ...appArgs,
  ],
  { stdio: "inherit" },
);
if (result.error) console.error(result.error.message);
if (result.signal) process.kill(process.pid, result.signal);
process.exit(result.status ?? 1);
