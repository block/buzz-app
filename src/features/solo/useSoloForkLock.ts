import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { RelaySession } from "../relay/session";
import type { ChannelSummary } from "../relay/contracts";
import { readSoloSeed, type SoloSeed } from "../relay/solo-fork-history";

import { forkFailures } from "./fork-failure";

/** A composer guard only. Required ancestry never becomes an empty successful read. */
export function useSoloForkLock(
  session: RelaySession,
  channel?: ChannelSummary,
) {
  const id = channel?.id;
  const enabled = channel?.forkClaim === true;
  const pending = !!(channel?.pending || channel?.metadataPending);
  const [attempt, retry] = useState(0);
  const createEventId = useSyncExternalStore(
    (listener) =>
      enabled ? (session.outbox?.subscribe(listener) ?? (() => {})) : () => {},
    () =>
      enabled && id
        ? session.outbox
            ?.snapshot()
            .find((row) => row.recovery?.key === `solo-fork:${id}`)?.signed?.id
        : undefined,
  );
  const failure = useSyncExternalStore(
    (listener) => forkFailures.subscribe(session, listener),
    () => (enabled && id ? forkFailures.get(session, id) : undefined),
  );
  // Fence in render, not just effect cleanup: retries and pending transitions
  // must never borrow a successful read from the previous request.
  const request = useMemo(
    () => ({ session, id, enabled, pending, attempt }),
    [session, id, enabled, pending, attempt],
  );
  const [result, setResult] = useState<{
    request: typeof request;
    seed?: SoloSeed;
    error?: string;
  }>();
  useEffect(() => {
    const { session, id, enabled } = request;
    if (!enabled || !id) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(30_000),
    ]);
    const priorFailure = forkFailures.get(session, id);
    void (async () => {
      // A local create must settle before strong signed metadata can be read.
      await session.channelWrites.starting(id);
      signal.throwIfAborted();
      await session.channelWrites.resumeFork(
        id,
        request.attempt > 0,
        () => !signal.aborted,
      );
      signal.throwIfAborted();
      const seed = await readSoloSeed(
        {
          read: (filters, caller) =>
            session.read(filters, { signal: caller, fresh: true }),
          relayAuthor: () => session.relayAuthor,
        },
        id,
        signal,
        session.workflowAuthority
          ? { signingAuthority: session.workflowAuthority }
          : {},
      );
      if (!seed)
        throw new Error("The fork’s signed ancestry could not be confirmed.");
      if (!controller.signal.aborted) {
        forkFailures.clear(session, id, priorFailure);
        setResult({ request, seed });
      }
    })().catch((error: unknown) => {
      if (!controller.signal.aborted)
        setResult({
          request,
          error: error instanceof Error ? error.message : String(error),
        });
    });
    return () => controller.abort();
  }, [request]);
  const current = result?.request === request ? result : undefined;
  const disabled =
    enabled && (!current || !!current.error || !!failure || pending);
  return {
    disabled,
    createEventId,
    pending: enabled && !failure && (!current || (pending && !current.error)),
    reason: disabled
      ? (failure?.reason ?? current?.error ?? "Confirming chat context…")
      : undefined,
    seed: enabled && !failure ? current?.seed : undefined,
    retry: () => retry((value) => value + 1),
  };
}
