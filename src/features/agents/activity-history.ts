import type { ActivityRecord } from "./activity-records";
export type HistoryRow = Omit<ActivityRecord, "envelopeId">;
export type HistoryPage = {
  records: readonly HistoryRow[];
  more: boolean;
  before: number | null;
  trimmed: boolean;
  epoch: number;
  revision: number;
  channels: readonly string[];
};
export type ActivityHistoryHost = {
  read(
    agent: string,
    channel: string,
    before: number | undefined,
    signal: AbortSignal,
  ): Promise<HistoryPage>;
  delete(signal: AbortSignal): Promise<void>;
};
/** Historical evidence is never fed to the live Activity/typing/unread owner. */
export function createActivityHistory(
  host: ActivityHistoryHost | undefined,
  canAccess: (channel: string) => boolean,
  onDelete: () => void,
) {
  let generation = 0,
    closed = false,
    controller = new AbortController(),
    deleting = false;
  const listeners = new Set<() => void>();
  const reset = () => {
    generation++;
    controller.abort();
    controller = new AbortController();
    for (const notify of listeners) notify();
  };
  return {
    queries: Object.freeze({
      available: !!host,
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      snapshot: () => generation,
      async read(
        agent: string,
        channel: string,
        before?: number,
        signal?: AbortSignal,
      ) {
        if (!host || closed || deleting || (channel && !canAccess(channel)))
          throw new Error("Saved Activity unavailable");
        const current = generation;
        const combined = AbortSignal.any([
          controller.signal,
          ...(signal ? [signal] : []),
        ]);
        const page = await host.read(agent, channel, before, combined);
        if (
          closed ||
          combined.aborted ||
          generation !== current ||
          (channel && !canAccess(channel))
        )
          throw new Error("Saved Activity scope changed");
        return page;
      },
      async delete() {
        if (!host || closed || deleting)
          throw new Error("Saved Activity unavailable");
        deleting = true;
        controller.abort();
        controller = new AbortController();
        const current = generation;
        try {
          await host.delete(controller.signal);
          if (closed || current !== generation)
            throw new Error("Saved Activity deletion interrupted");
          onDelete();
          reset();
        } finally {
          deleting = false;
        }
      },
    }),
    clear: reset,
    dispose() {
      closed = true;
      reset();
      listeners.clear();
    },
  };
}
