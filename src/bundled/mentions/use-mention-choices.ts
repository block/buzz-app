import { useMentionDirectory } from "./useMentionDirectory";
import { useMentionArchives } from "../../features/messages/use-mention-archives";
import {
  useCallback,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import type { ComposerSession } from "../../features/messages/composer-session";
import { useAgentChoices } from "../../features/agents/use-choices";
import { AgentsContext, useAgentsSnapshot } from "../../features/agents/react";
import { useIdentityNames } from "../../features/identity-names/react";
import { DraftMentionRoster } from "../../features/messages/draft-mention-roster";
import { SelectedMentionContext } from "../../features/messages/selected-mention-context";
import { archivedMention } from "../../features/messages/mention-admission";
import { mentionHistory } from "../../features/messages/mention-history";
import { mentionCandidates } from "./mention-candidates";
import {
  exactMention,
  matchingMentions,
  rankMentions,
  type MentionChoice,
} from "./mention-ranking";
type Person = ReturnType<typeof useMentionDirectory>["people"][number];
const none: readonly Person[] = [];
// Derived once per cached candidate list (see mentionCandidates), so a
// keystroke reuses labels and keys instead of renaming every member.
const labeled = new WeakMap<
  readonly unknown[],
  { sources: readonly unknown[]; choices: readonly MentionChoice[] }
>();
const keySets = new WeakMap<readonly unknown[], ReadonlySet<string>>();
const keyMaps = new WeakMap<
  readonly MentionChoice[],
  ReadonlyMap<string, MentionChoice>
>();
const byKey = (choices: readonly MentionChoice[]) => {
  const cached = keyMaps.get(choices);
  if (cached) return cached;
  const map = new Map(choices.map((c) => [c.recipient.pubkey, c]));
  keyMaps.set(choices, map);
  return map;
};
/**
 * One installed key list per opening/query. Evidence stays live, order does not.
 * Local rows install first; directory rows only append after them.
 */
export function useMentionChoices(
  session: ComposerSession,
  channelId: string,
  invite: boolean | undefined,
  query: string,
  /** One chooser opening; see useMentionDirectory. */
  lifetime: string,
  open = true,
) {
  const roster = useContext(DraftMentionRoster);
  const selected = useContext(SelectedMentionContext);
  const agents = useAgentChoices(session, !!invite && open);
  // The owner's agents in their other communities; the snapshot is the revision.
  const community = useContext(AgentsContext);
  const revision = useAgentsSnapshot(community);
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
    lifetime,
  );
  const archives = useMentionArchives(session, open);
  const resolve = useIdentityNames(session.names);
  const [installed, install] = useState<{
    session: ComposerSession;
    key: string;
    rows: MentionChoice[];
    /** Directory people behind installed outside rows, kept while later pages load. */
    people: readonly Person[];
  }>();
  const key = JSON.stringify([channelId, invite, query, open, !!roster]);
  const same = installed?.session === session && installed.key === key;
  const carried = same ? installed.people : none;
  const people = useMemo(() => {
    if (!carried.length) return directory.people;
    const known = new Set(directory.people.map((person) => person.pubkey));
    return [
      ...directory.people,
      ...carried.filter((person) => !known.has(person.pubkey)),
    ];
  }, [directory.people, carried]);
  const current = useCallback(() => {
    const candidates = mentionCandidates(
      session,
      channelId,
      invite,
      roster,
      people,
      community?.joinable(),
    );
    // Drafts recreate their recipient array on every edit; its names and keys
    // are the naming fact, not its identity or positions.
    const sources = [
      JSON.stringify(selected.map(({ pubkey, name }) => [pubkey, name])),
      people,
      session.names?.snapshot(),
    ];
    const hit = labeled.get(candidates);
    if (hit?.sources.every((source, i) => source === sources[i]))
      return hit.choices;
    const keys = [
      ...new Set([
        ...candidates.map((c) => c.recipient.pubkey),
        ...selected.map((p) => p.pubkey),
      ]),
    ];
    // Directory pages are menu-local, not cached profiles. Name them only when no
    // other source knows the key, so namesakes in this choice set are qualified.
    const known = session.names?.scope();
    const facts = [
      ...people
        .filter((person) => !known?.(person.pubkey))
        .map(({ pubkey, name, isAgent }) => ({
          pubkey,
          name,
          ...(isAgent ? { isAgent } : {}),
        })),
      ...selected,
    ];
    // One naming scope per choice set, not one normalization per row.
    const name = session.names?.scope(keys, facts);
    const choices: readonly MentionChoice[] = candidates.map((choice) => {
      const named = name?.(choice.recipient.pubkey);
      return {
        ...choice,
        label: named?.name ?? choice.recipient.name,
        qualifier: named?.qualifier,
      };
    });
    labeled.set(candidates, { sources, choices });
    return choices;
  }, [session, channelId, invite, roster, selected, people, community]);
  // Keys known without the directory search: members and agent choices.
  const localKeys = useCallback(() => {
    const local = mentionCandidates(
      session,
      channelId,
      invite,
      roster,
      undefined,
      community?.joinable(),
    );
    const cached = keySets.get(local);
    if (cached) return cached;
    const keys = new Set(local.map((c) => c.recipient.pubkey));
    keySets.set(local, keys);
    return keys;
  }, [session, channelId, invite, roster, community]);
  const { candidates, local } = useMemo(() => {
    // Source revisions invalidate the projection; selection reads them again synchronously.
    void profiles;
    void list;
    void agents;
    void archives;
    void resolve;
    void revision;
    // A closed or disabled chooser shows nothing, so it names nothing.
    if (!open)
      return {
        candidates: [] as readonly MentionChoice[],
        local: new Set<string>() as ReadonlySet<string>,
      };
    return { candidates: current(), local: localKeys() };
  }, [
    open,
    current,
    localKeys,
    profiles,
    list,
    agents,
    archives,
    resolve,
    revision,
  ]);
  // Install membership first; agent discovery must not hide known members.
  const membersPending =
    !roster &&
    (list.status === "idle" || list.status === "loading") &&
    !channel?.members;
  const pending =
    membersPending ||
    (!roster && !!invite && agents.pending && agents.status !== "ready");
  let rows = same ? installed.rows : undefined;
  if (!same && installed) install(undefined);
  // Only choices the query can match; ranking reads no others.
  const matches = matchingMentions(candidates, query);
  const rank = (choices: readonly MentionChoice[]) =>
    rankMentions(
      choices,
      query,
      mentionHistory(session, channelId),
      (key) => session.presence?.status(key) ?? "unknown",
    );
  const outside = open
    ? rank(matches.filter((c) => !local.has(c.recipient.pubkey)))
    : [];
  const missingNames =
    open && channel?.members?.some((key) => !profiles.has(key));
  if (open && !rows && !membersPending) {
    const ranked = rank(
      matches.filter((c) => local.has(c.recipient.pubkey)),
    ).slice(0, 50);
    if (
      ranked.length ||
      outside.length ||
      (!pending &&
        !missingNames &&
        (!invite || !agents.pending) &&
        list.status === "ready" &&
        !agents.error &&
        agents.status !== "error")
    ) {
      rows = ranked;
      install({ session, key, rows, people: none });
    }
  }
  if (rows && rows.length < 50) {
    // Append-only: late invited agents and directory pages never move shown rows.
    // Member-list changes keep their installed set until the query changes.
    const shown = new Set(rows.map((row) => row.recipient.pubkey));
    const added = (invite ? rank(matches.filter((c) => c.agent)) : outside)
      .filter((c) => !shown.has(c.recipient.pubkey))
      .slice(0, 50 - rows.length);
    if (added.length) {
      const addedKeys = new Set(added.map((c) => c.recipient.pubkey));
      rows = [...rows, ...added];
      install({
        session,
        key,
        rows,
        people: [
          ...carried,
          ...people.filter(
            (person) =>
              addedKeys.has(person.pubkey) &&
              !carried.some((kept) => kept.pubkey === person.pubkey),
          ),
        ],
      });
    }
  }
  // Space (README section 5): once every member is named, an exact local name
  // selects at once. Any other exact name needs the full choice set: while the
  // directory search runs, failed, or has more pages, a namesake may be missing.
  const complete = !directory.loading && !directory.error && !directory.more;
  return useMemo(() => {
    const spaceMention = (
      all: readonly MentionChoice[],
      keys: ReadonlySet<string>,
    ) => {
      if (pending) return undefined;
      const choices = matchingMentions(all, query);
      return (
        (missingNames
          ? undefined
          : exactMention(choices, query, (c) =>
              keys.has(c.recipient.pubkey),
            )) ?? (complete ? exactMention(choices, query) : undefined)
      );
    };
    const live = byKey(candidates);
    const choices = (rows ?? []).map((row) => {
      const now = live.get(row.recipient.pubkey);
      const reason = now
        ? row.member && !now.member
          ? "Channel membership changed. Reopen to review adding this recipient."
          : undefined
        : archivedMention(session, row.recipient.pubkey)
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
      directory: { ...directory, people },
      profiles,
      list,
      agents,
      channel,
      roster,
      candidates,
      pending,
      archives,
      spaceId: spaceMention(candidates, local),
      canSelect: (pubkey: string, space = false) => {
        const fresh = current();
        return (
          fresh.some(
            (c) =>
              c.recipient.pubkey === pubkey &&
              (!rows?.find((row) => row.recipient.pubkey === pubkey)?.member ||
                c.member),
          ) &&
          (!space || spaceMention(fresh, localKeys()) === pubkey)
        );
      },
      truncated:
        rankMentions(matchingMentions(candidates, query), query).length > 50,
    };
  }, [
    session,
    rows,
    directory,
    people,
    candidates,
    local,
    localKeys,
    missingNames,
    archives,
    profiles,
    list,
    agents,
    channel,
    roster,
    pending,
    query,
    current,
    complete,
  ]);
}
