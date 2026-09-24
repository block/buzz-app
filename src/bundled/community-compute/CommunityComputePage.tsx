import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  emptySharing,
  type SharingSource,
} from "../../features/community-compute/sharing";
import { observeNativeSharing } from "../../features/community-compute/native";
import type { ComputeStatus } from "../../features/community-compute/status";
import type { RelayData } from "../../features/relay/service";
import { CommunityComputeView } from "./CommunityComputeView";

const noopSubscribe = () => () => {};
const emptyRuntime = () => emptySharing;
const loading: ComputeStatus = { state: "loading" };
const emptyStatus = () => loading;

export function CommunityComputePage({ relay }: { relay: RelayData }) {
  const session = useSyncExternalStore(
    relay.subscribe,
    relay.snapshot,
    relay.snapshot,
  );
  // Keep global Stop observable even while the selected relay is disconnected.
  const [sharing, setSharing] = useState<SharingSource>();
  useEffect(() => {
    const host = observeNativeSharing();
    setSharing(host?.source);
    return () => host?.dispose();
  }, []);
  const runtime = useSyncExternalStore(
    sharing?.subscribe ?? noopSubscribe,
    sharing?.snapshot ?? emptyRuntime,
    sharing?.snapshot ?? emptyRuntime,
  );
  const source = session.status === "ready" ? session.compute : undefined;
  const status = useSyncExternalStore(
    source?.subscribe ?? noopSubscribe,
    source?.snapshot ?? emptyStatus,
    source?.snapshot ?? emptyStatus,
  );
  const native = runtime.status;
  const autoConnect = useRef<string | null>(null);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nativeGeneration = native?.generation;
  const canStart =
    session.status === "ready" && !!session.community && !!session.viewer;
  const controls =
    native?.available && sharing
      ? {
          status: native,
          models: runtime.models,
          canStart,
          start: (request: Parameters<SharingSource["start"]>[0]) => {
            if (!canStart || !session.community || !session.viewer)
              return Promise.reject(
                new Error("Connect to a community before sharing"),
              );
            return sharing.start(request, {
              community: session.community,
              viewer: session.viewer,
            });
          },
          stop: () => sharing.stop(native.generation),
        }
      : undefined;
  useEffect(() => {
    const community = session.community;
    const viewer = session.viewer;
    if (!sharing || !canStart || !community || !viewer) return;
    const scope = `${community}\n${viewer}`;
    const reconnectingClient =
      native?.state === "failed" &&
      (native.mode === "client" || native.preferredMode === "client");
    if (native?.state === "running" && native.mode === "client") {
      autoConnect.current = scope;
      if (reconnectAttempt) setReconnectAttempt(0);
      return;
    }
    if (native?.state !== "off" && !reconnectingClient) return;
    if (reconnectingClient) autoConnect.current = null;
    if (autoConnect.current === scope) return;
    autoConnect.current = scope;
    void (async () => {
      if (reconnectingClient && nativeGeneration !== undefined)
        await sharing.stop(nativeGeneration);
      await sharing.start(
        { mode: "client", modelId: "remote" },
        { community, viewer },
      );
    })().catch(() => {
      autoConnect.current = null;
      if (reconnectTimer.current !== null) clearTimeout(reconnectTimer.current);
      const delay = Math.min(30_000, 1_000 * 2 ** reconnectAttempt);
      reconnectTimer.current = setTimeout(() => {
        reconnectTimer.current = null;
        setReconnectAttempt((attempt) => attempt + 1);
      }, delay);
    });
  }, [
    sharing,
    canStart,
    session.community,
    session.viewer,
    native?.state,
    native?.mode,
    nativeGeneration,
    native?.preferredMode,
    reconnectAttempt,
  ]);
  useEffect(
    () => () => {
      if (reconnectTimer.current !== null) clearTimeout(reconnectTimer.current);
    },
    [],
  );
  const statusError =
    session.status !== "ready"
      ? (session.error ?? "Connect to a community to see its shared compute.")
      : !source
        ? "Live compute status requires the desktop build."
        : status.error;
  return (
    <CommunityComputeView
      {...(controls ? { controls } : {})}
      {...(native?.community
        ? { communityName: new URL(native.community).host }
        : {})}
      {...(runtime.error ? { sharingError: runtime.error } : {})}
      {...(statusError ? { statusError } : {})}
      {...(native?.apiBaseUrl ? { apiBaseUrl: native.apiBaseUrl } : {})}
      {...(native?.generation !== undefined
        ? { generation: native.generation }
        : {})}
      snapshot={status.state === "ready" ? (status.snapshot ?? null) : null}
      retryStatus={
        session.status === "ready" && source ? source.retry : relay.retry
      }
    />
  );
}
