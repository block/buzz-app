import { useEffect, useState, useSyncExternalStore } from "react";
import {
  emptySharing,
  type SharingSource,
} from "../../features/community-compute/sharing";
import {
  openComputeWidget,
  observeNativeSharing,
} from "../../features/community-compute/native";
import type { ComputeStatus } from "../../features/community-compute/status";
import type { RelayData } from "../../features/relay/service";
import { ConsumerComputeView } from "./ConsumerComputeView";
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
  const statusError =
    session.status !== "ready"
      ? (session.error ?? "Connect to a community to see its shared compute.")
      : !source
        ? "Live compute status requires the desktop build."
        : status.error;
  if (native?.preferredMode === "client" && controls)
    return (
      <ConsumerComputeView
        status={native}
        controls={controls}
        {...(runtime.error || statusError
          ? { error: runtime.error || statusError }
          : {})}
      />
    );
  return (
    <CommunityComputeView
      {...(controls ? { controls, openWidget: openComputeWidget } : {})}
      {...(native?.community
        ? { communityName: new URL(native.community).host }
        : {})}
      {...(runtime.error ? { sharingError: runtime.error } : {})}
      {...(statusError ? { statusError } : {})}
      snapshot={status.state === "ready" ? (status.snapshot ?? null) : null}
      retryStatus={
        session.status === "ready" && source ? source.retry : relay.retry
      }
    />
  );
}
