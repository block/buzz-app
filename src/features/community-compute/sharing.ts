import type {
  SharingRequest,
  SharingState,
  ComputeControls,
} from "../../bundled/community-compute/CommunityComputeView";
export type NativeSharingStatus = SharingState & {
  available: boolean;
  preferredMode?: "serve" | "client";
  apiBaseUrl?: string | null;
  generation: number;
  community: string | null;
  viewer: string | null;
};
export type SharingSnapshot = {
  status?: NativeSharingStatus;
  models: ComputeControls["models"];
  error?: string;
};
export type SharingSource = {
  snapshot(): SharingSnapshot;
  subscribe(listener: () => void): () => void;
  start(
    request: SharingRequest,
    scope?: { community: string; viewer: string },
  ): Promise<void>;
  stop(generation: number): Promise<void>;
};
export const emptySharing: SharingSnapshot = { models: [] };
type Invoke = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

/** Observation belongs to the page; the native app owns the process. */
export function createSharingSource(
  invoke: Invoke,
  community?: string,
  viewer?: string,
) {
  let state: SharingSnapshot = emptySharing;
  let disposed = false;
  let epoch = 0;
  let polling = false;
  let catalogLoaded = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();
  const emit = (next: SharingSnapshot) => {
    if (disposed) return;
    state = next;
    for (const fn of listeners) fn();
  };
  const refresh = async () => {
    if (disposed || polling || !listeners.size) return;
    polling = true;
    const current = epoch;
    try {
      const status = await invoke<NativeSharingStatus>(
        "community_compute_status",
      );
      if (disposed || current !== epoch) return;
      emit({ status, models: state.models });
      if (status.available && !catalogLoaded) {
        const catalog = await invoke<{
          entries: {
            name: string;
            size: string;
            recommended: boolean;
            fit: string;
          }[];
        }>("community_compute_models");
        if (disposed || current !== epoch) return;
        catalogLoaded = true;
        emit({
          ...state,
          models: catalog.entries.map((entry) => ({
            id: entry.name,
            label: `${entry.name} (${entry.size})`,
            recommended: entry.recommended,
            tooLarge: entry.fit === "too_large",
          })),
        });
      }
    } catch (error) {
      if (!disposed && current === epoch)
        emit({
          ...state,
          error: error instanceof Error ? error.message : String(error),
        });
    } finally {
      polling = false;
      if (!disposed && listeners.size)
        timer = setTimeout(() => {
          void refresh();
        }, 1000);
    }
  };
  const command = async (name: string, args: Record<string, unknown>) => {
    ++epoch;
    try {
      const status = await invoke<NativeSharingStatus>(name, args);
      ++epoch;
      emit({ status, models: state.models });
    } catch (error) {
      ++epoch;
      throw error;
    }
  };
  const source: SharingSource = {
    snapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      clearTimeout(timer);
      void refresh();
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          ++epoch;
          clearTimeout(timer);
        }
      };
    },
    start(request, scope) {
      if (disposed)
        return Promise.reject(
          new Error("Community session changed; reopen compute"),
        );
      return command("community_compute_start", {
        request: {
          ...request,
          maxVramGb: request.maxVramGb ?? null,
          community: scope?.community ?? community,
          viewer: scope?.viewer ?? viewer,
        },
      });
    },
    stop(generation) {
      if (disposed)
        return Promise.reject(
          new Error("Community session changed; reopen compute"),
        );
      return command("community_compute_stop", { generation });
    },
  };
  return {
    source,
    dispose() {
      disposed = true;
      ++epoch;
      clearTimeout(timer);
      listeners.clear();
    },
  };
}
