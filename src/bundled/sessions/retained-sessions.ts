import { sessionActivity, type SessionActivityState } from "./session-activity";
import { knownAgentPubkeys } from "../../features/agents/known";
import type {
  Profile,
  RetainedChannelEvidence,
  RetainedChannelMessage,
} from "../../features/relay/contracts";
import { profileMentionParts } from "../../features/messages/profile-mentions";
import { profileKey } from "../../features/profiles/target";
import type { AgentChoicesSnapshot } from "../../features/agents/choices";
import type { RelaySession } from "../../features/relay/session";

export type PersonalSession = Readonly<{
  rootId: string;
  title: string;
  lastMessageAt: number;
}>;
const empty: readonly PersonalSession[] = Object.freeze([]);

/** Sidebar-only, bounded display text. No inferred recipients or semantic rewrite. */
export function personalSessionTitle(
  row: RetainedChannelMessage,
  known: ReadonlySet<string>,
  profiles?: ReadonlyMap<string, Profile>,
  agents: AgentChoicesSnapshot["identities"] = [],
): string {
  const source = row.titleSource;
  if (source === undefined || row.edited) return row.excerpt || "Thread";
  // The shared display matcher is not a Markdown parser: container indentation
  // and mixed backtick delimiter lengths can hide code. Keep this sidebar's
  // original excerpt rather than removing any mentions in those uncertain bodies.
  if (/^ {0,3}>/m.test(source) || new Set(source.match(/`+/g) ?? []).size > 1)
    return row.excerpt || "Thread";
  const names = [...row.mentions, ...(row.mentionReferences ?? [])]
    .flatMap((key) => [
      profiles?.get(key)?.name,
      ...agents
        .filter((agent) => agent.pubkey === key)
        .map((agent) => agent.name),
    ])
    .filter((name): name is string => !!name);
  let offset = 0;
  let title = "";
  const removed = new Map<string, string>();
  for (const part of profileMentionParts(
    {
      content: source,
      mentions: row.mentions,
      mentionReferences: row.mentionReferences ?? [],
    },
    profiles,
    agents,
  )) {
    const start = offset;
    offset += part.text.length;
    const key = part.target && profileKey(part.target);
    // On a cut, an unfinished bracketed span could be a link whose closing
    // syntax was omitted. Keep it literal rather than guessing from the prefix.
    const bracket = source.lastIndexOf("[", start);
    const cutLink =
      bracket >= 0 &&
      !/\n|\]\([^)]*\)|\]\[[^\]]*\]/.test(source.slice(bracket));
    // A cut must not turn a longer name or legacy key qualifier into a short match.
    const incomplete =
      source.length > 160 &&
      (cutLink ||
        offset >= 160 ||
        names.some((name) => `@${name}`.startsWith(source.slice(start))) ||
        /^ (?:\([a-f0-9]{0,64}\)?)?$/i.test(source.slice(offset)));
    if (key && known.has(key) && !incomplete)
      removed.set(key, part.text.slice(1));
    else title += part.text.slice(0, Math.max(0, 160 - start));
  }
  title = title.trim().replace(/\s+/g, " ");
  if (title) return title;
  // Never call a truncated prefix a mentions-only prompt.
  return removed.size && source.length <= 160
    ? `Session with ${[...removed.values()].join(", ")}`
    : row.excerpt || "Thread";
}

/** One pass over the shared retained snapshot, not one fold per sidebar channel. */
export function personalSessions(
  rows: RetainedChannelEvidence,
  viewer: string | undefined,
  known: ReadonlySet<string>,
  profiles?: ReadonlyMap<string, Profile>,
  agents: AgentChoicesSnapshot["identities"] = [],
): Map<string, readonly PersonalSession[]> {
  const roots = new Map(
    rows
      .filter((row) => !row.threadRootId)
      .map((row) => [
        `${row.channelId}/${row.id}`,
        {
          row,
          personal:
            row.authorId === viewer || row.participants.includes(viewer ?? ""),
          agent: [
            row.authorId,
            ...row.participants,
            ...(row.edited && !row.quietSession && !row.chipSession
              ? []
              : row.mentions),
          ].some((key) => known.has(key)),
          latest: row.createdAt,
        },
      ]),
  );
  for (const reply of rows) {
    if (!reply.threadRootId || reply.threadRootId === reply.id) continue;
    const root = roots.get(`${reply.channelId}/${reply.threadRootId}`);
    if (!root) continue;
    root.personal ||= reply.authorId === viewer;
    root.agent ||= [reply.authorId, ...reply.mentions].some((key) =>
      known.has(key),
    );
    root.latest = Math.max(root.latest, reply.createdAt);
  }
  const result = new Map<
    string,
    { row: RetainedChannelMessage; latest: number }[]
  >();
  for (const { row, personal, agent, latest } of roots.values()) {
    if (!personal || !agent) continue;
    const entries = result.get(row.channelId) ?? [];
    entries.push({ row, latest });
    result.set(row.channelId, entries);
  }
  const bounded = new Map<string, readonly PersonalSession[]>();
  for (const [id, entries] of result)
    bounded.set(
      id,
      Object.freeze(
        entries
          .sort(
            (a, b) => b.latest - a.latest || a.row.id.localeCompare(b.row.id),
          )
          .slice(0, 5)
          .map(({ row, latest }) =>
            Object.freeze({
              rootId: row.id,
              title: personalSessionTitle(row, known, profiles, agents),
              lastMessageAt: latest,
            }),
          ),
      ),
    );
  return bounded;
}

/** Plugin-activation owned, ref-counted passive subscriptions. No observe(),
 * channel windows, library reads, ensure(), timers, or durable mirrored index. */
export function createRetainedSessions() {
  let closed = false;
  let owners = new WeakMap<RelaySession, ReturnType<typeof createOwner>>();
  const active = new Set<ReturnType<typeof createOwner>>();
  function createOwner(session: RelaySession) {
    const listeners = new Set<() => void>();
    let stops: (() => void)[] = [];
    let disposed = false;
    let previousRows: RetainedChannelEvidence | undefined;
    let previousProfiles:
      | ReturnType<typeof session.profiles.snapshot>
      | undefined;
    let previousChoices:
      | ReturnType<typeof session.agentChoices.snapshot>
      | undefined;
    let previousActivityRows: RetainedChannelEvidence | undefined;
    let previousTurns:
      | ReturnType<typeof session.agentActivity.snapshot>["turns"]
      | undefined;
    let activity: ReadonlyMap<string, SessionActivityState> = new Map();
    let projection: ReadonlyMap<string, readonly PersonalSession[]> = new Map();
    const publish = () => {
      for (const listener of listeners) listener();
    };
    const owner = {
      snapshot(channelId: string) {
        if (disposed || closed) return empty;
        const rows = session.channels.retained?.();
        const profiles = session.profiles.snapshot();
        const choices = session.agentChoices.snapshot();
        if (
          rows !== previousRows ||
          profiles !== previousProfiles ||
          choices !== previousChoices
        ) {
          previousRows = rows;
          previousProfiles = profiles;
          previousChoices = choices;
          const next = personalSessions(
            rows ?? [],
            session.viewer,
            knownAgentPubkeys(profiles, choices),
            profiles,
            choices.identities,
          );
          // Cached name evidence may change without changing any visible row.
          for (const [id, entries] of next) {
            const old = projection.get(id);
            if (
              old?.length === entries.length &&
              entries.every(
                (row, i) =>
                  row.rootId === old[i]?.rootId &&
                  row.title === old[i]?.title &&
                  row.lastMessageAt === old[i]?.lastMessageAt,
              )
            )
              next.set(id, old);
          }
          projection = next;
        }
        return projection.get(channelId) ?? empty;
      },
      snapshotActivity(channelId: string, rootId: string) {
        if (disposed || closed) return undefined;
        const rows = session.channels.retained?.();
        const turns = session.agentActivity.snapshot().turns;
        if (rows !== previousActivityRows || turns !== previousTurns) {
          previousActivityRows = rows;
          previousTurns = turns;
          activity = sessionActivity(rows ?? [], turns);
        }
        return activity.get(`${channelId}/${rootId}`);
      },
      subscribe(listener: () => void) {
        if (disposed || closed) return () => {};
        listeners.add(listener);
        active.add(owner);
        if (listeners.size === 1)
          stops = [
            session.channels.subscribeRetained?.(publish) ?? (() => {}),
            session.profiles.subscribe(publish),
            session.agentChoices.subscribe(publish),
            session.agentActivity.subscribe(publish),
          ];
        return () => {
          listeners.delete(listener);
          if (!listeners.size) {
            active.delete(owner);
            for (const stop of stops) stop();
            stops = [];
            previousRows = undefined;
            previousProfiles = undefined;
            previousChoices = undefined;
            projection = new Map();
            previousActivityRows = undefined;
            previousTurns = undefined;
            activity = new Map();
          }
        };
      },
      dispose() {
        disposed = true;
        for (const stop of stops) stop();
        stops = [];
        listeners.clear();
        previousRows = undefined;
        previousProfiles = undefined;
        previousChoices = undefined;
        projection = new Map();
        previousActivityRows = undefined;
        previousTurns = undefined;
        activity = new Map();
      },
    };
    return owner;
  }
  return {
    forSession(session: RelaySession) {
      let owner = owners.get(session);
      if (!owner) {
        owner = createOwner(session);
        owners.set(session, owner);
      }
      return owner;
    },
    dispose() {
      closed = true;
      for (const owner of active) owner.dispose();
      active.clear();
      owners = new WeakMap();
    },
  };
}
