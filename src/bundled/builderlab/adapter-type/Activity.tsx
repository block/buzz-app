// A remote agent's turns: those Builderlab stored and those it published to
// its owner over the relay this session, for the conversation it was opened
// from or all of them.
import {
  type ComponentType,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { Button as BaseButton } from "@base-ui/react/button";
import inlineStyles from "../../../shared/InlineReference.module.css";
import { useRelayConnection } from "../../../features/relay/react";
import type { RelayData } from "../../../features/relay/service";
import type { RelaySession } from "../../../features/relay/session";
import {
  activityTranscript,
  type TranscriptTurn,
} from "../../../features/agents/activity-transcript";
import { ActivityTranscript } from "../../../features/agents/ActivityTranscript";
import type {
  Agent,
  AgentConversation,
  AgentViewProps,
} from "../../../features/agents/service";
import { SettingsSectionLink } from "../../../features/navigation/SettingsSectionLink";
import type { IdentityNameView } from "../../../features/identity-names/service";
import { useIdentityNames } from "../../../features/identity-names/react";
import type { AgentClient } from "../agents/client";
import type { BuilderlabSession, LoginSnapshot } from "../session";
import {
  historyReader,
  mergeTurns,
  storedTurns,
  type HistoryReader,
  type StoredHistory,
} from "./history";

export type AgentActivity = RelaySession["agentActivity"];

const UNAVAILABLE = "Activity isn't available here.";

export function createActivityTab(
  relay: RelayData,
  openSettings?: (section: string) => void,
  builderlab?: Readonly<{ client: AgentClient; session: BuilderlabSession }>,
): ComponentType<AgentViewProps> {
  const read = builderlab
    ? historyReader(builderlab.client, builderlab.session)
    : undefined;
  const signedOut: LoginSnapshot = { status: "signed-out" };
  const subscribe = (listener: () => void) =>
    builderlab?.session.subscribe(listener) ?? (() => {});
  const login = () => builderlab?.session.snapshot() ?? signedOut;
  return function PublishedActivity({
    agent,
    conversation,
    initialTranscript,
    openConversation,
  }) {
    const connection = useRelayConnection(relay);
    const signedIn = useSyncExternalStore(subscribe, login, login);
    // Another account, or a change in its access, reads the stored turns again.
    const revision = `${signedIn.status}:${signedIn.account?.subject}:${!!signedIn.account?.canUseRemoteAgents}`;
    return (
      <ActivityPanel
        agent={agent}
        conversation={conversation}
        initialTranscript={initialTranscript}
        openConversation={openConversation}
        history={read && { read, revision }}
        activity={
          connection.status === "ready"
            ? connection.session.agentActivity
            : undefined
        }
        openSettings={openSettings}
        names={
          connection.status === "ready" ? connection.session.names : undefined
        }
      />
    );
  };
}

export function ActivityPanel({
  agent,
  activity,
  conversation,
  initialTranscript,
  openSettings,
  openConversation,
  names,
  history,
}: {
  agent: Agent;
  /** Absent while the owner's session connects. */
  activity: AgentActivity | undefined;
  /** Where it was opened from; its turns show until widened to all. */
  conversation?: AgentConversation | undefined;
  initialTranscript?: AgentViewProps["initialTranscript"];
  openSettings?: ((section: string) => void) | undefined;
  openConversation?: AgentViewProps["openConversation"];
  /** Names the people whose messages prompted the turns. */
  names?: IdentityNameView | undefined;
  /** Reads stored turns; a new revision reads them again. */
  history?: Readonly<{ read: HistoryReader; revision: unknown }> | undefined;
}) {
  if (!activity) return <Note>Activity shows once Buzz is connected.</Note>;
  return (
    <ActivityFeed
      agent={agent}
      conversation={conversation}
      initialTranscript={initialTranscript}
      openConversation={openConversation}
      activity={activity}
      openSettings={openSettings}
      names={names}
      history={history}
    />
  );
}

/** Whether a turn belongs to the conversation the agent was opened from.
 * Hosted frames name a thread only for a per-thread session; a turn without
 * one is from its channel's session, which every thread there shares. */
function inConversation(
  turn: TranscriptTurn,
  channelId: string,
  rootId: string | undefined,
) {
  if (turn.channelId !== channelId) return false;
  return !turn.threadRootId || !rootId || turn.threadRootId === rootId;
}

function ActivityFeed({
  agent,
  activity,
  conversation,
  initialTranscript,
  openSettings,
  openConversation,
  names,
  history,
}: {
  agent: Agent;
  activity: AgentActivity;
  conversation: AgentConversation | undefined;
  initialTranscript: AgentViewProps["initialTranscript"];
  openSettings: ((section: string) => void) | undefined;
  openConversation: AgentViewProps["openConversation"];
  names: IdentityNameView | undefined;
  history: Readonly<{ read: HistoryReader; revision: unknown }> | undefined;
}) {
  const resolve = useIdentityNames(names);
  const [everywhere, setEverywhere] = useState(false);
  // A new request for the opened conversation's transcript shows it again.
  const opening = initialTranscript?.opening;
  const [asked, setAsked] = useState(opening);
  if (opening !== asked) {
    setAsked(opening);
    if (opening !== undefined) setEverywhere(false);
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per opening.
  useEffect(() => initialTranscript?.done(), [opening]);
  const here = everywhere ? undefined : conversation;
  // The host passes a new conversation object each render; scope by its parts.
  const channelId = here?.channelId;
  const rootId = here?.rootId;
  // The Agent Activity plugin owns the feed's lease; this only reads it.
  const snapshot = useSyncExternalStore(
    activity.subscribe,
    activity.snapshot,
    activity.snapshot,
  );
  const stored = useStoredHistory(history, agent.pubkey, channelId, rootId);
  const transcript = useMemo(() => {
    const transcript = activityTranscript(
      snapshot.records.filter((record) => record.agent === agent.pubkey),
      { agent: agent.pubkey, channelId },
      (pubkey) => resolve(pubkey, "") || undefined,
    );
    const live = transcript.turns.flatMap((turn): TranscriptTurn[] => {
      if (channelId && !inConversation(turn, channelId, rootId)) return [];
      const retained = snapshot.turns.find(
        (row) => row.agent === agent.pubkey && row.turnId === turn.turnId,
      );
      return [
        retained?.outcome ? { ...turn, outcome: retained.outcome } : turn,
      ];
    });
    if (typeof stored !== "object" || stored.status !== "loaded")
      return { turns: live };
    const saved = storedTurns(
      stored.sessions,
      (pubkey) => resolve(pubkey, "") || undefined,
    ).filter((turn) => !channelId || inConversation(turn, channelId, rootId));
    return { turns: mergeTurns(live, saved) };
  }, [
    snapshot.records,
    snapshot.turns,
    agent.pubkey,
    resolve,
    channelId,
    rootId,
    stored,
  ]);
  if (snapshot.status === "unavailable") return <Note>{UNAVAILABLE}</Note>;
  if (snapshot.status === "disabled")
    return (
      <Note>
        Turn on Agent Activity in{" "}
        <SettingsSectionLink section="plugins" open={openSettings}>
          Manage plugins
        </SettingsSectionLink>{" "}
        to see activity.
      </Note>
    );
  if (!transcript.turns.length && snapshot.status === "connecting")
    return <Note>Connecting to the live feed…</Note>;
  const state = new Map(
    snapshot.turns
      .filter((turn) => turn.agent === agent.pubkey)
      .map((turn) => [turn.turnId, turn.state]),
  );
  // Turns link to their conversation unless the view is already that one:
  // a thread, or a channel whose turns name no thread (its one session).
  const linked =
    !rootId && transcript.turns.some((turn) => !!turn.threadRootId);
  return (
    <ActivityTranscript
      transcript={transcript}
      agentName={agent.name}
      agentKey={agent.key}
      agentPicture={agent.picture}
      community={agent.relay}
      state={(turnId) => state.get(turnId)}
      follow={false}
      openConversation={!here || linked ? openConversation : undefined}
      before={
        <>
          <Note>
            {coverage(
              here ? "this conversation" : "all of this agent's conversations",
              stored,
            )}
          </Note>
          {conversation && (
            // An inline link wraps in a narrow pane at large text sizes.
            <p className="text-body-sm text-secondary">
              <BaseButton
                data-buzz-ui=""
                className={inlineStyles.link}
                onClick={() => setEverywhere(!everywhere)}
              >
                {everywhere
                  ? "Show this conversation"
                  : "Show all conversations"}
              </BaseButton>
            </p>
          )}
          {snapshot.status === "interrupted" && (
            <Note>
              The live feed was interrupted; it reconnects on its own.
            </Note>
          )}
          {snapshot.trimmed > 0 && (
            <Note>Older activity was dropped to save memory.</Note>
          )}
        </>
      }
    />
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="text-body-sm text-secondary">
      {children}
    </p>
  );
}

type Stored = StoredHistory | "loading" | "failed" | undefined;

/** What the view covers: stored turns once read, else only live ones. */
function coverage(scope: string, stored: Stored) {
  if (stored === "loading")
    return `Turns from ${scope}. Loading earlier turns…`;
  if (stored === "failed")
    return `Turns from ${scope}, captured while Buzz has been open. Earlier turns couldn't be loaded.`;
  if (stored?.status !== "loaded")
    return `Turns from ${scope}, captured while Buzz has been open. Earlier turns aren't shown.`;
  const removed = stored.sessions.some(
    (session) => !!session.response.removal_state,
  );
  return [
    `Turns from ${scope}.`,
    stored.more && "Older conversations aren't shown.",
    removed && "A removed conversation's turns aren't shown.",
  ]
    .filter(Boolean)
    .join(" ");
}

/** The view's stored turns, read once per agent, scope and sign-in. */
function useStoredHistory(
  history: Readonly<{ read: HistoryReader; revision: unknown }> | undefined,
  pubkey: string,
  channelId: string | undefined,
  rootId: string | undefined,
): Stored {
  const [stored, setStored] = useState<Stored>();
  const read = history?.read;
  const revision = history?.revision;
  // biome-ignore lint/correctness/useExhaustiveDependencies: another sign-in reads again.
  useEffect(() => {
    if (!read) return;
    const controller = new AbortController();
    setStored("loading");
    read(
      pubkey,
      { ...(channelId ? { channelId } : {}), ...(rootId ? { rootId } : {}) },
      controller.signal,
    ).then(
      (value) => {
        if (!controller.signal.aborted) setStored(value);
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        console.warn("Builderlab stored activity read failed", error);
        setStored("failed");
      },
    );
    return () => controller.abort();
  }, [read, revision, pubkey, channelId, rootId]);
  return read ? stored : undefined;
}
