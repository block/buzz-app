import type { RelayData } from "../../../features/relay/service";
import type { RelaySession } from "../../../features/relay/session";
import type { BuilderlabSession, Credential } from "../session";
import type { AgentClient } from "./client";

/** Recover missed terminals without archiving telemetry or owning another timer.
 * Each stale task is read once per live connection; the client owns read retries. */
export function startTurnStatusRecovery({
  relay,
  session,
  client,
}: {
  relay: RelayData;
  session: BuilderlabSession;
  client: AgentClient;
}) {
  let current: RelaySession | undefined;
  let credential: Credential | undefined;
  let stopActivity: (() => void) | undefined;
  let controller: AbortController | undefined;
  let disposed = false;
  const attempted = new Set<string>();

  function attach() {
    const connection = relay.snapshot();
    const signedIn = session.snapshot();
    const next =
      connection.status === "ready" &&
      !connection.cached &&
      signedIn.status === "signed-in" &&
      signedIn.account?.canUseRemoteAgents
        ? connection.session
        : undefined;
    const account = next ? session.credential() : undefined;
    if (next === current && account === credential) return;
    stopActivity?.();
    controller?.abort();
    controller = undefined;
    attempted.clear();
    current = next;
    credential = account;
    if (!next) return;
    const activity = next.agentActivity;
    let running = false;
    let halted = false;
    async function run() {
      if (disposed || current !== next || credential !== account) return;
      if (activity.snapshot().status !== "listening") {
        controller?.abort();
        controller = undefined;
        attempted.clear();
        halted = false;
        return;
      }
      if (running || halted) return;
      controller ??= new AbortController();
      const active = controller;
      running = true;
      try {
        for (;;) {
          active.signal.throwIfAborted();
          const retained = activity.snapshot().turns;
          const keys = new Set(
            retained.map((turn) => `${turn.agent}:${turn.turnId}`),
          );
          for (const key of attempted)
            if (!keys.has(key)) attempted.delete(key);
          const unknown = retained.filter(
            (turn) =>
              turn.state === "unknown" &&
              turn.sessionId &&
              turn.channelId &&
              !attempted.has(`${turn.agent}:${turn.turnId}`),
          );
          const first = unknown[0];
          if (!first?.sessionId || !first.channelId) break;
          const group = unknown
            .filter(
              (turn) =>
                turn.agent === first.agent &&
                turn.sessionId === first.sessionId &&
                turn.channelId === first.channelId,
            )
            .slice(0, 64);
          for (const turn of group)
            attempted.add(`${turn.agent}:${turn.turnId}`);
          const listed = await client.list(active.signal);
          if (!listed.some((agent) => agent.pubkey === first.agent)) continue;
          const outcomes = await client
            .turnStatus(
              first.sessionId,
              group.map((turn) => turn.turnId),
              active.signal,
            )
            .catch((error) => {
              // A forgotten session must not prevent other sessions recovering.
              if (
                error instanceof Error &&
                "status" in error &&
                error.status === 404
              )
                return new Map<string, "ended" | "error" | "stopped">();
              throw error;
            });
          active.signal.throwIfAborted();
          for (const turn of group) {
            const outcome = outcomes.get(turn.turnId);
            if (outcome) activity.reconcile(turn, outcome);
          }
        }
      } catch (error) {
        if (!active.signal.aborted) {
          halted = true;
          console.warn(
            "Builderlab turn status recovery failed; retrying after reconnect",
            error,
          );
        }
      } finally {
        running = false;
        // A reconnect may have arrived while an aborted request was unwinding.
        if (
          active.signal.aborted &&
          current === next &&
          credential === account &&
          !disposed
        )
          void run();
      }
    }
    stopActivity = activity.subscribe(() => void run());
    void run();
  }
  const stopRelay = relay.subscribe(attach);
  const stopLogin = session.subscribe(attach);
  attach();
  return () => {
    disposed = true;
    stopRelay();
    stopLogin();
    stopActivity?.();
    controller?.abort();
  };
}
