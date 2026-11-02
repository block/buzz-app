import type { HostMcpServer } from "../host/service";
import type { AgentKey } from "./membership";
import type { Agents } from "./service";

type State = Readonly<{
  phase: "off" | "starting" | "waiting" | "connected" | "ended";
  agent?: AgentKey;
}>;

/** One grant per plugin runtime. Descriptors never enter render state or storage. */
export function createExternalConnection(
  agents: Pick<Agents, "connectExternal">,
) {
  let state: State = { phase: "off" };
  let controller: AbortController | undefined;
  let server: HostMcpServer | undefined;
  const listeners = new Set<() => void>();
  const update = (next: State) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const revoke = async () => {
    controller?.abort();
    controller = undefined;
    const previous = server;
    server = undefined;
    update({ phase: "off" });
    await previous?.close();
  };
  return {
    snapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    revoke,
    async create(agent: AgentKey) {
      const closing = revoke();
      const attempt = new AbortController();
      controller = attempt;
      update({ phase: "starting", agent });
      try {
        await closing;
        if (controller !== attempt) return;
        const result = await agents.connectExternal(
          agent,
          attempt.signal,
          () => {
            if (controller === attempt) update({ phase: "connected", agent });
          },
        );
        if (controller !== attempt) {
          await result.close();
          return;
        }
        server = result;
        if (state.phase === "starting") update({ phase: "waiting", agent });
        void result.closed.then(() => {
          if (controller !== attempt) return;
          attempt.abort();
          server = undefined;
          controller = undefined;
          update({ phase: "ended", agent });
        });
      } catch (error) {
        if (controller !== attempt) return;
        attempt.abort();
        controller = undefined;
        update({ phase: "ended", agent });
        throw error;
      }
    },
    descriptor() {
      if (!server || state.phase !== "waiting")
        throw new Error("Create a new connection to pair Nexus.");
      const authorization = server.headers.find(
        (header) => header.name.toLowerCase() === "authorization",
      )?.value;
      if (!authorization?.startsWith("Bearer "))
        throw new Error("The connection has no bearer token.");
      return JSON.stringify({
        version: 1,
        url: server.url,
        token: authorization.slice(7),
      });
    },
  };
}
export type ExternalConnection = ReturnType<typeof createExternalConnection>;
