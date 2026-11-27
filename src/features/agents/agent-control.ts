import type { RelayEvent } from "../relay/events";

/** NIP-AO `cancel_turn`: the owner asks one of their agents to stop its turn
 * in a conversation. `threadRootId` names one thread; without it the whole
 * conversation, as for a Solo chat or DM. */
export type CancelTurn = Readonly<{
  type: "cancel_turn";
  channelId: string;
  threadRootId?: string;
  requestId: string;
}>;
/** `sent` means the turn was signalled, not that it has ended. */
export type CancelTurnStatus = "sent" | "no_active_turn" | "ambiguous_target";
/** An agent's `control_result` telemetry answering a `cancel_turn`. */
export type ControlResult = Readonly<{
  agent: string;
  channelId: string;
  requestId: string;
  status: CancelTurnStatus;
}>;

/** How long a Stop waits for the agent's answer. */
export const CONTROL_ANSWER_MS = 10_000;
/** How long `no_active_turn` waits for a `sent` from another device holding
 * the same agent. */
export const CONTROL_HOLD_MS = 2_000;

/** Nobody answered within `CONTROL_ANSWER_MS`: the device may be offline, or
 * its app or the relay too old to deliver the request. */
export class ControlUnanswered extends Error {
  constructor() {
    super("The agent didn't answer");
  }
}

const STATUSES = new Set<string>([
  "sent",
  "no_active_turn",
  "ambiguous_target",
]);
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** The `cancel_turn` answer in decoded telemetry from `agent`, if it is one. */
export function controlResult(
  agent: string,
  value: unknown,
): ControlResult | undefined {
  const frame = object(value);
  const payload = object(frame?.payload);
  if (
    frame?.kind !== "control_result" ||
    typeof frame.channelId !== "string" ||
    payload?.type !== "cancel_turn" ||
    typeof payload.requestId !== "string" ||
    typeof payload.status !== "string" ||
    !STATUSES.has(payload.status)
  )
    return undefined;
  return Object.freeze({
    agent,
    channelId: frame.channelId,
    requestId: payload.requestId,
    status: payload.status as CancelTurnStatus,
  });
}

type Listening = Readonly<{
  /** Holds the observer route open while a stop waits. */
  activate(): () => void;
  listening(): boolean;
  subscribe(listener: () => void): () => void;
  controlResults(listener: (result: ControlResult) => void): () => void;
}>;

/** Sends `cancel_turn` frames on the owner's connection and settles each on
 * its agent's `control_result`, matched by request ID. */
export function createAgentControl(deps: {
  /** The host's purpose-bound signer: encrypts to `agent` with the owner's
   * key. */
  sign(
    agent: string,
    payload: CancelTurn,
    signal: AbortSignal,
  ): Promise<RelayEvent>;
  publish(event: RelayEvent, signal: AbortSignal): Promise<unknown>;
  activity: Listening;
}) {
  return {
    /** Resolves on the first `sent`. A `no_active_turn` or `ambiguous_target`
     * settles only after `CONTROL_HOLD_MS` without a `sent`. Rejects with
     * `ControlUnanswered` when no answer arrives in `CONTROL_ANSWER_MS`. */
    cancelTurn(
      agent: string,
      place: Readonly<{ channelId: string; threadRootId?: string | undefined }>,
      signal: AbortSignal,
    ): Promise<CancelTurnStatus> {
      const requestId = crypto.randomUUID();
      const payload: CancelTurn = {
        type: "cancel_turn",
        channelId: place.channelId,
        ...(place.threadRootId ? { threadRootId: place.threadRootId } : {}),
        requestId,
      };
      const stops: (() => void)[] = [];
      const done = new AbortController();
      const bounded = AbortSignal.any([signal, done.signal]);
      return new Promise<CancelTurnStatus>((resolve, reject) => {
        let held: CancelTurnStatus | undefined;
        let hold: ReturnType<typeof setTimeout> | undefined;
        const settle = (finish: () => void) => {
          if (done.signal.aborted) return;
          done.abort();
          clearTimeout(hold);
          for (const stop of stops) stop();
          finish();
        };
        const answer = setTimeout(
          () =>
            settle(() =>
              held ? resolve(held) : reject(new ControlUnanswered()),
            ),
          CONTROL_ANSWER_MS,
        );
        stops.push(() => clearTimeout(answer));
        const aborted = () => settle(() => reject(signal.reason));
        if (signal.aborted) return aborted();
        signal.addEventListener("abort", aborted, { once: true });
        stops.push(() => signal.removeEventListener("abort", aborted));
        // Listen before sending, so an answer can't arrive unheard.
        stops.push(
          deps.activity.controlResults((result) => {
            if (result.requestId !== requestId || result.agent !== agent)
              return;
            if (result.status === "sent") return settle(() => resolve("sent"));
            // Another device holding the agent may still stop it.
            if (held !== "ambiguous_target") held = result.status;
            hold ??= setTimeout(
              () => settle(() => resolve(held ?? result.status)),
              CONTROL_HOLD_MS,
            );
          }),
        );
        stops.push(deps.activity.activate());
        const send = async () => {
          if (!deps.activity.listening())
            await new Promise<void>((ready, failed) => {
              const check = () => {
                if (deps.activity.listening()) {
                  stop();
                  ready();
                }
              };
              const stop = deps.activity.subscribe(check);
              const abort = () => {
                stop();
                failed(bounded.reason);
              };
              bounded.addEventListener("abort", abort, { once: true });
              stops.push(stop, () =>
                bounded.removeEventListener("abort", abort),
              );
              check();
            });
          const event = await deps.sign(agent, payload, bounded);
          bounded.throwIfAborted();
          await deps.publish(event, bounded);
        };
        send().catch((error: unknown) => {
          if (!done.signal.aborted) settle(() => reject(error));
        });
      });
    },
  };
}
