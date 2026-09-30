import { sessionActivity, type SessionActivityState } from "./session-activity";
import { knownAgentPubkeys } from "../../features/agents/known";
import type { RetainedChannelEvidence } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";

export type PersonalSession = Readonly<{
  rootId: string;
  title: string;
  lastMessageAt: number;
}>;
const empty: readonly PersonalSession[] = Object.freeze([]);

/** One pass over the shared retained snapshot, not one fold per sidebar channel. */
export function personalSessions(
  rows: RetainedChannelEvidence,
  viewer: string | undefined,
  known: ReadonlySet<string>,
): ReadonlyMap<string, readonly PersonalSession[]> {
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
  const result = new Map<string, PersonalSession[]>();
  for (const { row, personal, agent, latest } of roots.values()) {
    if (!personal || !agent) continue;
    const entries = result.get(row.channelId) ?? [];
    entries.push(
      Object.freeze({
        rootId: row.id,
        title: row.excerpt || "Thread",
        lastMessageAt: latest,
      }),
    );
    result.set(row.channelId, entries);
  }
  const bounded = new Map<string, readonly PersonalSession[]>();
  for (const [id, entries] of result)
    bounded.set(
      id,
      Object.freeze(
        entries
          .sort(
            (a, b) =>
              b.lastMessageAt - a.lastMessageAt ||
              a.rootId.localeCompare(b.rootId),
          )
          .slice(0, 5),
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
    let previousLibrary:
      | ReturnType<typeof session.agentLibrary.snapshot>
      | undefined;
    let previousActivityRows: RetainedChannelEvidence | undefined;
    let previousTurns:
      | ReturnType<typeof session.agentActivity.snapshot>["turns"]
      | undefined;
    let activity: ReadonlyMap<string, SessionActivityState> = new Map();
    let previousKnown = "";
    let projection: ReadonlyMap<string, readonly PersonalSession[]> = new Map();
    const publish = () => {
      for (const listener of listeners) listener();
    };
    const owner = {
      snapshot(channelId: string) {
        if (disposed || closed) return empty;
        const rows = session.channels.retained?.();
        const profiles = session.profiles.snapshot();
        const library = session.agentLibrary.snapshot();
        let known: ReadonlySet<string> | undefined;
        let knownChanged = false;
        if (profiles !== previousProfiles || library !== previousLibrary) {
          known = knownAgentPubkeys(profiles, library);
          const key = [...known].sort().join(":");
          knownChanged = key !== previousKnown;
          previousKnown = key;
          previousProfiles = profiles;
          previousLibrary = library;
        }
        if (rows !== previousRows || knownChanged) {
          previousRows = rows;
          projection = personalSessions(
            rows ?? [],
            session.viewer,
            known ?? new Set(previousKnown ? previousKnown.split(":") : []),
          );
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
            session.agentLibrary.subscribe(publish),
            session.agentActivity.subscribe(publish),
          ];
        return () => {
          listeners.delete(listener);
          if (!listeners.size) {
            active.delete(owner);
            for (const stop of stops) stop();
            stops = [];
            previousKnown = "";
            previousRows = undefined;
            previousProfiles = undefined;
            previousLibrary = undefined;
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
        previousKnown = "";
        previousRows = undefined;
        previousProfiles = undefined;
        previousLibrary = undefined;
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
