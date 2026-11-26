/*
 * A short status a keyboard plugin shows in a composer, beside Send, such as
 * the mode its keys are in. It belongs to one editor element, the composer's
 * `ComposerInputElement`; with none set, the composer shows nothing.
 */
import { type RefObject, useSyncExternalStore } from "react";

const statuses = new WeakMap<Element, string>();
const listeners = new Set<() => void>();

/** Show `status` in the composer whose editor is `input`; undefined clears it. */
export function setComposerStatus(input: Element, status: string | undefined) {
  if (statuses.get(input) === status) return;
  if (status) statuses.set(input, status);
  else statuses.delete(input);
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** The status set for the composer's editor, if any. */
export function useComposerStatus(input: RefObject<Element | null>) {
  return useSyncExternalStore(subscribe, () =>
    input.current ? statuses.get(input.current) : undefined,
  );
}
