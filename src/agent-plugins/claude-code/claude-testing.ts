// A stand-in for the `claude` binary's stream-json protocol, for tests.
import type {
  HostProcess,
  HostProcessOptions,
} from "../../features/host/service";

export type FakeClaude = {
  id: string;
  options: HostProcessOptions;
  /** Every JSON message written to its stdin. */
  received: Record<string, unknown>[];
  /** User messages it has taken, in order. */
  prompts: string[];
  /** When set, a turn stays open until `finish()`. */
  hold: boolean;
  killed: boolean;
  emit(message: Record<string, unknown>): void;
  finish(result?: Readonly<{ error?: string }>): void;
  exit(code: number | null, stderr?: string): void;
};

/** A spawn whose `claude` processes answer like Claude Code. Sessions named in
 * `known` (or created by a process) can be resumed; others fail to load. */
export function fakeSpawn(known = new Set<string>()) {
  const processes: FakeClaude[] = [];
  const spawn = async (id: string, options: HostProcessOptions = {}) => {
    let resolveExit!: (code: number | null) => void;
    const exited = new Promise<number | null>((resolve) => {
      resolveExit = resolve;
    });
    const args = options.args ?? [];
    const flag = (name: string) => {
      const index = args.indexOf(name);
      return index >= 0 ? args[index + 1] : undefined;
    };
    const resume = flag("--resume");
    const session = resume ?? flag("--session-id") ?? "fresh";
    let open = 0;
    let started = false;
    let alive = true;
    const fake: FakeClaude = {
      id,
      options,
      received: [],
      prompts: [],
      hold: false,
      killed: false,
      emit(message) {
        if (alive) options.onStdout?.(`${JSON.stringify(message)}\n`);
      },
      finish(result = {}) {
        if (!open) return;
        open = 0;
        fake.emit({
          type: "result",
          subtype: result.error ? "error_during_execution" : "success",
          is_error: !!result.error,
          ...(result.error ? { result: result.error } : {}),
          session_id: session,
        });
        // Claude Code reports idle only when asked to.
        if (options.env?.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS === "1")
          fake.emit({
            type: "system",
            subtype: "session_state_changed",
            state: "idle",
            session_id: session,
          });
      },
      exit(code, stderr) {
        if (!alive) return;
        if (stderr) options.onStderr?.(stderr);
        alive = false;
        resolveExit(code);
      },
    };
    processes.push(fake);
    const take = (message: Record<string, unknown>) => {
      fake.received.push(message);
      if (message.type === "control_request") {
        fake.emit({
          type: "control_response",
          response: { subtype: "success", request_id: message.request_id },
        });
        return;
      }
      if (message.type !== "user") return;
      if (resume && !known.has(resume)) {
        fake.exit(1, `No conversation found with session ID: ${resume}\n`);
        return;
      }
      const content = (message.message as { content: string }).content;
      fake.prompts.push(content);
      if (!started) {
        started = true;
        known.add(session);
        fake.emit({ type: "system", subtype: "init", session_id: session });
      }
      open++;
      fake.emit({
        type: "assistant",
        session_id: session,
        message: { content: [{ type: "text", text: `ok: ${content}` }] },
      });
      if (!fake.hold) fake.finish();
    };
    const process: HostProcess = {
      write: async (data) => {
        if (!alive) throw new Error("Process has exited");
        for (const line of data.split("\n").filter(Boolean))
          take(JSON.parse(line));
      },
      end: async () => undefined,
      kill: async () => {
        fake.killed = true;
        fake.exit(null);
      },
      exited,
    };
    // Output that arrives before spawn returns is buffered by the caller.
    if (id !== "claude") queueMicrotask(() => fake.exit(0));
    return process;
  };
  return { spawn, processes, known };
}

/** Lets queued promise callbacks run. */
export const flush = async (times = 5) => {
  for (let index = 0; index < times; index++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};
