import { invoke, isTauri } from "@tauri-apps/api/core";
import type { MeshSnapshot } from "../../bundled/community-compute/types";
import type { ReadTransport } from "../relay/transport";
import { createSharingSource } from "./sharing";
import { createComputeStatus } from "./status";

export function nativeComputeStatus(transport: ReadTransport) {
  if (!isTauri()) return undefined;
  const status = createComputeStatus(transport, (events, authority, viewer) =>
    invoke<MeshSnapshot>("community_compute_snapshot", {
      events,
      authority,
      viewer,
    }),
  );
  return status;
}

export function observeNativeSharing() {
  return isTauri() ? createSharingSource(invoke) : undefined;
}

export function openComputeWidget() {
  return invoke<void>("compute_widget_open");
}
