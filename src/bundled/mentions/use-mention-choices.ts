import { useMentionDirectory } from "./useMentionDirectory";
import { useMentionArchives } from "../../features/messages/use-mention-archives";
import {
  useCallback,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import type { RelaySession } from "../../features/relay/session";
import { useAgentChoices } from "../../features/agents/use-choices";
import { useIdentityNames } from "../../features/identity-names/react";
import { DraftMentionRoster } from "../../features/messages/draft-mention-roster";
import { SelectedMentionContext } from "../../features/messages/selected-mention-context";
import {
  mentionCandidates,
  mentionHistory,
} from "../../features/messages/mention-candidates";
import {
  exactMention,
  rankMentions,
  type MentionChoice,
} from "./mention-ranking";
/** One installed key list per opening/query. Evidence stays live, order does not. */
export function useMentionChoices(
  session: RelaySession,
  channelId: string,
  invite: boolean | undefined,
  query: string,
  open = true,
) {
  const roster = useContext(DraftMentionRoster);
  const selected = useContext(SelectedMentionContext);
  const agents = useAgentChoices(session, !!invite && open);
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
    session.profiles.snapshot,
  );
  const list = useSyncExternalStore(
    session.channels.subscribeList,
    session.channels.list,
    session.channels.list,
  );
  const channel = list.channels.find((c) => c.id === channelId);
  const directory = useMentionDirectory(
    session,
    channel,
    query,
    open && !roster && !invite,
  );
  const archives = useMentionArchives(session, open);
  const resolve = useIdentityNames(session.names);
  const current = useCallback(() => {
    const candidates = mentionCandidates(
      session,
      channelId,
      invite,
      roster,
      directory.people,
    );
    const keys = [
      ...new Set([
        ...candidates.map((c) => c.recipient.pubkey),
        ...selected.map((p) => p.pubkey),
      ]),
    ];
    return candidates.map((choice) => ({
      ...choice,
      label:
        session.names?.resolve(
          choice.recipient.pubkey,
          choice.recipient.name,
          keys,
          selected,
        ) ?? choice.recipient.name,
    }));
  }, [session, channelId, invite, roster, selected, directory.people]);
  const candidates = useMemo(() => {
    // Source revisions invalidate the projection; selection reads them again synchronously.
    void profiles;
    void list;
    void agents;
    void archives;
    void resolve;
    return current();
  }, [current, profiles, list, agents, archives, resolve]);
  const pending =
    !roster &&
    (directory.loading ||
      ((list.status === "idle" || list.status === "loading") &&
        !channel?.members) ||
      (!!invite && agents.pending && agents.status !== "ready"));
  const [installed, install] = useState<{
    session: RelaySession;
    key: string;
    rows: MentionChoice[];
  }>();
  const key = JSON.stringify([channelId, invite, query, open, !!roster]);
  const same = installed?.session === session && installed.key === key;
  let rows = same ? installed.rows : undefined;
  if (!same && installed) install(undefined);
  if (open && !rows && !pending) {
    const ranked = rankMentions(
      candidates,
      query,
      mentionHistory(session, channelId),
      (key) => session.presence?.status(key) ?? "unknown",
    ).slice(0, 50);
    const missingNames = channel?.members?.some((key) => !profiles.has(key));
    if (
      ranked.length ||
      (!pending &&
        !missingNames &&
        !directory.error &&
        (!invite || !agents.pending) &&
        list.status === "ready" &&
        !agents.error &&
        agents.status !== "error")
    ) {
      rows = ranked;
      install({ session, key, rows });
    }
  }
  return useMemo(() => {
    const live = new Map(candidates.map((c) => [c.recipient.pubkey, c]));
    const choices = (rows ?? []).map((row) => {
      const now = live.get(row.recipient.pubkey);
      const reason = now
        ? row.member && !now.member
          ? "Channel membership changed. Reopen to review adding this recipient."
          : undefined
        : archives.archived.includes(row.recipient.pubkey)
          ? "Archived"
          : "No longer available. Change your search to refresh choices.";
      return {
        ...(now ?? row),
        disabled: reason,
        member: now?.member ?? row.member,
      };
    });
    return {
      choices,
      directory,
      profiles,
      list,
      agents,
      channel,
      roster,
      candidates,
      pending,
      archives,
      spaceId: exactMention(candidates, query),
      canSelect: (pubkey: string, space = false) => {
        const fresh = current();
        return (
          fresh.some(
            (c) =>
              c.recipient.pubkey === pubkey &&
              (!rows?.find((row) => row.recipient.pubkey === pubkey)?.member ||
                c.member),
          ) &&
          (!space || exactMention(fresh, query) === pubkey)
        );
      },
      truncated: rankMentions(candidates, query).length > 50,
    };
  }, [
    rows,
    directory,
    candidates,
    archives,
    profiles,
    list,
    agents,
    channel,
    roster,
    pending,
    query,
    current,
  ]);
}
