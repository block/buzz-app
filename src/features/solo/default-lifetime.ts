import { useCallback, useSyncExternalStore } from "react";
import { detailsDraftErrors } from "../relay/channel-details-protocol";
import { readView, subscribeView, writeView } from "../../shared/view-state";

// Saved on this device for the account and community (the view scope).
const KEY = "solo:default-lifetime";

/** The lifetime new Solo chats start with: seconds without activity before
 * the chat archives, or undefined for ongoing. A malformed value is ongoing. */
export function readDefaultLifetime(scope: string): number | undefined {
  const saved = readView<unknown>(scope, KEY, null);
  return typeof saved === "number" &&
    !detailsDraftErrors({
      name: "Chat",
      description: "",
      visibility: "private",
      ttlSeconds: saved,
    }).lifetime
    ? saved
    : undefined;
}

/** Saves the lifetime new Solo chats start with; false when this device
 * could not save it. */
export function writeDefaultLifetime(
  scope: string,
  ttlSeconds: number | undefined,
) {
  return writeView(scope, KEY, ttlSeconds ?? null);
}

/** A draft's lifetime. A draft saves `null` for a chosen Ongoing; with no
 * choice saved it follows the default. */
export function draftLifetime(
  scope: string,
  saved: number | null | undefined,
): number | undefined {
  return saved === undefined
    ? readDefaultLifetime(scope)
    : (saved ?? undefined);
}

export function useDefaultLifetime(scope: string) {
  return useSyncExternalStore(
    useCallback((listener) => subscribeView(scope, listener), [scope]),
    () => readDefaultLifetime(scope),
  );
}
