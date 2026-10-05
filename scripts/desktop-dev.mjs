import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { relayOrigin } from "../src/features/communities/destination.ts";
import { desktopOverlay, options } from "./desktop-config.mjs";
import { portForPath, worktreePort, worktreeRoot } from "./worktree-port.mjs";

const args = process.argv.slice(2);
const { values, forwarded, rest } = options(args, ["port", "relay-env"]);
if (
  values.port !== undefined &&
  (!/^[0-9]+$/.test(values.port) ||
    Number(values.port) < 1 ||
    Number(values.port) > 65535)
) {
  console.error("--port must be an integer between 1 and 65535.");
  process.exit(1);
}
const port = values.port === undefined ? undefined : Number(values.port);
const root = fileURLToPath(new URL("../", import.meta.url));

// --relay-env KEY opens the relay named by KEY (shell first, then .env.local)
// on its own port, so each relay keeps separate saved state. The viewer pin is
// left alone: BUZZ_DEV_VIEWER selects the broker, otherwise the native signer.
let relay;
const relayKey = values["relay-env"];
if (relayKey !== undefined) {
  const file = `${root}.env.local`;
  const url = (
    process.env[relayKey] ??
    (existsSync(file) ? parseEnv(readFileSync(file, "utf8"))[relayKey] : "")
  )?.trim();
  if (!url) {
    console.error(
      `Set ${relayKey} in your shell or .env.local to the relay URL.`,
    );
    process.exit(1);
  }
  try {
    relay = relayOrigin(url);
  } catch (error) {
    console.error(`${relayKey}: ${error.message}`);
    process.exit(1);
  }
  process.env.BUZZ_RELAY_URL = url;
  process.env.BUZZ_DEV_OPEN_RELAY = "1";
}

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
const config = desktopOverlay(root);
// Tauri's own --port controls its static-file server, not our Vite server.
// Without --port, each worktree derives its own stable port; vite.config.ts
// derives the same one, so devUrl and Vite's strict port cannot disagree.
const devPort =
  port ??
  (relay ? portForPath(`${worktreeRoot(root)}\n${relay}`) : worktreePort(root));
config.build = {
  devUrl: `http://localhost:${devPort}`,
  beforeDevCommand: `pnpm dev:desktop --port ${devPort}`,
};
if (!help)
  console.log(
    `Desktop dev server on ${config.build.devUrl}` +
      (port === undefined
        ? ` (derived from the worktree path${relay ? ` and ${relay}` : ""}; pass --port to override)`
        : ""),
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
