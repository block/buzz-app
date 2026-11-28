import type { RelayEvent } from "../relay/events";

/** The owner asks one of their agents to stop its turn in a conversation.
 * NIP-AO `cancel_turn` names no thread and stops the whole conversation, as
 * for a Solo chat or DM. `cancel_thread_turn` stops one thread; a host too old
 * to read it ignores it, rather than stopping another thread. */
export type CancelTurn = Readonly<
  | { type: "cancel_turn"; channelId: string; requestId: string }
  | {
      type: "cancel_thread_turn";
      channelId: string;
      threadRootId: string;
      requestId: string;
    }
>;
/** `sent` means the turn was signalled, not that it has ended. Only a
 * `cancel_turn` can be `ambiguous_target`. */
export type CancelTurnStatus = "sent" | "no_active_turn" | "ambiguous_target";
/** An agent's `control_result` telemetry answering a stop. */
export type ControlResult = Readonly<{
  agent: string;
  channelId: string;
  type: CancelTurn["type"];
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

const STATUSES: Readonly<Record<CancelTurn["type"], ReadonlySet<string>>> = {
  cancel_turn: new Set(["sent", "no_active_turn", "ambiguous_target"]),
  cancel_thread_turn: new Set(["sent", "no_active_turn"]),
};
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** The answer to a stop in decoded telemetry from `agent`, if it is one. */
export function controlResult(
  agent: string,
  value: unknown,
): ControlResult | undefined {
  const frame = object(value);
  const payload = object(frame?.payload);
  const type = payload?.type;
  if (
    frame?.kind !== "control_result" ||
    typeof frame.channelId !== "string" ||
    (type !== "cancel_turn" && type !== "cancel_thread_turn") ||
    typeof payload?.requestId !== "string" ||
    typeof payload.status !== "string" ||
    !STATUSES[type].has(payload.status)
  )
    return undefined;
  return Object.freeze({
    agent,
    channelId: frame.channelId,
    type,
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
    /** Sends `cancel_thread_turn` for a place with a thread, else
     * `cancel_turn`. Resolves on the first `sent`. A `no_active_turn` or
     * `ambiguous_target` settles only after `CONTROL_HOLD_MS` without a
     * `sent`. Rejects with `ControlUnanswered` when no answer arrives in
     * `CONTROL_ANSWER_MS`, as from a host too old for a thread stop. */
    cancelTurn(
      agent: string,
      place: Readonly<{ channelId: string; threadRootId?: string | undefined }>,
      signal: AbortSignal,
    ): Promise<CancelTurnStatus> {
      const requestId = crypto.randomUUID();
      const payload: CancelTurn = place.threadRootId
        ? {
            type: "cancel_thread_turn",
            channelId: place.channelId,
            threadRootId: place.threadRootId,
            requestId,
          }
        : { type: "cancel_turn", channelId: place.channelId, requestId };
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
            if (
              result.type !== payload.type ||
              result.requestId !== requestId ||
              result.agent !== agent
            )
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
          const event = await deps.sign(agent, payload, bounded);
          bounded.throwIfAborted();
          // Checked after signing, which can outlast a reconnect, and in the
          // same task as publishing: a frame sent before the observer is
          // live again could have its answer lost.
          while (!deps.activity.listening())
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
          await deps.publish(event, bounded);
        };
        send().catch((error: unknown) => {
          if (!done.signal.aborted) settle(() => reject(error));
        });
      });
    },
  };
}
