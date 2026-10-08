import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ArchiveHost, ArchivePage } from "../archive/types";
import { projectUsageWithUnreadable } from "./usage";

const MAX_RECORDS = 2000;
export function useUsageArchive(
  host: ArchiveHost | undefined,
  channelId: string,
  allowed: boolean,
) {
  const [state, setState] = useState<{
    records: ArchivePage["records"];
    before: number | null;
    revision: number | null;
    skipped: number;
    status: "loading" | "ready" | "error" | "unavailable";
  }>({
    records: [],
    before: null,
    revision: null,
    skipped: 0,
    status: host ? "loading" : "unavailable",
  });
  const pending = useRef(false);
  const abort = useRef(new AbortController());
  const generation = useRef(0);
  const current = useRef(state);
  current.current = state;
  const permitted = useRef(allowed);
  permitted.current = allowed;
  const reset = useCallback(() => {
    generation.current++;
    abort.current.abort();
    abort.current = new AbortController();
    pending.current = false;
    setState({
      records: [],
      before: null,
      revision: null,
      skipped: 0,
      status: host ? "loading" : "unavailable",
    });
  }, [host]);
  const load = useCallback(
    async (more = false) => {
      if (!host || !permitted.current || pending.current) return;
      const prior = current.current;
      if (
        more &&
        (prior.before === null || prior.records.length >= MAX_RECORDS)
      )
        return;
      pending.current = true;
      const token = generation.current;
      const signal = abort.current.signal;
      setState((value) => ({ ...value, status: "loading" }));
      try {
        const settings = await host.settings(signal);
        if (
          signal.aborted ||
          token !== generation.current ||
          !permitted.current
        )
          return;
        if (
          more &&
          prior.revision !== null &&
          settings.revision !== prior.revision
        ) {
          // Clear/configure invalidates the visible page even if the next read fails.
          reset();
          setState((value) => ({ ...value, status: "error" }));
          return;
        }
        const page = await host.read(
          {
            kind: 44200,
            ...(more && prior.before !== null ? { before: prior.before } : {}),
          },
          signal,
        );
        if (
          signal.aborted ||
          token !== generation.current ||
          !permitted.current
        )
          return;
        // The page itself is revision evidence. Discard obsolete rows before a
        // fallible trailing settings read can stall or reject.
        if (
          page.revision !== settings.revision ||
          (more && prior.revision !== page.revision)
        ) {
          reset();
          setState((value) => ({ ...value, status: "error" }));
          return;
        }
        const latest = await host.settings(signal);
        if (
          signal.aborted ||
          token !== generation.current ||
          !permitted.current
        )
          return;
        // A clear/configure after the page must not re-admit stale rows.
        if (page.revision !== latest.revision) {
          // A changed archive is not a completed load. Clear old rows and
          // require an explicit retry rather than leaving a permanent spinner.
          reset();
          setState((value) => ({ ...value, status: "error" }));
          return;
        }
        setState({
          records: more
            ? [...prior.records, ...page.records].slice(0, MAX_RECORDS)
            : page.records.slice(0, MAX_RECORDS),
          before: page.before,
          revision: page.revision,
          skipped: (more ? prior.skipped : 0) + page.skipped,
          status: "ready",
        });
      } catch {
        if (
          !signal.aborted &&
          token === generation.current &&
          permitted.current
        )
          setState((value) => ({ ...value, status: "error" }));
      } finally {
        if (token === generation.current) pending.current = false;
      }
    },
    [host, reset],
  );
  useEffect(() => {
    void channelId;
    if (!allowed) {
      reset();
      return;
    }
    reset();
    // Effect setup starts the first page; details toggles do not remount this hook.
    void load();
    return () => {
      generation.current++;
      abort.current.abort();
      pending.current = false;
    };
  }, [allowed, channelId, load, reset]);
  const projection = useMemo(
    () =>
      allowed
        ? projectUsageWithUnreadable(state.records, channelId)
        : { groups: [], unreadable: 0 },
    [allowed, state.records, channelId],
  );
  return {
    groups: projection.groups,
    status: allowed ? state.status : "unavailable",
    hasMore:
      allowed && state.before !== null && state.records.length < MAX_RECORDS,
    skipped: allowed ? state.skipped : 0,
    unreadable: projection.unreadable,
    loaded: state.records.length,
    refresh: () => {
      reset();
      void load();
    },
    loadMore: () => void load(true),
    revision: state.revision,
  };
}
