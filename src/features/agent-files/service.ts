// The native side of `agent_read` and `agent_apply`: native code forwards
// each call from a paired command-line tool here and waits for the answer.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type AgentCall = Readonly<{
  id: string;
  method: "agent_read" | "agent_apply";
  params: readonly string[];
  /** Seconds before native code stops waiting. */
  expiresIn: number;
}>;

/** Answers call `id` with its result, or an error code and message. */
export const answerAgentCall = (
  id: string,
  answer:
    | Readonly<{ result: string }>
    | Readonly<{ code: string; message: string }>,
) =>
  invoke<void>("credential_agent_answer", {
    id,
    result: "result" in answer ? answer.result : null,
    code: "code" in answer ? answer.code : null,
    message: "message" in answer ? answer.message : null,
  });

/** Tells native a handler began or stopped listening; while none listens,
 * native refuses the calls at once. */
export const setAgentCallListener = (mounted: boolean) =>
  invoke<void>("credential_agent_listen", { mounted });

/** Calls `on` for each call and each call native stopped waiting for, and
 * `ready` once both listeners are in place; returns a function that stops
 * listening. */
export function onAgentCalls(on: {
  request(call: AgentCall): void;
  closed(id: string): void;
  ready(): void;
}) {
  const stops = [
    listen<AgentCall>("credential-agent-request", (event) =>
      on.request(event.payload),
    ),
    listen<string>("credential-agent-closed", (event) =>
      on.closed(event.payload),
    ),
  ];
  const listening = stops.map((stop) => stop.catch(() => undefined));
  void Promise.all(stops).then(
    () => on.ready(),
    () => undefined,
  );
  return () => {
    for (const stop of listening) void stop.then((unlisten) => unlisten?.());
  };
}
