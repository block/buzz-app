import { useCallback, useMemo, useSyncExternalStore } from "react";
import { readView, subscribeView } from "../../shared/view-state";
import {
  attachmentDraftCount,
  subscribeAttachmentDraftCounts,
} from "../messages/attachment-draft";
import { hasDraftContent, mentionDraft } from "../messages/mention-draft";
import type { RelaySession } from "../relay/session";

const starredDraftKey = "solo:starred:new-draft";

/** Existing New chat slots, backed by the composer's text and file owners. */
export function hasSoloDraft(
  session: RelaySession,
  scope: string,
  project = "",
  starred = false,
) {
  const key = starred
    ? starredDraftKey
    : `${project ? `solo:project:${project}` : "solo"}:new-draft`;
  return hasDraftContent(
    mentionDraft(readView<unknown>(scope, key, "")),
    attachmentDraftCount(session, `${scope}:${key}`),
  );
}

function subscribeSoloDrafts(session: RelaySession, scope: string) {
  return (notify: () => void) => {
    const views = subscribeView(
      scope,
      notify,
      (key) =>
        key === "solo:new-draft" ||
        key === starredDraftKey ||
        (key.startsWith("solo:project:") && key.endsWith(":new-draft")),
    );
    const files = subscribeAttachmentDraftCounts(session, notify);
    return () => {
      views();
      files();
    };
  };
}

export function useSoloDraftProjects(
  session: RelaySession,
  scope: string,
  projects: readonly string[],
) {
  const keys = JSON.stringify(["", ...projects]);
  const subscribe = useMemo(
    () => subscribeSoloDrafts(session, scope),
    [session, scope],
  );
  const snapshot = useCallback(
    () =>
      JSON.stringify(
        (JSON.parse(keys) as string[]).filter((project) =>
          hasSoloDraft(session, scope, project),
        ),
      ),
    [session, scope, keys],
  );
  return JSON.parse(
    useSyncExternalStore(subscribe, snapshot, snapshot),
  ) as string[];
}

/** Whether New chat from Favorites holds a draft. */
export function useStarredSoloDraft(session: RelaySession, scope: string) {
  const subscribe = useMemo(
    () => subscribeSoloDrafts(session, scope),
    [session, scope],
  );
  const snapshot = useCallback(
    () => hasSoloDraft(session, scope, "", true),
    [session, scope],
  );
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
