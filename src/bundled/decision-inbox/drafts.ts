import {
  subscribeView,
  viewRevision,
  writeView,
} from "../../shared/view-state";
import type { Stage } from "./model";

export type Draft = {
  expected: string | null | undefined;
  question: string;
  nextActor: string;
  decision: string;
  stage: Stage;
};

const marker = "decision-inbox:unsaved-draft";
const marked = JSON.stringify(true);
const entries = new Map<string, { scope: string; draft: Draft }>();
const subscriptions = new Map<string, () => void>();
const purgeListeners = new Map<string, Set<() => void>>();
let warningActive = false;

const warnBeforeUnload = (event: BeforeUnloadEvent) => {
  event.preventDefault();
  event.returnValue = "";
};

function updateWarning() {
  if (entries.size > 0 && !warningActive) {
    window.addEventListener("beforeunload", warnBeforeUnload);
    warningActive = true;
  } else if (entries.size === 0 && warningActive) {
    window.removeEventListener("beforeunload", warnBeforeUnload);
    warningActive = false;
  }
}

export function draftFor(key: string) {
  return entries.get(key)?.draft;
}

export function forgetDraft(key: string) {
  const entry = entries.get(key);
  if (!entry) return;
  entries.delete(key);
  if (![...entries.values()].some((other) => other.scope === entry.scope)) {
    subscriptions.get(entry.scope)?.();
    subscriptions.delete(entry.scope);
  }
  updateWarning();
}

export function clearDrafts(scope: string) {
  for (const [key, entry] of entries)
    if (entry.scope === scope) entries.delete(key);
  subscriptions.get(scope)?.();
  subscriptions.delete(scope);
  updateWarning();
  for (const listener of purgeListeners.get(scope) ?? []) listener();
}

export function onDraftPurge(scope: string, listener: () => void) {
  let listeners = purgeListeners.get(scope);
  if (!listeners) {
    listeners = new Set();
    purgeListeners.set(scope, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) purgeListeners.delete(scope);
  };
}

/** The scope marker is removed by the existing view-state community purge. */
export function keepDraft(scope: string, key: string, draft: Draft) {
  entries.set(key, { scope, draft });
  updateWarning();
  if (viewRevision(scope, marker) !== marked && !writeView(scope, marker, true))
    return false;
  if (!subscriptions.has(scope)) {
    const stop = subscribeView(scope, () => {
      if (viewRevision(scope, marker) === null) clearDrafts(scope);
    });
    subscriptions.set(scope, stop);
  }
  return true;
}
