/** Delivery knowledge outlives composers within one plugin session. */
export type InlineDelivery = {
  busy: boolean;
  unknown: boolean;
  attempt?: string | undefined;
  error?: string | undefined;
  sentUrl?: string | undefined;
};
export function createInlineDelivery() {
  let state: InlineDelivery = { busy: false, unknown: false };
  const listeners = new Set<() => void>();
  const update = (change: Partial<InlineDelivery>) => {
    state = { ...state, ...change };
    for (const listener of listeners) listener();
  };
  return {
    get: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    update,
    /** Covers duplicate gestures and sends from separate panels before render. */
    begin() {
      if (state.busy || state.unknown) return false;
      update({ busy: true, error: undefined, sentUrl: undefined });
      return true;
    },
  };
}
export type InlineDeliveryStore = ReturnType<typeof createInlineDelivery>;
