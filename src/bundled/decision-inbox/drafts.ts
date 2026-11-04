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

export function editDrafts(scope: string) {
  const drafts: {
    key: string;
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
        pair[1] === "edit" &&
        typeof pair[2] === "string" &&
        typeof pair[3] === "string"
      )
        drafts.push({
          key,
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
}

export function clearDrafts(scope: string) {
  for (const [key, entry] of entries)
    if (entry.scope === scope) entries.delete(key);
  subscriptions.get(scope)?.();
  subscriptions.delete(scope);
  updateWarning();
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
  return true;
}
