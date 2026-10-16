// One agent's goose sessions, in the `goose-acp` process all goose agents
// share. The sessions themselves live in the shared ACP client.
import {
  AgentSessions as AcpAgentSessions,
  absolute,
  type SessionsOptions as AcpSessionsOptions,
} from "../../features/agent-harness/acp/agent-sessions";
import type { AcpProcess } from "../../features/agent-harness/acp/process";
import { GooseProcess, type ServeMcp, type Spawn } from "./goose";

export {
  absolute,
  IDLE_MS,
  POOL_LIMIT,
  ServerPool,
  type Launch,
} from "../../features/agent-harness/acp/agent-sessions";

/** The one `goose-acp` every goose agent's sessions open in, started in the
 * home folder when a session first needs it, and again after it exits. One
 * runtime shares one. */
export class SharedProcess {
  private ready: Promise<AcpProcess> | undefined;
  constructor(
    private readonly spawn: Spawn,
    /** Starts a session's MCP server for its agent's tools. */
    private readonly serve: ServeMcp,
  ) {}

  /** The running process. One that failed to start is started again on the
   * next call. */
  get(): Promise<AcpProcess> {
    if (this.ready) return this.ready;
    const ready = (async () =>
      GooseProcess.start(this.spawn, {
        cwd: await absolute(this.spawn, "~"),
        serve: this.serve,
      }))();
    const forget = () => {
      if (this.ready === ready) this.ready = undefined;
    };
    void ready.then((goose) => goose.exited.then(forget), forget);
    this.ready = ready;
    return ready;
  }
  /** Stops it, failing every session in it. */
  stop() {
    const ready = this.ready;
    this.ready = undefined;
    void ready?.then((goose) => goose.kill()).catch(() => undefined);
  }
}

export type SessionsOptions = Omit<AcpSessionsOptions, "label">;

/** An agent's sessions, in the process all goose agents share. */
export class AgentSessions extends AcpAgentSessions {
  constructor(options: SessionsOptions) {
    super({ ...options, label: "goose" });
  }
}
