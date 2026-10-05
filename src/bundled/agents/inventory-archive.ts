import { useEffect, useRef, useState } from "react";
import type { IdentityArchives } from "../../features/relay/identity-archives";

export type ArchiveAction = "archive" | "unarchive";
export type ArchiveRun = Readonly<{ action: ArchiveAction; error?: string }>;
export type ArchiveFocus = Readonly<{ pubkey: string; archived: boolean }>;

/** Archive and Unarchive for inventory cards. The inventory owns each request,
 * because a confirmed change moves the card between sections and remounts it.
 * Runs belong to one community; switching community cancels them. */
export function useInventoryArchive(
  archives: Pick<IdentityArchives, "request">,
  destination: string,
  done: (pubkey: string, action: ArchiveAction) => void,
) {
  const [runs, setRuns] = useState<ReadonlyMap<string, ArchiveRun>>(new Map());
  const [focus, setFocus] = useState<ArchiveFocus & { seq: number }>();
  const controllers = useRef(new Map<string, AbortController>());
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new community or session starts with no runs.
  useEffect(() => {
    const owned = controllers.current;
    setRuns(new Map());
    return () => {
      for (const controller of owned.values()) controller.abort();
      owned.clear();
    };
  }, [archives, destination]);
  const update = (pubkey: string, next: ArchiveRun | undefined) =>
    setRuns((saved) => {
      const map = new Map(saved);
      next ? map.set(pubkey, next) : map.delete(pubkey);
      return map;
    });
  async function run(pubkey: string, action: ArchiveAction) {
    // One request per identity: repeat gestures and Undo wait for it.
    if (controllers.current.has(pubkey)) return;
    const controller = new AbortController();
    controllers.current.set(pubkey, controller);
    update(pubkey, { action });
    try {
      await archives.request(action, pubkey, controller.signal);
      if (controller.signal.aborted) return;
      update(pubkey, undefined);
      setFocus((saved) => ({
        pubkey,
        archived: action === "archive",
        seq: (saved?.seq ?? 0) + 1,
      }));
      done(pubkey, action);
    } catch (reason) {
      if (!controller.signal.aborted)
        update(pubkey, {
          action,
          error: reason instanceof Error ? reason.message : String(reason),
        });
    } finally {
      if (controllers.current.get(pubkey) === controller)
        controllers.current.delete(pubkey);
    }
  }
  return { runs, focus, run };
}

/** Render guard only: the archive request re-checks consent before signing. */
export function useArchiveConsent(
  archives: Pick<IdentityArchives, "consent" | "writable">,
  pubkey: string,
  enabled: boolean,
) {
  const [allowed, setAllowed] = useState(false);
  useEffect(() => {
    setAllowed(false);
    if (!enabled || !archives.writable) return;
    const controller = new AbortController();
    archives.consent(pubkey, controller.signal).then(
      (path) => {
        if (!controller.signal.aborted) setAllowed(!!path);
      },
      () => {},
    );
    return () => controller.abort();
  }, [archives, pubkey, enabled]);
  return allowed;
}
