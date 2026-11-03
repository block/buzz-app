import { afterEach, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { startRelay } from "./native-mcp-client.mjs";

const identifier = "dev.local.buzz.foundation.nexus-test-0123456789ab";
const other = "dev.local.buzz.foundation.nexus-test-ffffffffffff";
const instance = {
  app: { identifier },
  environment: { debug: true },
  windows: [{ label: "main" }],
};
// Separate workers scan separate ranges.
const start = 30000 + (process.pid % 300) * 100;
const servers = [];

afterEach(() => Promise.all(servers.splice(0).map(close)));

function close(server) {
  for (const socket of server.clients) socket.terminate();
  return new Promise((resolve) => server.close(resolve));
}

function listening(server) {
  servers.push(server);
  return new Promise((resolve, reject) => {
    server.once("listening", () => resolve(server.address().port));
    server.once("error", reject);
  });
}

// A fake bridge that reports `state` and answers other commands with its port.
async function serveApp(state, from = start) {
  for (let port = from; port < from + 50; port++) {
    const app = new WebSocketServer({ host: "127.0.0.1", port });
    try {
      await listening(app);
    } catch {
      servers.pop();
      continue;
    }
    app.commands = [];
    app.on("connection", (socket) =>
      socket.on("message", (raw) => {
        const { id, command, args } = JSON.parse(raw);
        const probe = args?.command === "plugin:mcp-bridge|get_backend_state";
        if (!probe) app.commands.push(command);
        socket.send(
          JSON.stringify({ id, success: true, data: probe ? state : port }),
        );
      }),
    );
    return { app, port };
  }
  throw new Error(`no free port from ${from}`);
}

async function connect(relay, headers) {
  const port = await listening(relay);
  const socket = new WebSocket(`ws://127.0.0.1:${port}`, { headers });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

function send(socket, command) {
  const id = String(Math.random());
  return new Promise((resolve) => {
    socket.on("message", function reply(data) {
      const message = JSON.parse(data);
      if (message.id !== id) return;
      socket.off("message", reply);
      resolve(message);
    });
    socket.send(JSON.stringify({ id, command, args: {} }));
  });
}

it("forwards only to this worktree's app, past another app at the base port", async () => {
  const wrong = await serveApp({ ...instance, app: { identifier: other } });
  const ours = await serveApp(instance, wrong.port + 1);
  const client = await connect(startRelay(identifier, wrong.port));

  expect(await send(client, "ping")).toEqual({
    id: expect.any(String),
    success: true,
    data: ours.port,
  });
  expect(ours.app.commands).toEqual(["ping"]);
  expect(wrong.app.commands).toEqual([]);
});

it.each([
  ["another worktree's app", { ...instance, app: { identifier: other } }],
  ["a release build", { ...instance, environment: { debug: false } }],
  ["an app without a main window", { ...instance, windows: [{ label: "x" }] }],
  ["a malformed state", { ...instance, windows: {} }],
])("refuses %s", async (_, state) => {
  const { app, port } = await serveApp(state);
  const client = await connect(startRelay(identifier, port));

  expect(await send(client, "ping")).toMatchObject({
    success: false,
    error: expect.stringContaining(identifier),
  });
  expect(app.commands).toEqual([]);
});

it("finds an app launched later, and closes the client when that app goes", async () => {
  const free = await serveApp(instance);
  await close(servers.pop());
  const client = await connect(startRelay(identifier, free.port));
  expect(await send(client, "ping")).toMatchObject({ success: false });

  const { app } = await serveApp(instance, free.port);
  expect(await send(client, "ping")).toMatchObject({ success: true });

  const closed = new Promise((resolve) => client.once("close", resolve));
  await close(servers.splice(servers.indexOf(app), 1)[0]);
  await closed;
});

it.each([
  { origin: "https://example.com" },
  { "sec-websocket-origin": "https://example.com" },
  { "x-buzz-native-mcp-relay": "1" },
])("refuses a handshake with %o", async (headers) => {
  await expect(connect(startRelay(identifier, start), headers)).rejects.toThrow(
    "401",
  );
});
