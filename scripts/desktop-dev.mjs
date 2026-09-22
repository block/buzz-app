import { spawnSync } from "node:child_process";

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

if (port !== undefined) {
  // Tauri's own --port controls its static-file server, not our Vite server.
  // Prepend: Tauri treats everything after a bare positional as runner args.
  forwarded.unshift(
    "--config",
    JSON.stringify({
      build: {
        devUrl: `http://localhost:${port}`,
        beforeDevCommand: `pnpm dev:desktop --port ${port}`,
      },
    }),
  );
}
// Runner/application arguments after -- belong to Tauri, including any --port.
forwarded.push(...args.slice(index));
const result = spawnSync("pnpm", ["tauri", "dev", ...forwarded], {
  stdio: "inherit",
});
if (result.error) console.error(result.error.message);
if (result.signal) process.kill(process.pid, result.signal);
process.exit(result.status ?? 1);
