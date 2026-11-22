import {
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "../../shared/design-system/ui/Button";
import { formatPublicKey } from "../../shared/identity/public-key";
import type { HostService } from "../host/service";
import type { ChannelMessage } from "../relay/contracts";
import type { RelaySession } from "../relay/session";

/** Actual reader target, supplied by the host, never by the contribution. */
export type ReviewReader = Readonly<{
  session: RelaySession;
  channel: string;
  root?: string | undefined;
}>;

export function ReviewedInvocationReview({
  host,
  owner,
  locator,
  message,
  reader,
  current,
  children,
}: {
  host: HostService;
  owner: Readonly<{ id: string; revision: string }>;
  locator(message: ChannelMessage): string | undefined;
  message: ChannelMessage;
  reader: ReviewReader | undefined;
  current(): boolean;
  children: ReactNode;
}) {
  const operation = useSyncExternalStore(
    host.reviewed.subscribe,
    host.reviewed.snapshot,
    host.reviewed.snapshot,
  );
  let callId: string | undefined;
  try {
    callId = locator(message);
  } catch {
    /* A broken locator grants nothing. */
  }
  const matches =
    operation?.callId === callId &&
    operation?.pluginId === owner.id &&
    operation?.revision === owner.revision;
  const projection = matches ? operation?.projection : undefined;
  const destination = projection?.request.destination;
  const effect = projection?.request.effect;
  const expected = projection?.request.expectedMedia;
  // From the row's signed tags: a root row is its own thread.
  const thread = message.threadRootId ?? message.id;
  const sameReader =
    !!reader &&
    operation?.session === reader.session &&
    destination?.channel === reader.channel &&
    destination?.root === reader.root &&
    (destination?.sourceRoot === undefined ||
      destination.sourceRoot === thread) &&
    message.channelId === reader.channel;
  const identity = useMemo(
    () => ({
      callId,
      content: message.content,
      session: reader?.session,
      channel: reader?.channel,
      root: reader?.root,
      thread,
    }),
    [
      callId,
      message.content,
      reader?.session,
      reader?.channel,
      reader?.root,
      thread,
    ],
  );
  const binding = useRef<typeof identity | null>(null);
  const mount = useRef({});
  const mounted = useRef<object | null>(null);
  const latest = useRef({ current, sameReader, matches });
  useLayoutEffect(() => {
    latest.current = { current, sameReader, matches };
  });
  useLayoutEffect(() => {
    if (binding.current?.callId !== callId) binding.current = null;
    mounted.current = identity;
    const bound =
      matches &&
      callId !== undefined &&
      identity.channel === message.channelId &&
      latest.current.current() &&
      host.reviewed.bind(callId, mount.current, identity);
    if (bound && binding.current === null) binding.current = identity;
    return () => {
      mounted.current = null;
      // React's same-instance effect replay is not a new operation. Real removal
      // (including a fresh remount in the same task) retires the original call.
      queueMicrotask(() => {
        if (mounted.current !== identity && bound && callId)
          void host.reviewed.retire(callId).catch(() => {});
      });
    };
  }, [host, identity, matches, callId, message.channelId]);
  if (!matches) return children;
  const pending = operation?.status === "pending";
  const activate = () => {
    const now = host.reviewed.snapshot();
    if (
      binding.current !== identity ||
      mounted.current !== identity ||
      !callId ||
      !host.reviewed.bind(callId, mount.current, identity) ||
      !latest.current.current() ||
      !latest.current.sameReader ||
      !latest.current.matches ||
      !projection ||
      now !== operation ||
      !pending ||
      Date.now() >= projection.expiresAt
    )
      return;
    // Local duplicate latch precedes IPC; native independently consumes once.
    host.reviewed.update({ ...operation, status: "dispatching" });
    void invoke("plugin_host_reviewed_dispatch", {
      callId,
      id: owner.id,
      revision: owner.revision,
      digest: projection.digest,
      destination: projection.request.destination,
    })
      .catch(() => host.reviewed.retire(projection.callId))
      .catch(() => {});
  };
  return (
    <>
      {children}
      <section
        aria-label="Review operation"
        className="flex min-w-0 flex-col gap-3 text-body-sm text-default"
      >
        {projection && (
          <>
            {effect && (
              <p className="break-all">
                {effect.method} {effect.url} · Saved credential: {effect.slot}
              </p>
            )}
            {expected && (
              <p className="break-words">
                Expected result: {expected.width}×{expected.height} MP4 (H.264)
                · {expected.durationMs / 1000} s ± {expected.toleranceMs} ms ·
                up to {Math.round((expected.maxBytes / 1048576) * 10) / 10} MB
              </p>
            )}
            {projection.resultUrl === 1 && (
              <p className="break-words">
                Download one result from the service’s response · no credential
                sent
              </p>
            )}
            <p className="whitespace-pre-wrap break-words">
              {projection.request.body}
            </p>
            {projection.request.disclosure && (
              <p className="whitespace-pre-wrap break-words text-body-sm text-subtle">
                Plugin notes: {projection.request.disclosure.text}
              </p>
            )}
            {projection.author && (
              <p className="break-words text-body-sm text-subtle">
                As agent: {formatPublicKey(projection.author.pubkey)}
              </p>
            )}
            <p className="break-words text-body-sm text-subtle">
              Destination: {destination?.community} · {destination?.viewer} ·{" "}
              {destination?.channel}
              {destination?.root === undefined
                ? " · channel root"
                : destination.sourceRoot === undefined
                  ? ` · thread ${destination.root}`
                  : ` · thread ${destination.sourceRoot} · task ${destination.root}`}
            </p>
            <details>
              <summary>Details</summary>
              <p className="break-all text-body-sm text-subtle">
                Operation: {projection.request.operation} · Request:{" "}
                {projection.digest} · Call: {projection.callId}
                {projection.author && ` · Agent: ${projection.author.pubkey}`}
              </p>
              {effect && (
                <p className="break-all text-body-sm text-subtle">
                  Headers:{" "}
                  {Object.entries(effect.headers)
                    .map(([name, value]) => `${name}: ${value}`)
                    .join(" · ") || "none"}
                  {" · "}Notes version: {projection.request.disclosure?.version}
                </p>
              )}
            </details>
          </>
        )}
        <p role="status">
          {!sameReader && projection
            ? "This operation belongs to another conversation."
            : operation?.status === "pending"
              ? !projection
                ? "Waiting for native review…"
                : effect
                  ? "Review this exact request. Approving sends it once and can’t be undone."
                  : "Review this exact synthetic request. No provider will be called."
              : `Operation ${operation?.status}. No automatic retry.`}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="prominent"
            disabled={
              !pending ||
              !projection ||
              !sameReader ||
              operation?.mount !== mount.current
            }
            onClick={activate}
          >
            Approve and run
          </Button>
          <Button
            disabled={!pending}
            onClick={() => {
              if (callId) void host.reviewed.retire(callId).catch(() => {});
            }}
          >
            Cancel
          </Button>
        </div>
      </section>
    </>
  );
}
