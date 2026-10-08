// One `claude` process driven over its stream-json protocol: the protocol the
// Claude Agent SDK speaks to the same binary, so no Node runtime is needed. The
// process stays alive between turns; messages sent while it works are folded
// into the running turn at its next tool call.
import type {
  HostProcess,
  HostProcessOptions,
} from "../../features/host/service";

export type Spawn = (
  id: string,
  options?: HostProcessOptions,
) => Promise<HostProcess>;

export type ClaudeLaunch = Readonly<{
  /** Agent pubkey the process acts as. */
  agent: string;
  cwd: string;
  /** Appended to Claude Code's own system prompt. */
  systemPrompt: string;
  model?: string;
  /** A saved session to continue. */
  resume?: string;
  /** The id a new session takes, so it is known before its first turn. */
  sessionId?: string;
}>;

type Message = Record<string, unknown> & { type?: string; subtype?: string };

/** How a burst of work ended: every message sent so far has been answered,
 * or the process is gone. */
export type Settled = Readonly<{
  ok: boolean;
  /** Why it failed, for the person waiting. */
  error?: string;
}>;

const STDERR_LIMIT = 4_000;
/** What `claude` is started with: as the SDK starts it, reporting when it is
 * idle, and never as part of a Claude Code session that started the app. */
export const ENV: Readonly<Record<string, string | null>> = {
  CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
  CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
  CLAUDECODE: null,
  CLAUDE_CODE_SESSION_ID: null,
  CLAUDE_CODE_CHILD_SESSION: null,
  CLAUDE_CODE_MESSAGING_SOCKET: null,
  CLAUDE_CODE_MESSAGING_TOKEN: null,
  CLAUDE_CODE_SESSION_ATTENDED: null,
  CLAUDE_AGENT_SDK_VERSION: null,
  CLAUDE_PID: null,
};

export class ClaudeProcess {
  /** Its session, known once the first turn starts (or at once when resuming). */
  sessionId: string | undefined;
  /** Messages sent and not yet answered. */
  private pending = 0;
  /** It has begun a turn, so its session loaded. */
  private began = false;
  private waiters: ((settled: Settled) => void)[] = [];
  private buffer = "";
  private stderr = "";
  private lastError: string | undefined;
  private alive = true;
  /** It reports idle; an older `claude` that does not is settled per result. */
  private reportsState = false;
  private requests = 0;
  readonly exited: Promise<number | null>;

  private constructor(
    private readonly process: HostProcess,
    resume: string | undefined,
  ) {
    this.sessionId = resume;
    this.exited = process.exited.then((code) => {
      this.alive = false;
      const error =
        this.lastError ??
        (this.stderr.trim().split("\n").at(-1) ||
          `Claude Code exited (${code ?? "signal"})`);
      this.settle({ ok: false, error });
      return code;
    });
  }

  static async start(spawn: Spawn, launch: ClaudeLaunch) {
    let claude: ClaudeProcess | undefined;
    const early: string[] = [];
    const earlyErrors: string[] = [];
    const process = await spawn("claude", {
      args: [
        "--output-format",
        "stream-json",
        "--input-format",
        "stream-json",
        "--verbose",
        "--permission-mode",
        "bypassPermissions",
        ...(launch.model ? ["--model", launch.model] : []),
        ...(launch.resume ? ["--resume", launch.resume] : []),
        ...(!launch.resume && launch.sessionId
          ? ["--session-id", launch.sessionId]
          : []),
      ],
      cwd: launch.cwd,
      agent: launch.agent,
      env: ENV,
      onStdout: (data) => (claude ? claude.read(data) : early.push(data)),
      onStderr: (data) =>
        claude ? claude.readError(data) : earlyErrors.push(data),
    });
    claude = new ClaudeProcess(process, launch.resume ?? launch.sessionId);
    for (const data of earlyErrors) claude.readError(data);
    for (const data of early) claude.read(data);
    // Loads settings, tools and MCP servers now rather than on the first message.
    await claude.request({
      subtype: "initialize",
      appendSystemPrompt: launch.systemPrompt,
    });
    return claude;
  }

  get running() {
    return this.alive;
  }
  get busy() {
    return this.pending > 0;
  }
  get started() {
    return this.began;
  }

  /** Sends one user message. Resolves when it, and anything sent after it, has
   * been answered and the session is idle again. */
  send(text: string): Promise<Settled> {
    if (!this.alive)
      return Promise.resolve({
        ok: false,
        error: "Claude Code is not running",
      });
    this.pending++;
    const settled = new Promise<Settled>((resolve) =>
      this.waiters.push(resolve),
    );
    this.write({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: "",
    }).catch((error) =>
      this.settle({
        ok: false,
        error: `Claude Code did not take the message: ${error}`,
      }),
    );
    return settled;
  }

  kill() {
    return this.process.kill();
  }

  private write(message: Message) {
    return this.process.write(`${JSON.stringify(message)}\n`);
  }
  private async request(request: Message) {
    await this.write({
      type: "control_request",
      request_id: `buzz-${++this.requests}`,
      request,
    });
  }
  private settle(settled: Settled) {
    this.pending = 0;
    this.lastError = undefined;
    for (const resolve of this.waiters.splice(0)) resolve(settled);
  }

  private readError(data: string) {
    this.stderr = (this.stderr + data).slice(-STDERR_LIMIT);
  }
  private read(data: string) {
    this.buffer += data;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf("\n");
      if (!line) continue;
      let message: Message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      this.handle(message);
    }
  }
  private handle(message: Message) {
    if (typeof message.session_id === "string" && message.session_id)
      this.sessionId = message.session_id;
    if (message.type === "system" && message.subtype === "init")
      this.began = true;
    if (message.type === "control_request") {
      void this.answer(message);
      return;
    }
    if (
      message.type === "system" &&
      message.subtype === "session_state_changed"
    ) {
      this.reportsState = true;
      if (message.state === "idle" && this.pending) this.done();
      return;
    }
    if (message.type !== "result") return;
    // An interrupt is not a failure to report.
    if (message.is_error && message.terminal_reason !== "aborted_streaming")
      this.lastError =
        typeof message.result === "string" && message.result
          ? message.result
          : `Claude Code stopped (${String(message.subtype)})`;
    if (!this.reportsState && this.pending) this.done();
  }
  private done() {
    const error = this.lastError;
    this.settle(error ? { ok: false, error } : { ok: true });
  }
  /** Answers what Claude Code asks its host. Permissions are bypassed, so this
   * only keeps an unexpected request from stalling the turn. */
  private answer(message: Message) {
    const id = message.request_id;
    const request = (message.request ?? {}) as Message;
    const response =
      request.subtype === "can_use_tool"
        ? {
            subtype: "success",
            request_id: id,
            response: { behavior: "allow", updatedInput: request.input ?? {} },
          }
        : request.subtype === "hook_callback"
          ? { subtype: "success", request_id: id, response: {} }
          : {
              subtype: "error",
              request_id: id,
              error: `Buzz does not handle ${String(request.subtype)}`,
            };
    return this.write({ type: "control_response", response }).catch(
      () => undefined,
    );
  }
}
