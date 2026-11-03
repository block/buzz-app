import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { nativeMcpInstance } from "./desktop-config.mjs";

// The MCP client .mcp.json registers, connected through a loopback relay to
// this worktree's test instance. The client never checks which app it reached,
// scans nearby ports when a connection fails, and reconnects on its own. The
// relay always accepts it, so it never scans, and forwards each command only
// over a connection on which the app proved its identifier, debug build and
// main window. A refused command fails, and the next one checks again.
const root = fileURLToPath(new URL("../", import.meta.url));
const { identifier, port } = nativeMcpInstance(root);
// The bridge takes the first free port of the 100 from its base.
const last = port + 99;
const refusal = `No debug test instance ${identifier} with a main window on ports ${port}-${last}. Launch it with bin/node scripts/desktop-mcp.mjs.`;

function openTestInstance(candidate) {
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${candidate}`);
    const timer = setTimeout(() => finish(false), 2000);
    function finish(matches) {
      clearTimeout(timer);
      socket.removeAllListeners("message");
      if (!matches) socket.terminate();
      resolve(matches && socket);
    }
    socket.on("error", () => finish(false));
    socket.on("open", () =>
      socket.send(
        JSON.stringify({
          id: "buzz-target",
          command: "invoke_tauri",
          args: { command: "plugin:mcp-bridge|get_backend_state", args: {} },
        }),
      ),
    );
    socket.on("message", (data) => {
      let response;
      try {
        response = JSON.parse(data);
      } catch {
        return finish(false);
      }
      if (response.id !== "buzz-target") return;
      const state = response.success ? response.data : undefined;
      finish(
        state?.app?.identifier === identifier &&
          state.environment?.debug === true &&
          state.windows?.some((window) => window.label === "main"),
      );
    });
  });
}

async function connectTestInstance() {
  for (let candidate = port; candidate <= last; candidate++) {
    // The relay's own ephemeral port can fall in the range; probing it would
    // start another scan through the relay, without end.
    if (candidate === relay.address().port) continue;
    const socket = await openTestInstance(candidate);
    if (socket) return socket;
  }
}

// Like the bridge, refuse browser pages, which always send an Origin.
const relay = new WebSocketServer({
  host: "127.0.0.1",
  port: 0,
  verifyClient: ({ req }) =>
    !req.headers.origin && !req.headers["sec-websocket-origin"],
});
relay.on("connection", (client) => {
  let upstream;
  let queue = Promise.resolve();
  // Commands run in order; a closed or replaced app fails the readyState check,
  // so the next command finds and checks the app again.
  client.on("message", (data) => {
    const text = data.toString();
    queue = queue
      .then(async () => {
        if (upstream?.readyState !== WebSocket.OPEN) {
          upstream = await connectTestInstance();
          upstream?.on("message", (reply) => client.send(reply.toString()));
        }
        if (upstream) return upstream.send(text);
        const { id } = JSON.parse(text);
        client.send(JSON.stringify({ id, success: false, error: refusal }));
      })
      .catch(() => {});
  });
  client.on("close", () => queue.then(() => upstream?.close()));
  client.on("error", () => {});
});

relay.on("listening", () => {
  const child = spawn(
    process.execPath,
    ["node_modules/@hypothesi/tauri-mcp-server/dist/index.js"],
    {
      cwd: root,
      stdio: "inherit",
      env: {
        ...process.env,
        MCP_BRIDGE_HOST: "127.0.0.1",
        MCP_BRIDGE_PORT: String(relay.address().port),
      },
    },
  );
  // MCP clients stop a stdio server by signalling only its process; pass the
  // signal on so the server, and any bridge session it holds, does not outlive it.
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const signal of signals) process.on(signal, () => child.kill(signal));
  child.on("error", (error) => {
    console.error(error.message);
    process.exit(1);
  });
  child.on("exit", (status, signal) => {
    if (!signal) process.exit(status ?? 1);
    for (const name of signals) process.removeAllListeners(name);
    process.kill(process.pid, signal);
  });
});
