import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { worktreeIcon } from "./worktree-icon.mjs";

const args = process.argv.slice(2);
const forwarded = [];
let port;
let index = 0;
for (; index < args.length && args[index] !== "--"; index++) {
  const arg = args[index];
  if (arg === "--port" || arg.startsWith("--port=")) {
    const value =
      arg === "--port" ? args[++index] : arg.slice("--port=".length);
    if (
      !/^[0-9]+$/.test(value ?? "") ||
      Number(value) < 1 ||
      Number(value) > 65535
    ) {
      console.error("--port must be an integer between 1 and 65535.");
      process.exit(1);
    }
    port = Number(value);
  } else {
    forwarded.push(arg);
  }
}

// Prepare resources before Tauri can compile or observe an already-running Vite.
// Its dev-server readiness timeout must not include a cold runtime build.
if (!forwarded.some((arg) => arg === "--help" || arg === "-h")) {
  const prepared = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./build-agent-runtime.mjs", import.meta.url))],
    { stdio: "inherit" },
  );
  if (prepared.error) console.error(prepared.error.message);
  if (prepared.signal) process.kill(process.pid, prepared.signal);
  if (prepared.status !== 0) process.exit(prepared.status ?? 1);
}
const config = {};
const icon = worktreeIcon(fileURLToPath(new URL("../", import.meta.url)));
if (icon) config.bundle = { icon: [icon] };
if (port !== undefined) {
  // Tauri's own --port controls its static-file server, not our Vite server.
  config.build = {
    devUrl: `http://localhost:${port}`,
    beforeDevCommand: `pnpm dev:desktop --port ${port}`,
  };
}
if (Object.keys(config).length) {
  // Prepend: Tauri treats everything after a bare positional as runner args.
  // Explicit user configs merge afterward and retain precedence.
  forwarded.unshift("--config", JSON.stringify(config));
}
// Runner/application arguments after -- belong to Tauri, including any --port.
forwarded.push(...args.slice(index));
const result = spawnSync("pnpm", ["tauri", "dev", ...forwarded], {
  stdio: "inherit",
});
if (result.error) console.error(result.error.message);
if (result.signal) process.kill(process.pid, result.signal);
process.exit(result.status ?? 1);
