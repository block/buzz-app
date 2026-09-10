import { useEffect, useState } from "react";
import type { RelaySession } from "../../features/relay/session";
import type { SidebarPreferences } from "../../features/relay/sidebar-preferences";

/** Mounted under the community/viewer/generation key; never owns transport or sync. */
export function useSidebarPreferences(
  queries: RelaySession["sidebarPreferences"],
) {
  const [status, setStatus] = useState<
    "loading" | "ready" | "error" | "unsupported"
  >(queries.available ? "loading" : "unsupported");
  const [data, setData] = useState<SidebarPreferences>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (status !== "loading") return;
    const controller = new AbortController();
    void queries.read(controller.signal).then(
      (preferences) => {
        if (controller.signal.aborted) return;
        setData(preferences);
        setError(undefined);
        setStatus("ready");
      },
      (reason: unknown) => {
        if (controller.signal.aborted) return;
        setError(reason instanceof Error ? reason.message : String(reason));
        setStatus("error");
      },
    );
    return () => controller.abort();
  }, [queries, status]);
  return {
    data,
    status,
    error,
    reload: () => {
      setError(undefined);
      setStatus("loading");
    },
  };
}
