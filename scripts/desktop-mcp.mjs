import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { nativeMcpInstance } from "./desktop-config.mjs";

// Launch this worktree's native MCP test instance; arguments pass to `just desktop`.
const root = fileURLToPath(new URL("../", import.meta.url));
const { identifier, port } = nativeMcpInstance(root);
console.log(
  `Native MCP test instance ${identifier}, bridge base port ${port}. ` +
    "Verify both with get_backend_state before acting.",
);
const result = spawnSync(
  "bin/just",
  [
    "desktop",
    "--features",
    "native-mcp",
    "--config",
    "src-tauri/tauri.native-mcp.conf.json",
    "--config",
    JSON.stringify({ identifier }),
    ...process.argv.slice(2),
  ],
  {
    cwd: root,
    stdio: "inherit",
    // An empty pin disables the legacy broker, which native_mcp.rs requires.
    env: {
      ...process.env,
      BUZZ_NATIVE_MCP_PORT: String(port),
      BUZZ_DEV_VIEWER: "",
    },
  },
);
if (result.error) console.error(result.error.message);
if (result.signal) process.kill(process.pid, result.signal);
process.exit(result.status ?? 1);
