import { useSyncExternalStore } from "react";
import type { ResolvedBinding } from "./bindings";
import type { ShortcutsService } from "./service";

type Store = {
  subscribe(listener: () => void): () => void;
  snapshot(): unknown;
};

/** The dispatcher's resolved bindings, for hints that show what fires now. */
export function useResolvedBindings(
  shortcuts: ShortcutsService | undefined,
  bindings: Store | undefined,
): ReadonlyMap<string, ResolvedBinding> | undefined {
  // Each registry or saved binding change can change what resolves; the
  // service reuses its table until one does.
  useSyncExternalStore(
    shortcuts?.hostSubscribe ?? noSubscribe,
    shortcuts?.hostSnapshot ?? nothing,
  );
  useSyncExternalStore(
    shortcuts?.subscribe ?? noSubscribe,
    shortcuts?.snapshot ?? nothing,
  );
  useSyncExternalStore(
    bindings?.subscribe ?? noSubscribe,
    bindings?.snapshot ?? nothing,
  );
  return shortcuts?.resolved();
}
const noSubscribe = () => () => {};
const nothing = () => undefined;
