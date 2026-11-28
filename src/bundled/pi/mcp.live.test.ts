// @vitest-environment node
// The Pi host's MCP client on the real client package, against a local and
// an HTTP server: run with PI_DEPS set to a folder pi.sh installed Pi's
// packages in, such as "~/Library/Application Support/Buzz/pi/deps/<sum>".
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import host from "./host.mjs?raw";

const DEPS = process.env.PI_DEPS;
const run = promisify(execFile);

/** A local MCP server: newline-delimited JSON-RPC on stdio. */
const SERVER = `
import { createInterface } from "node:readline";
const tools = [
  { name: "env", description: "Its environment", inputSchema: { type: "object" } },
  { name: "wait", description: "Never answers", inputSchema: { type: "object" } },
  { name: "die", description: "Exits", inputSchema: { type: "object" } },
  { name: "${"x".repeat(80)}", description: "Long", inputSchema: { type: "object" } },
  { name: "a.b", description: "Dotted", inputSchema: { type: "object" } },
];
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
process.stderr.write("SECRET-IN-LOGS\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  if (method === "initialize")
    send({ id, result: { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } });
  else if (method === "tools/list") send({ id, result: { tools } });
  else if (params?.name === "env")
    send({ id, result: { content: [{ type: "text", text: JSON.stringify({ token: process.env.TOKEN ?? null, base: process.env.BASE_VAR ?? null, other: Object.keys(process.env).filter((n) => n.startsWith("BUZZMCP_")), cwd: process.cwd() }) }] } });
  else if (params?.name === "die") process.exit(1);
});
`;

const DRIVER = `
import { createServer } from "node:http";
import { closeMcp, mcpEnv, mcpExtension, mcpToolName } from "./host.mjs";
const out = {};
// An HTTP server that answers each request with JSON, and keeps the
// headers it was sent.
const seen = [];
const http = createServer(async (req, res) => {
  if (req.method !== "POST") { res.writeHead(405).end(); return; }
  let body = "";
  for await (const chunk of req) body += chunk;
  seen.push(req.headers.authorization ?? null);
  const { id, method, params } = JSON.parse(body);
  if (id === undefined) { res.writeHead(202).end(); return; }
  const result = method === "initialize"
    ? { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "web", version: "1" } }
    : method === "tools/list" ? { tools: [{ name: "hi", inputSchema: { type: "object" } }] }
    : { content: [], structuredContent: { hello: "web" } };
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, result }));
});
await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
const url = "http://127.0.0.1:" + http.address().port + "/mcp";

process.env.BASE_VAR = "from-launch";
process.env.BUZZMCP_00000000000000A1_544F4B454E = "another-slot";
const { clients, extension } = await mcpExtension([
  { name: "local", transport: "stdio", command: process.execPath, args: [process.cwd() + "/server.mjs"], env: { TOKEN: "t0ken" } },
  { name: "web", transport: "http", url, headers: { Authorization: "Bearer h3ader" } },
  { name: "broken", transport: "stdio", command: "/no/such/command", args: [], env: { TOKEN: "leak" } },
], process.env.WORKSPACE);
out.names = extension.tools.map((t) => t.name);
out.deferred = extension.tools.every((t) => t.deferred === true);
out.schemas = extension.tools.map((t) => t.parameters.type);
out.section = extension.sections[0].render({ conversationId: 0, shown: {} });
const byName = (n) => extension.tools.find((t) => t.name === n);
const signalled = (signal = new AbortController().signal) => ({ abortSignal: signal });
out.env = JSON.parse((await byName("mcp__local__env").execute({}, {}, signalled())).output[0].text);
out.web = (await byName("mcp__web__hi").execute({}, {}, signalled())).output;
out.headers = seen;
// A call has no limit but its turn's.
const turn = new AbortController();
const waiting = byName("mcp__local__wait").execute({}, {}, signalled(turn.signal));
const early = await Promise.race([waiting.then(() => "answered", () => "failed"), new Promise((r) => setTimeout(() => r("running"), 1500))]);
turn.abort();
out.wait = [early, await waiting.then(() => "answered", () => "aborted")];
await byName("mcp__local__die").execute({}, {}, signalled()).catch(() => undefined);
await new Promise((r) => setTimeout(r, 200));
out.dead = await byName("mcp__local__env").execute({}, {}, signalled()).then(() => "ran", (e) => e.message);
const taken = new Set(["mcp__a__b"]);
out.collision = mcpToolName("a", "b", taken);
out.envOf = mcpEnv({ A: "1", BUZZMCP_X_1: "no", U: undefined }, { T: "2" });
const started = Date.now();
await closeMcp(clients, 1000);
out.closedIn = Date.now() - started;
http.close();
console.log(JSON.stringify(out));
process.exit(0);
`;

/** A local server that writes its PID, then answers nothing for a while. */
const SLOW = `
import { writeFileSync } from "node:fs";
writeFileSync(process.argv[2], String(process.pid));
process.stdin.resume();
setTimeout(() => {}, 60_000);
`;

/** Closes the agent while its server is still connecting, through the host. */
const CLOSING = `
import { existsSync, readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { createModels } from "@earendil-works/pi-ai/models";
import { serve } from "./host.mjs";
const input = new PassThrough(), output = new PassThrough();
const pending = new Map();
let id = 0;
createInterface({ input: output }).on("line", (line) => {
  const message = JSON.parse(line);
  const call = message.id !== undefined && pending.get(message.id);
  if (!call) return;
  pending.delete(message.id);
  if (message.error) call.reject(new Error(message.error));
  else call.resolve(message.result);
});
const rpc = (method, params) => new Promise((resolve, reject) => {
  pending.set(++id, { resolve, reject });
  input.write(JSON.stringify({ id, method, params }) + "\\n");
});
const data = process.cwd() + "/data";
serve({ data, models: createModels(), dir: data, input, output, exit: () => {} });
const agent = "c".repeat(64);
const pidFile = process.cwd() + "/slow.pid";
const opening = rpc("open", { agent, tools: [], mcp: { key: "k", cwd: process.cwd(), servers: [
  { name: "slow", transport: "stdio", command: process.execPath, args: [process.cwd() + "/slow.mjs", pidFile], env: {} },
] } }).then(() => "opened", (e) => e.message);
while (!existsSync(pidFile)) await new Promise((r) => setTimeout(r, 20));
const pid = Number(readFileSync(pidFile, "utf8"));
await rpc("close", { agent });
const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
for (let i = 0; i < 50 && alive(); i++) await new Promise((r) => setTimeout(r, 100));
console.log(JSON.stringify({ alive: alive(), opening: await opening }));
process.exit(0);
`;

const folders: string[] = [];
afterAll(() =>
  Promise.all(folders.map((f) => rm(f, { recursive: true, force: true }))),
);

describe.skipIf(!DEPS)("the Pi host's MCP client", () => {
  it("connects, names, calls and closes local and HTTP servers", async () => {
    const folder = await mkdtemp(join(tmpdir(), "buzz-pi-mcp-"));
    const workspace = await mkdtemp(join(tmpdir(), "buzz-pi-workspace-"));
    folders.push(folder, workspace);
    await symlink(
      join(DEPS ?? "", "node_modules"),
      join(folder, "node_modules"),
    );
    await writeFile(join(folder, "host.mjs"), host);
    await writeFile(join(folder, "server.mjs"), SERVER);
    await writeFile(join(folder, "driver.mjs"), DRIVER);
    const { stdout, stderr } = await run(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", join(folder, "driver.mjs")],
      {
        cwd: folder,
        env: { ...process.env, WORKSPACE: workspace },
        timeout: 60_000,
      },
    );
    const out = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");
    // Long and invalid names are shortened with a hash, within 64.
    expect(out.names.slice(0, 3)).toEqual([
      "mcp__local__env",
      "mcp__local__wait",
      "mcp__local__die",
    ]);
    expect(out.names[3]).toMatch(/^mcp__local__x+_[0-9a-f]{8}$/);
    expect(out.names[3]).toHaveLength(64);
    expect(out.names[4]).toMatch(/^mcp__local__a_b_[0-9a-f]{8}$/);
    expect(out.names[5]).toBe("mcp__web__hi");
    expect(out.deferred).toBe(true);
    expect(out.schemas.every((t: string) => t === "object")).toBe(true);
    // A server that failed is named with its error's type only.
    expect(out.section).toContain("broken (Error)");
    expect(out.section).not.toContain("leak");
    // The launch environment, its own values, no other slot's.
    expect(out.env).toEqual({
      token: "t0ken",
      base: "from-launch",
      other: [],
      // In the agent's workspace, not the host's folder.
      cwd: await realpath(workspace),
    });
    expect(out.web).toEqual([{ type: "text", text: '{"hello":"web"}' }]);
    expect(out.headers).toContain("Bearer h3ader");
    expect(out.wait).toEqual(["running", "aborted"]);
    expect(out.dead).toBe("The MCP server local stopped");
    expect(out.collision).toMatch(/^mcp__a__b_[0-9a-f]{8}$/);
    expect(out.envOf).toEqual({ A: "1", T: "2" });
    expect(out.closedIn).toBeLessThan(1500);
    // Its error output never reaches the host's.
    expect(stderr).not.toContain("SECRET-IN-LOGS");
  }, 90_000);

  it("leaves no server running when the agent closes while it connects", async () => {
    const folder = await mkdtemp(join(tmpdir(), "buzz-pi-mcp-"));
    folders.push(folder);
    await symlink(
      join(DEPS ?? "", "node_modules"),
      join(folder, "node_modules"),
    );
    await writeFile(join(folder, "host.mjs"), host);
    await writeFile(join(folder, "slow.mjs"), SLOW);
    await writeFile(join(folder, "driver.mjs"), CLOSING);
    const { stdout } = await run(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", join(folder, "driver.mjs")],
      { cwd: folder, timeout: 60_000 },
    );
    const out = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");
    expect(out.alive).toBe(false);
  }, 60_000);
});
