import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { RelaySession } from "../relay/session";
import type { ChannelSummary } from "../relay/contracts";
import {
  detailsDraftErrors,
  type ChannelDetails,
} from "../relay/channel-details-protocol";
import { DEFAULT_TEMPORARY_CHANNEL_TTL_SECONDS } from "../relay/work-sessions";
import { sessionMetadata } from "./metadata";

/** Presentation only: the details owner rechecks fresh signed edit authority. */
export function canEditSessionLifetime(
  session: RelaySession,
  channel?: ChannelSummary,
) {
  return !!(
    session.channelDetails?.available &&
    channel?.channelType === "session" &&
    !channel.parentChannelId &&
    !channel.cached &&
    !channel.readOnly &&
    !channel.archived
  );
}

export function useSessionLifetime({
  session,
  id,
  signal,
  enabled,
}: {
  session: RelaySession;
  id: string;
  signal?: AbortSignal | undefined;
  enabled: boolean;
}) {
  const details = session.channelDetails;
  const attempt = useSyncExternalStore(details?.subscribe ?? noSubscribe, () =>
    enabled ? details?.snapshot(id) : undefined,
  );
  const [base, setBase] = useState<ChannelDetails>();
  const [ttl, setTtl] = useState<number | undefined>(attempt?.draft.ttlSeconds);
  const [temporaryTtl, setTemporaryTtl] = useState(
    DEFAULT_TEMPORARY_CHANNEL_TTL_SECONDS,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lifetime = useRef<AbortController | undefined>(undefined);
  const pending = useRef(false);
  const confirmedTtl = useRef<number | undefined>(undefined);
  const refreshBeforeSave = useRef(false);
  const metadata = base && sessionMetadata(base.description);
  const eligible = !!base?.canEdit && !!metadata && !metadata.parentId;
  const matchingAttempt = !!(
    base &&
    attempt &&
    metadata &&
    !metadata.parentId &&
    attempt.draft.description === base.description &&
    attempt.draft.name === base.name &&
    attempt.draft.visibility === base.visibility
  );
  const invalid =
    base && detailsDraftErrors({ ...base, ttlSeconds: ttl }).lifetime;

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    lifetime.current = controller;
    const active = AbortSignal.any([
      controller.signal,
      ...(signal ? [signal] : []),
    ]);
    setBase(undefined);
    setError("");
    setBusy(false);
    pending.current = false;
    void details
      .load(id, active)
      .then((next) => {
        if (!active.aborted) {
          setBase(next);
          const saved = details.snapshot(id);
          confirmedTtl.current = next.ttlSeconds;
          const ttl = matchesLifetime(next, saved?.draft)
            ? saved?.draft.ttlSeconds
            : next.ttlSeconds;
          setTtl(ttl);
          setTemporaryTtl(ttl ?? DEFAULT_TEMPORARY_CHANNEL_TTL_SECONDS);
        }
      })
      .catch((reason) => {
        if (!active.aborted)
          setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => controller.abort();
  }, [details, id, signal, enabled]);

  const run = async (action: "save" | "reload" | "check") => {
    const controller = lifetime.current;
    if (
      !controller ||
      controller.signal.aborted ||
      signal?.aborted ||
      pending.current
    )
      return;
    const active = AbortSignal.any([
      controller.signal,
      ...(signal ? [signal] : []),
    ]);
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      if (action === "reload") {
        const next = await details.load(id, active);
        if (!active.aborted) {
          if (!base) {
            const saved = details.snapshot(id);
            const ttl = matchesLifetime(next, saved?.draft)
              ? saved?.draft.ttlSeconds
              : next.ttlSeconds;
            setTtl(ttl);
            setTemporaryTtl(ttl ?? DEFAULT_TEMPORARY_CHANNEL_TTL_SECONDS);
          }
          confirmedTtl.current = next.ttlSeconds;
          refreshBeforeSave.current = false;
          setBase(next); // Retain the person's lifetime choice on conflict.
        }
      } else {
        if (action === "check") {
          if (!matchingAttempt || attempt?.status !== "unconfirmed") return;
          await details.check(id, active);
        } else {
          if (!base || !eligible || attempt || invalid) return;
          if (ttl !== confirmedTtl.current) {
            const current = refreshBeforeSave.current
              ? await details.load(id, active)
              : base;
            active.throwIfAborted();
            const metadata = sessionMetadata(current.description);
            if (!current.canEdit || !metadata || metadata.parentId)
              throw new Error(
                "This conversation is no longer an editable standalone session. Reload session details before changing its lifetime.",
              );
            await details.save(
              current,
              { ...current, ttlSeconds: ttl },
              active,
            );
          }
        }
        active.throwIfAborted();
        confirmedTtl.current =
          action === "check" ? attempt?.draft.ttlSeconds : ttl;
        refreshBeforeSave.current = true;
      }
    } catch (reason) {
      if (!active.aborted)
        setError(reason instanceof Error ? reason.message : String(reason));
      throw reason;
    } finally {
      if (!controller.signal.aborted) {
        pending.current = false;
        setBusy(false);
      }
    }
  };
  return {
    available: enabled && !metadata?.parentId,
    base,
    ttl,
    temporaryTtl,
    busy,
    error,
    invalid,
    eligible,
    changed: !!base && ttl !== confirmedTtl.current,
    checkOnly: matchingAttempt && attempt?.status === "unconfirmed",
    blocked: !!attempt || !eligible || !!invalid || !!signal?.aborted,
    unrelatedAttempt: !!attempt && !matchingAttempt,
    run,
    change(next: number | undefined) {
      setTtl(next);
      if (next !== undefined) setTemporaryTtl(next);
    },
  };
}

const noSubscribe = () => () => {};
function matchesLifetime(
  base: ChannelDetails,
  draft?: Pick<ChannelDetails, "name" | "description" | "visibility">,
) {
  return (
    !!draft &&
    draft.description === base.description &&
    draft.name === base.name &&
    draft.visibility === base.visibility &&
    !sessionMetadata(base.description)?.parentId
  );
}
