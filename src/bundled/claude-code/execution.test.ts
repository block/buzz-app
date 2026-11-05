import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { AgentExecution } from "../../features/agents/execution";
import { ClaudeProcess } from "./claude";
import { executionSpawn } from "./execution";
import { ClaudeRuntime, DEFAULT_CONFIG } from "./runtime";
import { localStore } from "../../features/agents/store";
import { fileStore } from "../../features/agents/state";
import type {
  Agent,
  AgentHandle,
  Delivery,
  Agents,
} from "../../features/agents/service";
import type { AgentReads } from "../../features/agents/reads";

async function guestFixture() {
  const directory = await mkdtemp(join(tmpdir(), "buzz-claude-execution-"));
  const children: ReturnType<typeof spawn>[] = [];
  const output: string[] = [];
  const guest: AgentExecution = {
    workspace: directory,
    signal: new AbortController().signal,
    resolveDirectory: async (path) => path,
    readFile: async () => new Uint8Array(),
    dispose: async () => {
      for (const child of children) child.kill();
      await Promise.all(
        children.map((child) =>
          child.exitCode !== null || child.signalCode !== null
            ? Promise.resolve()
            : new Promise((resolve) => child.once("exit", resolve)),
        ),
      );
    },
    spawn: async (program, options) => {
      expect(program).toBe("node");
      expect(options?.env).toBeUndefined();
      const child = spawn(process.execPath, [...(options?.args ?? [])], {
        cwd: options?.cwd,
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          ANTHROPIC_API_KEY: "guest-test-sign-in",
          CLAUDECODE: "stale-session",
        },
        stdio: "pipe",
      });
      children.push(child);
      child.stdout.on("data", (data) => options?.onStdout?.(String(data)));
      child.stderr.on("data", (data) => {
        output.push(String(data));
        options?.onStderr?.(String(data));
      });
      return {
        write: (data) =>
          new Promise<void>((resolve, reject) =>
            child.stdin.write(data, (error) =>
              error ? reject(error) : resolve(),
            ),
          ),
        end: async (data) => {
          child.stdin.end(data);
        },
        kill: async () => {
          child.kill();
        },
        exited: new Promise<number | null>((resolve) =>
          child.once("exit", resolve),
        ),
      };
    },
  };
  await writeFile(
    join(directory, "claude"),
    `#!${process.execPath}
const {createInterface} = require('node:readline');
const {appendFileSync,existsSync,writeFileSync} = require('node:fs');
const flag = (name) => process.argv[process.argv.indexOf(name)+1];
const resume = process.argv.includes('--resume') ? flag('--resume') : undefined;
const session = resume || (process.argv.includes('--session-id') ? flag('--session-id') : 'session-1');
const log = (value) => appendFileSync('wire.jsonl',JSON.stringify(value)+'\\n');
if (process.argv.includes('--version')) { console.log('2.1.308 (Claude Code)'); process.exit(0); }
if (process.env.ANTHROPIC_API_KEY !== 'guest-test-sign-in' || process.env.CLAUDECODE) process.exit(2);
const send = (wire) => console.log(JSON.stringify({...wire,session_id:session}));
log({launch:process.argv});
const result = () => send({type:'result', subtype:'success', session_id:'session-1'});
createInterface({input:process.stdin}).on('line', (line) => {
  const wire = JSON.parse(line);
  log(wire);
  if (wire.type === 'control_request') {
    send({type:'control_response',response:{subtype:'success',request_id:wire.request_id,response:{models:[{value:'haiku'}]}}});
    if (wire.request.subtype === 'interrupt') {
      send({type:'result',subtype:'error_during_execution',is_error:true,terminal_reason:'aborted_tools',session_id:'session-1'});
    }
  } else if (wire.type === 'user') {
    if (resume && !existsSync(session+'.saved')) { process.stderr.write('No conversation found'); process.exit(1); }
    writeFileSync(session+'.saved','saved');
    send({type:'system',subtype:'init',session_id:'session-1',model:'haiku'});
    if (wire.message.content === 'hold' || wire.message.content.includes('hold-request')) return;
    send({type:'control_request',request_id:'tool',request:{subtype:'mcp_message',server_name:'buzz',message:{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'read',arguments:{path:'proof.bin'}}}}});
  } else if (wire.type === 'control_response') {
    if (wire.response.request_id === 'tool') {
      process.stderr.write(JSON.stringify(wire.response.response));
      send({type:'control_request',request_id:'hook',request:{subtype:'hook_callback',callback_id:'buzz:PermissionRequest',input:{session_id:'session-1',tool_name:'Read'}}});
    } else if (wire.response.request_id === 'hook') {
      process.stderr.write(JSON.stringify(wire.response.response));
      result();
    }
  }
});
`,
    { mode: 0o700 },
  );
  return {
    guest,
    directory,
    output,
    wires: async () =>
      (await readFile(join(directory, "wire.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    cleanup: async () => {
      await guest.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

it("carries Claude tools, hooks and Stop over guest stdio with guest authentication", async () => {
  const { guest, directory, output, cleanup } = await guestFixture();
  const tools = vi.fn(async () => ({
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text: "guest-file" }] },
  }));
  const hook = vi.fn(async () => ({
    decision: "deny",
    reason: "test decision",
  }));
  const claude = await ClaudeProcess.start(executionSpawn(guest), {
    cwd: directory,
    systemPrompt: "test",
    tools,
    hook,
  });
  try {
    expect(await claude.models()).toEqual([{ value: "haiku" }]);
    await expect(claude.send("read")).resolves.toEqual({ ok: true });
    expect(tools).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ method: "tools/call" }),
      expect.any(AbortSignal),
    );
    expect(hook).toHaveBeenCalledWith("session-1", "PermissionRequest", {
      session_id: "session-1",
      tool_name: "Read",
    });
    await vi.waitFor(() => {
      expect(output.join("")).toContain("guest-file");
      expect(output.join("")).toContain("test decision");
    });
    const held = claude.send("hold");
    await vi.waitFor(() => expect(claude.active).toBe(true));
    await claude.interrupt();
    await expect(held).resolves.toMatchObject({ ok: true, stopped: true });
    await expect(claude.send("read again")).resolves.toEqual({ ok: true });
  } finally {
    await claude.kill();
    await claude.exited;
    await cleanup();
  }
});

it("resumes the same remote Claude session after restart and gives New a fresh target key", async () => {
  const fixture = await guestFixture();
  const data = new Map<string, string>();
  const storage = localStore({
    get length() {
      return data.size;
    },
    key: (index: number) => [...data.keys()][index] ?? null,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  } as Storage);
  const agent = {
    key: "a".repeat(64),
    pubkey: "a".repeat(64),
    owner: "b".repeat(64),
    name: "Claude",
    config: DEFAULT_CONFIG,
  } as Agent;
  const handle = {
    ...agent,
    publish: vi.fn(async () => ({})),
  } as unknown as AgentHandle;
  const reads = {
    connection: {},
    scope: "test-community",
    channel: async () => ({ dm: true, members: [] }),
    soloChat: async () => false,
    read: async () => [],
    channelLabel: () => undefined,
    workflowAuthority: () => undefined,
    name: () => undefined,
    memoryListing: async () => ({ entries: [], partial: false }),
  } as unknown as AgentReads;
  const sessions: { key: string; intent: string }[] = [];
  const connect: Agents["execution"] = async (_agent, session) => {
    sessions.push({ key: session.key, intent: session.intent });
    const lifetime = new AbortController();
    return {
      ...fixture.guest,
      signal: lifetime.signal,
      dispose: async () => lifetime.abort(),
    };
  };
  const local = vi.fn(async () => {
    throw new Error("Local Claude must stay unused");
  });
  let connected = true;
  const create = () =>
    new ClaudeRuntime(
      { spawn: local },
      () => (connected ? reads : undefined),
      async () => null,
      fileStore(
        new Map(),
        storage.set,
        storage.add,
        storage.read,
        storage.scan,
      ),
      undefined,
      undefined,
      undefined,
      async () => ({}),
      connect,
      async () => ({ provider: "test/remote" }),
      () => true,
    );
  let runtime = create();
  const event = {
    id: "c".repeat(64),
    pubkey: agent.owner,
    kind: 9,
    created_at: 1,
    content: "hello",
    tags: [["h", "room"]],
  };
  const waits: Promise<unknown>[] = [];
  const deliver = async () => {
    await runtime.run({
      agent: handle,
      config: DEFAULT_CONFIG,
      channelId: "room",
      trigger: { type: "mention", event },
      signal: new AbortController().signal,
      workingUntil: (work: Promise<unknown>) => waits.push(work),
    } as unknown as Delivery);
    await Promise.all(waits.splice(0));
  };
  try {
    runtime.sync([agent]);
    expect(await runtime.models(agent.key)).toMatchObject({
      current: "",
      models: [],
    });
    expect(sessions).toEqual([]);
    await deliver();
    await vi.waitFor(() =>
      expect(runtime.sessions(agent.key)).toEqual([
        { key: "room", busy: false },
      ]),
    );
    const saved = runtime.conversations(agent.key)[0];
    expect(saved?.sessionId).toBeTruthy();
    expect(handle.publish).not.toHaveBeenCalled();
    event.content = "hold-request";
    const pending = deliver();
    await vi.waitFor(() =>
      expect(runtime.sessions(agent.key)).toEqual([
        { key: "room", busy: true },
      ]),
    );
    connected = false;
    try {
      expect(runtime.sessionState(agent, { channelId: "room" })).toBe("active");
      await runtime.session(agent, { channelId: "room" }, "interrupt");
      await pending;
    } finally {
      connected = true;
      event.content = "hello";
    }
    await runtime.retire(agent.key);
    runtime.dispose();
    runtime = create();
    runtime.sync([agent]);
    await deliver();
    await vi.waitFor(() =>
      expect(runtime.sessions(agent.key)).toEqual([
        { key: "room", busy: false },
      ]),
    );
    expect(runtime.conversations(agent.key)[0]?.sessionId).toBe(
      saved?.sessionId,
    );
    expect(sessions[1]).toEqual({ key: sessions[0]?.key, intent: "existing" });
    expect(
      (await fixture.wires()).some(
        (wire) =>
          Array.isArray(wire.launch) && wire.launch.includes("--resume"),
      ),
    ).toBe(true);
    await runtime.session(agent, { channelId: "room" }, "new");
    await deliver();
    expect(sessions[2]?.key).not.toBe(sessions[0]?.key);
    expect(sessions[2]?.intent).toBe("new");
    expect(local).not.toHaveBeenCalled();
  } finally {
    await runtime.retire(agent.key);
    runtime.dispose();
    await fixture.cleanup();
  }
});
