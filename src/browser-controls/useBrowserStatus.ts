import { useEffect, useState } from "react";
import { fetchBrowserStatus, type BrowserStatus } from "./api";

const IDLE: BrowserStatus = {
  url: "",
  title: "",
  loading: false,
  error: null,
};

/**
 * Polls browser_status while mounted. Never overlaps a poll with the
 * previous one's in-flight request, and never applies a result (or an
 * error from a stale one) after unmount.
 */
export function useBrowserStatus(intervalMs = 300): BrowserStatus {
  const [status, setStatus] = useState<BrowserStatus>(IDLE);
  useEffect(() => {
    let mounted = true;
    let polling = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function tick() {
      if (!mounted || polling) return;
      polling = true;
      try {
        const next = await fetchBrowserStatus();
        if (mounted) setStatus(next);
      } catch (error) {
        if (mounted)
          setStatus((previous) => ({
            ...previous,
            error: error instanceof Error ? error.message : String(error),
          }));
      } finally {
        polling = false;
        if (mounted) timer = setTimeout(tick, intervalMs);
      }
    }
    void tick();
    return () => {
      mounted = false;
      if (timer) clearTimeout(timer);
    };
  }, [intervalMs]);
  return status;
}
