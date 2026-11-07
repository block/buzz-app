// @vitest-environment node
// Progressive tool discovery on a real `goose-acp` and the owner's goose
// config: run with GOOSE_ACP_BIN=/path/to/goose-acp and, to keep the evidence,
// PROOF_DIR=/some/dir. The Buzz tools are listed as the goose runtime lists
// them, from a loopback HTTP MCP server like the app's; their calls are
// answered here, not sent to a relay. Every provider request goose makes is
// read back from its request log, in a state directory of the run's own.
import { spawn as spawnChild } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { respond } from "../../buzz-mcp/rpc";
import { sessionTools } from "../../buzz-mcp/session-tools";
import {
  answerMcp,
  type HostProcessOptions,
} from "../../features/host/service";
import { systemPrompt } from "../claude-code/prompt";
import {
  GooseProcess,
  LISTING,
  type ServeMcp,
  type Spawn,
  type ToolServer,
} from "./goose";

const BIN = process.env.GOOSE_ACP_BIN;

/** goose's ACP notifications, parsed from its stdout. */
const acp: {
  method?: string;
  id?: unknown;
  params?: unknown;
  result?: unknown;
}[] = [];
let pending = "";
const acpOut = (data: string) => {
  pending += data;
  const lines = pending.split("\n");
  pending = lines.pop() ?? "";
  for (const line of lines)
    try {
      acp.push(JSON.parse(line));
    } catch {}
};

/** goose's state directory for this run, made as the suite starts, so its
 * request log holds only this run's requests. */
let state = "";

const spawn: Spawn = async (_id, options: HostProcessOptions = {}) => {
  const env: Record<string, string | undefined> = {
    ...process.env,
    XDG_STATE_HOME: state,
  };
  for (const [key, value] of Object.entries(options.env ?? {}))
    if (value === null) delete env[key];
    else env[key] = value;
  const child = spawnChild(BIN ?? "goose-acp", [], {
    cwd: options.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8").on("data", (data) => {
    if (process.env.GOOSE_ACP_DEBUG) process.stderr.write(`<< ${data}`);
    acpOut(data);
    options.onStdout?.(data);
  });
  child.stderr.setEncoding("utf8").on("data", (data) => {
    if (process.env.GOOSE_ACP_DEBUG) process.stderr.write(data);
    options.onStderr?.(data);
  });
  const exited = new Promise<number | null>((resolve) =>
    child.on("exit", (code) => resolve(code)),
  );
  return {
    write: (data) =>
      new Promise<void>((resolve, reject) =>
        child.stdin.write(data, (error) => (error ? reject(error) : resolve())),
      ),
    end: async (data) => {
      child.stdin.end(data);
    },
    kill: async () => {
      child.kill();
    },
    exited,
  };
};

/** The HTTP requests the MCP servers received, by method and status. */
const hits: { method: string; status: number }[] = [];

const method = (body: string): unknown => {
  try {
    return (JSON.parse(body) as { method?: unknown } | null)?.method;
  } catch {
    return undefined;
  }
};

/** What the app's native listener does: a token per server, 404 for a wrong
 * one, 405 for `GET`, and a JSON reply or 202 for each `POST /mcp`. An
 * `initialize` that succeeds claims the server's one session, and later
 * requests must name it; before it, only discovery and `ping` are answered. A
 * second `initialize` stops the server. */
const serve: ServeMcp = async (handler) => {
  const token = randomBytes(32).toString("base64url");
  const session = randomBytes(32).toString("base64url");
  let claim: "unclaimed" | "claiming" | "claimed" = "unclaimed";
  const server = createServer((request, response) => {
    let joined = false;
    const end = (status: number, body?: string) => {
      hits.push({ method: request.method ?? "", status });
      response.writeHead(status, {
        ...(joined && (status === 200 || status === 202)
          ? { "Mcp-Session-Id": session }
          : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      });
      response.end(body);
    };
    if (
      request.url?.split("?")[0] !== "/mcp" ||
      request.headers.authorization !== `Bearer ${token}`
    )
      return end(404);
    if (request.method !== "POST") return end(405);
    const named = request.headers["mcp-session-id"];
    if (named !== undefined && (named !== session || claim !== "claimed"))
      return end(404);
    let body = "";
    request.setEncoding("utf8").on("data", (data) => (body += data));
    request.on("end", async () => {
      const kind = method(body);
      const claiming = named === undefined && kind === "initialize";
      if (claiming) {
        if (claim !== "unclaimed") {
          server.close();
          return end(404);
        }
        claim = "claiming";
      } else if (named === undefined) {
        // goose first asks `server/discover`.
        if (
          claim === "claimed" ||
          (kind !== "server/discover" && kind !== "ping")
        )
          return end(404);
      } else joined = true;
      const reply = await answerMcp(handler, body);
      if (claiming) {
        joined =
          (reply as { result?: unknown } | undefined)?.result !== undefined;
        claim = joined ? "claimed" : "unclaimed";
      }
      end(reply === undefined ? 202 : 200, JSON.stringify(reply));
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const closed = new Promise<void>((resolve) =>
    server.on("close", () => resolve()),
  );
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    headers: [{ name: "Authorization", value: `Bearer ${token}` }],
    close: async () => {
      server.closeAllConnections();
      server.close();
    },
    closed,
  };
};

type Wire = {
  input: {
    messages: {
      role: string;
      content?: unknown;
      tool_calls?: { function: { name: string; arguments: string } }[];
    }[];
    tools?: { function: { name: string } }[];
  };
};
type Captured = { raw: string; wire: Wire; usage?: unknown };

/** Copies each finished provider request out of goose's rotating log. */
function recordRequests(logs: string) {
  const seen = new Set<string>();
  const captured: Captured[] = [];
  const poll = () => {
    for (let i = 9; i >= 0; i--) {
      let raw: string;
      try {
        // goose renames each log along as it rotates them.
        raw = readFileSync(join(logs, `llm_request.${i}.jsonl`), "utf8");
      } catch {
        continue;
      }
      const hash = createHash("sha256").update(raw).digest("hex");
      if (seen.has(hash)) continue;
      seen.add(hash);
      try {
        const lines = raw.trim().split("\n");
        const last = JSON.parse(lines.at(-1) ?? "{}") as { usage?: unknown };
        captured.push({
          raw,
          wire: JSON.parse(lines[0] ?? "") as Wire,
          usage: last.usage,
        });
      } catch {
        seen.delete(hash);
      }
    }
  };
  const timer = setInterval(poll, 25);
  return {
    stop: () => {
      clearInterval(timer);
      poll();
    },
    of: (marker: string) => captured.filter((c) => c.raw.includes(marker)),
  };
}

const toolNames = (c?: Captured) =>
  (c?.wire.input.tools ?? []).map((t) => t.function.name);
const systemText = (c?: Captured) =>
  JSON.stringify(c?.wire.input.messages.find((m) => m.role === "system") ?? "");
const assistantCalls = (c?: Captured) =>
  (c?.wire.input.messages ?? []).flatMap((m) =>
    (m.tool_calls ?? []).map((call) => ({
      name: call.function.name,
      arguments: call.function.arguments,
    })),
  );

const marker = `run-${randomBytes(4).toString("hex")}`;
const codeword = `kiwi-${randomBytes(3).toString("hex")}`;
const changed = `mango-${randomBytes(3).toString("hex")}`;
const timerId = `w_${randomBytes(3).toString("hex")}`;
/** Set as the compaction test starts, so every read before it agrees. */
let settingChanged = false;

type Call = { method: string; name?: string; arguments?: unknown; at: number };
const calls: Call[] = [];
let listed: { name: string; _meta?: Record<string, unknown> }[] = [];

/** The Buzz tools as the goose runtime lists them; calls get canned answers. */
const tools: ToolServer = async (_conversation, message) => {
  const params = (message.params ?? {}) as {
    name?: string;
    arguments?: unknown;
  };
  calls.push({ method: message.method, ...params, at: acp.length });
  if (message.method === "tools/call") {
    const text = (() => {
      switch (params.name) {
        case "settings_list":
        case "settings_get":
          return JSON.stringify([
            { key: "appearance.theme", value: "dark" },
            {
              key: "display.codeword",
              value: settingChanged ? changed : codeword,
            },
          ]);
        case "watch_add":
          return JSON.stringify({
            id: timerId,
            kind: "timer",
            status: "armed",
          });
        default:
          return "OK.";
      }
    })();
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: { content: [{ type: "text", text }] },
    };
  }
  const reply = (await respond(undefined, {}, message, [], LISTING)) as {
    result?: { tools?: typeof listed };
  };
  if (message.method === "tools/list") listed = reply.result?.tools ?? [];
  return reply;
};

const buzzCalls = (from = 0) =>
  calls.slice(from).filter((c) => c.method === "tools/call");
const sends = () =>
  buzzCalls()
    .filter((c) => c.name === "send")
    .map((c) => (c.arguments as { text?: string }).text ?? "");

type Update = {
  sessionUpdate: string;
  toolCallId?: string;
  title?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  status?: string;
  content?: unknown;
};
/** The tool calls goose reported for a session, from `from` on. */
const toolUpdates = (sessionId: string, from = 0) =>
  acp
    .slice(from)
    .filter((m) => m.method === "session/update")
    .map((m) => m.params as { sessionId: string; update: Update })
    .filter((p) => p.sessionId === sessionId)
    .map((p) => p.update)
    .filter(
      (u) =>
        u.sessionUpdate === "tool_call" ||
        u.sessionUpdate === "tool_call_update",
    );

type Segment = {
  category: string;
  label: string;
  source?: string;
  tokenCount: number;
  parts?: { label: string; tokenCount: number }[];
};
type Report = { totalTokens: number; segments: Segment[] };
const toolSegment = (report: Report) =>
  report.segments.filter((s) => s.category === "tool_definitions");
const reportedTools = (report: Report) =>
  toolSegment(report).flatMap((s) => (s.parts ?? []).map((p) => p.label));

const PROOF_DIR = process.env.PROOF_DIR;
const WIRE = !!process.env.EXPECT_WIRE;
const proof: Record<string, unknown> = { marker, binary: BIN, wire: WIRE };

describe.skipIf(!BIN)("goose-acp progressive tool discovery", () => {
  let requests: ReturnType<typeof recordRequests> | undefined;
  const recorded = (marker: string) => requests?.of(marker) ?? [];
  let goose: Awaited<ReturnType<typeof GooseProcess.start>>;
  let session: Awaited<ReturnType<typeof goose.open>>;
  let cwd = "";
  const tags: string[] = [];
  let lastTag = "";
  const prompt = (text: string) => {
    lastTag = `(${marker}:${tags.length})`;
    tags.push(lastTag);
    return `${text}\n\n${lastTag}`;
  };
  /** The requests of the turn `tag` started: they carry its prompt and no
   * later one. Waits for the log of the turn's last request to land. */
  const turnOf = async (tag: string) => {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const later = tags.slice(tags.indexOf(tag) + 1);
    return recorded(marker).filter(
      (c) => c.raw.includes(tag) && later.every((t) => !c.raw.includes(t)),
    );
  };
  const oldToolResult = (c?: Captured) =>
    (c?.wire.input.messages ?? [])
      .filter((m) => m.role === "tool")
      .some((m) => JSON.stringify(m).includes(codeword));
  const report = async (id: string) =>
    (await goose.request("_goose/unstable/context/report", {
      sessionId: id,
    })) as Report;
  const open = (deferTools = true) =>
    goose.open({
      cwd,
      title: "Ada · #general · defer-tools",
      tools,
      deferTools,
      systemPrompt: systemPrompt({
        scope: "thread",
        cwd,
        agent: { name: "Ada", pubkey: "a".repeat(64) },
      }),
    });

  beforeAll(() => {
    state = mkdtempSync(join(tmpdir(), "buzz-goose-state-"));
    requests = recordRequests(join(state, "goose", "logs"));
  });

  afterAll(async () => {
    requests?.stop();
    await goose?.kill();
    if (state) rmSync(state, { recursive: true, force: true });
    if (!PROOF_DIR) return;
    mkdirSync(join(PROOF_DIR, "requests"), { recursive: true });
    recorded(marker).forEach((c, i) => {
      writeFileSync(
        join(PROOF_DIR, "requests", `${String(i).padStart(2, "0")}.jsonl`),
        c.raw,
      );
    });
    writeFileSync(
      join(PROOF_DIR, "mcp-calls.json"),
      JSON.stringify(calls, null, 2),
    );
    writeFileSync(
      join(PROOF_DIR, "tools-list.json"),
      JSON.stringify(listed, null, 2),
    );
    writeFileSync(
      join(PROOF_DIR, "acp.jsonl"),
      acp.map((m) => JSON.stringify(m)).join("\n"),
    );
    writeFileSync(
      join(PROOF_DIR, "proof.json"),
      JSON.stringify(proof, null, 2),
    );
  });

  it("lists search tools by name and loads one the model asks for", {
    timeout: 300_000,
  }, async () => {
    cwd = mkdtempSync(join(tmpdir(), "buzz-goose-defer-"));
    goose = await GooseProcess.start(spawn, { cwd, serve });
    session = await open();
    session.conversation = "channel/root";

    const always = new Set(
      sessionTools([], false)
        .filter((t) => t.load === "always")
        .map((t) => t.name),
    );
    const search = sessionTools([], false)
      .filter((t) => t.load === "search")
      .map((t) => t.name);
    const start = await report(session.id);
    const startTools = reportedTools(start);
    // The server marked exactly the `always` tools for goose.
    expect(listed.length).toBe(always.size + search.length);
    for (const tool of listed)
      expect(tool._meta?.["goose/alwaysLoad"] === true).toBe(
        always.has(tool.name),
      );

    expect(startTools).toContain("load_tools");
    expect(startTools).toContain("search_tools");
    expect(startTools).not.toContain("buzz__settings_get");
    expect(startTools.filter((n) => n.startsWith("buzz__")).sort()).toEqual(
      [...always].map((n) => `buzz__${n}`).sort(),
    );

    const acpFrom = acp.length;
    const callsFrom = calls.length;
    expect(
      await session.send(
        prompt(
          "What is my Buzz display.codeword setting? Look it up with your Buzz tools and send me its value in Buzz.",
        ),
      ),
    ).toMatchObject({ ok: true });

    // goose ran load_tools for a settings tool, then buzz-mcp ran that tool.
    const updates = toolUpdates(session.id, acpFrom);
    const load = updates.find(
      (u) =>
        u.sessionUpdate === "tool_call" &&
        JSON.stringify(u).includes("load_tools") &&
        JSON.stringify(u.rawInput ?? "").includes("buzz__settings_"),
    );
    expect(load).toBeDefined();
    const settingsCall = buzzCalls(callsFrom).find((c) =>
      String(c.name).startsWith("settings_"),
    );
    expect(settingsCall).toBeDefined();
    expect(sends().at(-1)).toContain(codeword);
    const loadedTool = `buzz__${settingsCall?.name}`;

    const after = await report(session.id);
    expect(reportedTools(after)).toContain(loadedTool);

    const turn = await turnOf(lastTag);
    if (WIRE) {
      expect(turn.length).toBeGreaterThanOrEqual(2);
      const first = turn[0];
      const sent = toolNames(first);
      expect(new Set(sent.filter((n) => n.startsWith("buzz__")))).toEqual(
        new Set([...always].map((n) => `buzz__${n}`)),
      );
      expect(sent).toContain("load_tools");
      expect(sent).toContain("search_tools");
      expect(systemText(first)).toContain("Not loaded:");
      expect(systemText(first)).toContain("buzz__settings_get");
      const loadAt = turn.findIndex((c) =>
        assistantCalls(c).some((call) => call.name === "load_tools"),
      );
      expect(loadAt).toBeGreaterThan(0);
      expect(toolNames(turn[loadAt - 1])).not.toContain(loadedTool);
      expect(toolNames(turn[loadAt])).toContain(loadedTool);
    }

    proof.load = {
      listedByBuzz: listed.length,
      listedAlways: always.size,
      listedSearch: search.length,
      loadedTool,
      reportBefore: {
        totalTokens: start.totalTokens,
        toolTokens: toolSegment(start).reduce((n, s) => n + s.tokenCount, 0),
        tools: startTools.length,
      },
      reportAfter: {
        totalTokens: after.totalTokens,
        toolTokens: toolSegment(after).reduce((n, s) => n + s.tokenCount, 0),
        tools: reportedTools(after).length,
        includesLoadedTool: reportedTools(after).includes(loadedTool),
      },
      goosesToolCalls: updates
        .filter((u) => u.sessionUpdate === "tool_call")
        .map((u) => ({ title: u.title, rawInput: u.rawInput })),
      buzzMcpCalls: buzzCalls(callsFrom).map((c) => ({
        name: c.name,
        arguments: c.arguments,
      })),
      finalSend: sends().at(-1),
      wireRequests: turn.map((c, i) => ({
        index: i,
        toolCount: toolNames(c).length,
        buzzTools: toolNames(c).filter((n) => n.startsWith("buzz__")).length,
        sendsLoadedTool: toolNames(c).includes(loadedTool),
        hasDiscoveryTools: ["load_tools", "search_tools"].every((n) =>
          toolNames(c).includes(n),
        ),
        notLoadedLine: systemText(c).match(/Not loaded: [^\\]*/)?.[0],
        historyToolCalls: assistantCalls(c).map(
          (call) => `${call.name}(${call.arguments})`,
        ),
        usage: c.usage,
      })),
    };
  });

  it("keeps a loaded tool across /compact", { timeout: 300_000 }, async () => {
    const loadedTool = (proof.load as { loadedTool: string }).loadedTool;
    expect(await session.send("/compact")).toMatchObject({ ok: true });
    const compacted = await report(session.id);
    expect(reportedTools(compacted)).toContain(loadedTool);
    expect(
      compacted.segments.some((s) => s.category === "compaction_summary"),
    ).toBe(true);

    settingChanged = true;
    const acpFrom = acp.length;
    const callsFrom = calls.length;
    expect(
      await session.send(
        prompt(
          "My display.codeword setting just changed. Read it again with the same Buzz tool and send me the new value in Buzz.",
        ),
      ),
    ).toMatchObject({ ok: true });
    const updates = toolUpdates(session.id, acpFrom);
    expect(updates.some((u) => JSON.stringify(u).includes("load_tools"))).toBe(
      false,
    );
    expect(
      buzzCalls(callsFrom).some((c) => `buzz__${c.name}` === loadedTool),
    ).toBe(true);
    expect(sends().at(-1)).toContain(changed);

    const turn = await turnOf(lastTag);
    if (WIRE) {
      const first = turn[0];
      expect(assistantCalls(first).some((c) => c.name === "load_tools")).toBe(
        false,
      );
      expect(oldToolResult(first)).toBe(false);
      expect(toolNames(first)).toContain(loadedTool);
    }
    proof.compaction = {
      loadedTool,
      reportAfterCompact: {
        totalTokens: compacted.totalTokens,
        includesLoadedTool: reportedTools(compacted).includes(loadedTool),
        categories: compacted.segments.map((s) => s.category),
      },
      goosesToolCalls: updates
        .filter((u) => u.sessionUpdate === "tool_call")
        .map((u) => ({ title: u.title, rawInput: u.rawInput })),
      buzzMcpCalls: buzzCalls(callsFrom).map((c) => ({
        name: c.name,
        arguments: c.arguments,
      })),
      finalSend: sends().at(-1),
      wireRequests: turn.map((c, i) => ({
        index: i,
        toolCount: toolNames(c).length,
        sendsLoadedTool: toolNames(c).includes(loadedTool),
        historyHasLoadToolsCall: assistantCalls(c).some(
          (call) => call.name === "load_tools",
        ),
        historyHasOldToolResult: oldToolResult(c),
        historyToolCalls: assistantCalls(c).map(
          (call) => `${call.name}(${call.arguments})`,
        ),
        usage: c.usage,
      })),
    };
  });

  it("finds a tool with search_tools, then loads and calls it", {
    timeout: 300_000,
  }, async () => {
    const acpFrom = acp.length;
    const callsFrom = calls.length;
    expect(
      await session.send(
        prompt(
          "Use search_tools to find the Buzz tool that sets a timer. Then load it, set a 15 minute timer that prompts you to check the deploy, and send me the new timer's id in Buzz.",
        ),
      ),
    ).toMatchObject({ ok: true });
    const updates = toolUpdates(session.id, acpFrom);
    const searchCall = updates.find(
      (u) =>
        u.sessionUpdate === "tool_call" &&
        JSON.stringify(u).includes("search_tools"),
    );
    expect(searchCall).toBeDefined();
    const searchResult = updates.find(
      (u) =>
        u.sessionUpdate === "tool_call_update" &&
        u.toolCallId === searchCall?.toolCallId &&
        JSON.stringify(u).includes("buzz__watch_add"),
    );
    expect(searchResult).toBeDefined();
    const load = updates.find(
      (u) =>
        u.sessionUpdate === "tool_call" &&
        JSON.stringify(u).includes("load_tools") &&
        JSON.stringify(u.rawInput ?? "").includes("buzz__watch_add"),
    );
    expect(load).toBeDefined();
    expect(buzzCalls(callsFrom).some((c) => c.name === "watch_add")).toBe(true);
    expect(sends().at(-1)).toContain(timerId);

    const turn = await turnOf(lastTag);
    if (WIRE) {
      expect(toolNames(turn[0])).not.toContain("buzz__watch_add");
      const loadAt = turn.findIndex((c) =>
        assistantCalls(c).some(
          (call) =>
            call.name === "load_tools" &&
            call.arguments.includes("buzz__watch_add"),
        ),
      );
      expect(loadAt).toBeGreaterThan(0);
      expect(toolNames(turn[loadAt])).toContain("buzz__watch_add");
    }
    proof.search = {
      goosesToolCalls: updates
        .filter((u) => u.sessionUpdate === "tool_call")
        .map((u) => ({ title: u.title, rawInput: u.rawInput })),
      searchResult: searchResult?.rawOutput ?? searchResult?.content,
      buzzMcpCalls: buzzCalls(callsFrom).map((c) => ({
        name: c.name,
        arguments: c.arguments,
      })),
      finalSend: sends().at(-1),
      wireRequests: turn.map((c, i) => ({
        index: i,
        toolCount: toolNames(c).length,
        sendsWatchAdd: toolNames(c).includes("buzz__watch_add"),
        historyToolCalls: assistantCalls(c).map(
          (call) => `${call.name}(${call.arguments})`,
        ),
        usage: c.usage,
      })),
    };
  });

  it("sends every Buzz tool to a session that doesn't defer", {
    timeout: 300_000,
  }, async () => {
    const control = await open(false);
    control.conversation = "channel/control";
    const start = await report(control.id);
    const tools = reportedTools(start);
    expect(tools).not.toContain("load_tools");
    expect(tools.filter((n) => n.startsWith("buzz__")).length).toBe(
      listed.length,
    );
    const deferring = (
      proof.load as {
        reportBefore: {
          totalTokens: number;
          toolTokens: number;
          tools: number;
        };
      }
    ).reportBefore;
    expect(start.totalTokens).toBeGreaterThan(deferring.totalTokens);
    expect(
      await control.send(prompt("Say hello to me in Buzz.")),
    ).toMatchObject({ ok: true });
    const turn = await turnOf(lastTag);
    if (WIRE) {
      expect(toolNames(turn[0])).not.toContain("load_tools");
      expect(
        toolNames(turn[0]).filter((n) => n.startsWith("buzz__")).length,
      ).toBe(listed.length);
    }
    proof.control = {
      report: {
        totalTokens: start.totalTokens,
        toolTokens: toolSegment(start).reduce((n, s) => n + s.tokenCount, 0),
        tools: tools.length,
      },
      wireFirstRequest: turn[0] && {
        toolCount: toolNames(turn[0]).length,
        buzzTools: toolNames(turn[0]).filter((n) => n.startsWith("buzz__"))
          .length,
        usage: turn[0].usage,
      },
    };
  });
});
