import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { desktopOverlay, isScheme, options } from "./desktop-config.mjs";
import { worktreePort } from "./worktree-port.mjs";

const args = process.argv.slice(2);
const { values, forwarded, rest } = options(args, ["port", "scheme"]);
if (
  values.port !== undefined &&
  (!/^[0-9]+$/.test(values.port) ||
    Number(values.port) < 1 ||
    Number(values.port) > 65535)
) {
  console.error("--port must be an integer between 1 and 65535.");
  process.exit(1);
}
if (values.scheme !== undefined && !isScheme(values.scheme)) {
  console.error("--scheme must be a lowercase URL scheme, such as buzz-dev.");
  process.exit(1);
}
const port = values.port === undefined ? undefined : Number(values.port);

const help = forwarded.some((arg) => arg === "--help" || arg === "-h");
// Prepare resources before Tauri can compile or observe an already-running Vite.
// Its dev-server readiness timeout must not include a cold runtime build.
if (!help) {
  const prepared = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./build-agent-runtime.mjs", import.meta.url))],
    { stdio: "inherit" },
  );
  if (prepared.error) console.error(prepared.error.message);
  if (prepared.signal) process.kill(process.pid, prepared.signal);
  if (prepared.status !== 0) process.exit(prepared.status ?? 1);
}
const root = fileURLToPath(new URL("../", import.meta.url));
// Only an explicit --scheme touches the OS scheme. Without it this build registers
// the `buzz` that tauri.conf.json declares, as a release build does; pass one when
// an installed Buzz on this machine would otherwise receive the test links.
const config = desktopOverlay(root, values.scheme);
// Tauri's own --port controls its static-file server, not our Vite server.
// Without --port, each worktree derives its own stable port; vite.config.ts
// derives the same one, so devUrl and Vite's strict port cannot disagree.
const devPort = port ?? worktreePort(root);
config.build = {
  devUrl: `http://localhost:${devPort}`,
  beforeDevCommand: `pnpm dev:desktop --port ${devPort}`,
};
if (!help)
  console.log(
    `Desktop dev server on ${config.build.devUrl}` +
      (port === undefined
        ? " (derived from the worktree path; pass --port to override)"
        : "") +
      (values.scheme === undefined
        ? ""
        : `; deep links open as ${values.scheme}://`),
  );
// Prepend: Tauri treats everything after a bare positional as runner args.
// Explicit user configs merge afterward and retain precedence.
forwarded.unshift("--config", JSON.stringify(config));
// Runner/application arguments after -- belong to Tauri, including any --port.
forwarded.push(...rest);
const result = spawnSync("pnpm", ["tauri", "dev", ...forwarded], {
  stdio: "inherit",
});
if (result.error) console.error(result.error.message);
if (result.signal) process.kill(process.pid, result.signal);
process.exit(result.status ?? 1);
