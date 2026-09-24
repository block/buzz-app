#!/usr/bin/env node
import { spawnSync } from "node:child_process";
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

const build = spawnSync(
  "cargo",
  ["build", "--message-format=json-render-diagnostics", ...runnerArgs.slice(1)],
  { encoding: "utf8" },
);
if (build.stderr) process.stderr.write(build.stderr);
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
const rootPackage = JSON.parse(metadata.stdout).packages.find(
  ({ manifest_path: manifestPath }) =>
    manifestPath === `${process.cwd()}/Cargo.toml`,
);
if (!rootPackage) {
  console.error("Could not resolve the desktop Cargo package.");
  process.exit(1);
}

let executable;
for (const line of build.stdout.split("\n")) {
  if (!line.startsWith("{")) continue;
  const message = JSON.parse(line);
  if (
    message.reason === "compiler-artifact" &&
    message.executable &&
    message.target?.kind?.includes("bin") &&
    rootPackage.targets.some(({ name }) => name === message.target.name)
  )
    executable = message.executable;
}
if (!executable) {
  console.error("Cargo did not report a desktop executable.");
  process.exit(1);
}
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
