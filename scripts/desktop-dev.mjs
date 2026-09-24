import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { desktopOverlay, isScheme, options } from "./desktop-config.mjs";
import { worktreePort } from "./worktree-port.mjs";
import { worktreeScheme } from "./worktree-scheme.mjs";

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
  console.error(
    "--scheme must be a lowercase URL scheme, such as buzz or buzz-dev-3fa9c1.",
  );
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
// Without --scheme, each worktree claims its own OS scheme rather than the released
// `buzz`, so links can be tested on a machine that also has Buzz installed.
const scheme = values.scheme ?? worktreeScheme(root);
const config = desktopOverlay(root, scheme);
// Tauri's own --port controls its static-file server, not our Vite server.
// Without --port, each worktree derives its own stable port; vite.config.ts
// derives the same one, so devUrl and Vite's strict port cannot disagree.
const devPort = port ?? worktreePort(root);
config.build = {
  devUrl: `http://localhost:${devPort}`,
  beforeDevCommand: `pnpm dev:desktop --port ${devPort}`,
};
if (!help) {
  const overrides = [
    port === undefined ? "--port" : null,
    values.scheme === undefined ? "--scheme" : null,
  ].filter(Boolean);
  console.log(
    `Desktop dev server on ${config.build.devUrl}; deep links open as ${scheme}://` +
      (overrides.length
        ? ` (derived from the worktree path; pass ${overrides.join(" or ")} to override)`
        : ""),
  );
}
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
