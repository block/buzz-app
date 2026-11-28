/*
 * A short status a keyboard plugin shows in a composer, beside Send, such as
 * the mode its keys are in. It belongs to one editor element, the composer's
 * `ComposerInputElement`; with none set, the composer shows nothing.
 */
import { type RefObject, useSyncExternalStore } from "react";

/** Each owner's label per editor, newest last; the newest one shows. */
const statuses = new WeakMap<Element, { status: string }[]>();
const listeners = new Set<() => void>();
const publish = () => {
  for (const listener of listeners) listener();
};

/** Show `status` in the composer whose editor is `input`, until the returned
 * function removes it. Another owner's newer label shows over it meanwhile. */
export function addComposerStatus(input: Element, status: string) {
  const entry = { status };
  const entries = statuses.get(input) ?? [];
  statuses.set(input, [...entries, entry]);
  publish();
  return () => {
    const current = statuses.get(input) ?? [];
    if (!current.includes(entry)) return;
    statuses.set(
      input,
      current.filter((item) => item !== entry),
    );
    publish();
  };
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
    input.current ? statuses.get(input.current)?.at(-1)?.status : undefined,
  );
}
