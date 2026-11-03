import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { nativeMcpInstance } from "./desktop-config.mjs";

// The MCP client .mcp.json registers, pointed at this worktree's bridge.
const root = fileURLToPath(new URL("../", import.meta.url));
const child = spawn("bin/npx", ["-y", "@hypothesi/tauri-mcp-server@0.13.1"], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    MCP_BRIDGE_HOST: "127.0.0.1",
    MCP_BRIDGE_PORT: String(nativeMcpInstance(root).port),
  },
});
// MCP clients stop a stdio server by signalling only its process; pass the
// signal on so the server, and any bridge session it holds, does not outlive it.
// npx relays only SIGINT and SIGTERM, so a hangup is passed on as SIGTERM.
const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
for (const signal of signals)
  process.on(signal, () =>
    child.kill(signal === "SIGHUP" ? "SIGTERM" : signal),
  );
child.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});
child.on("exit", (status, signal) => {
  if (!signal) process.exit(status ?? 1);
  for (const name of signals) process.removeAllListeners(name);
  process.kill(process.pid, signal);
});
