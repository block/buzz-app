import { subscribeViewScopePurge } from "../../shared/view-state";
import type { Stage } from "./model";

export type Draft = {
  expected: string | null | undefined;
  question: string;
  nextActor: string;
  decision: string;
  stage: Stage;
};

const entries = new Map<string, { scope: string; draft: Draft }>();
const subscriptions = new Map<string, () => void>();
const listeners = new Map<string, Set<() => void>>();
const versions = new Map<string, number>();
let warningActive = false;

function changed(scope: string) {
  versions.set(scope, (versions.get(scope) ?? 0) + 1);
  for (const listener of listeners.get(scope) ?? []) listener();
}

export function subscribeDrafts(scope: string, listener: () => void) {
  let scoped = listeners.get(scope);
  if (!scoped) {
    scoped = new Set();
    listeners.set(scope, scoped);
  }
  scoped.add(listener);
  return () => {
    scoped.delete(listener);
    if (!scoped.size) listeners.delete(scope);
  };
}

export const draftVersion = (scope: string) => versions.get(scope) ?? 0;

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

export function retainedDrafts(scope: string) {
  const drafts: {
    key: string;
    kind: "capture" | "edit";
    channelId: string;
    messageId: string;
    draft: Draft;
  }[] = [];
  for (const [key, entry] of entries) {
    if (entry.scope !== scope) continue;
    try {
      const pair: unknown = JSON.parse(key);
      if (
        Array.isArray(pair) &&
        pair.length === 4 &&
        pair[0] === scope &&
        (pair[1] === "capture" || pair[1] === "edit") &&
        typeof pair[2] === "string" &&
        typeof pair[3] === "string"
      )
        drafts.push({
          key,
          kind: pair[1],
          channelId: pair[2],
          messageId: pair[3],
          draft: entry.draft,
        });
    } catch {
      // Draft keys are internal; skip an invalid key without losing other edits.
    }
  }
  return drafts;
}

export function forgetDraft(key: string, expected?: Draft) {
  const entry = entries.get(key);
  if (!entry || (expected && entry.draft !== expected)) return;
  entries.delete(key);
  if (![...entries.values()].some((other) => other.scope === entry.scope)) {
    subscriptions.get(entry.scope)?.();
    subscriptions.delete(entry.scope);
  }
  updateWarning();
  changed(entry.scope);
}

export function clearDrafts(scope: string) {
  let removed = false;
  for (const [key, entry] of entries)
    if (entry.scope === scope) {
      entries.delete(key);
      removed = true;
    }
  subscriptions.get(scope)?.();
  subscriptions.delete(scope);
  updateWarning();
  if (removed) changed(scope);
}

/** Keep drafts only when an explicit purge can reach this window from peers. */
export function keepDraft(scope: string, key: string, draft: Draft) {
  if (!subscriptions.has(scope)) {
    const purge = subscribeViewScopePurge(scope, () => clearDrafts(scope));
    if (!purge.crossWindow) {
      purge.stop();
      return false;
    }
    subscriptions.set(scope, purge.stop);
  }
  entries.set(key, { scope, draft });
  updateWarning();
  changed(scope);
  return true;
}
