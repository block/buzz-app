import { Clock3, History, RefreshCw, Search, UsersRound } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { AgentLibrary } from "../../features/agents/library";
import { useChannelList, useRelayConnection } from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { Avatar } from "../../shared/Avatar";
import { avatarSource } from "../../shared/avatar-source";
import {
  agentNodes,
  buildAgentChannelGraph,
  GRAPH_EDGE_LIMIT,
  HISTORY_EVENT_LIMIT,
  readAgentActivity,
  type AgentNode,
} from "./relationships";

export function AgentChannelsPage({ relay }: { relay: RelayData }) {
  const connection = useRelayConnection(relay);
  return (
    <section
      aria-label="Agent channels"
      className="h-full min-h-0 overflow-auto rounded-3xl border border-line bg-surface px-5 py-6 shadow-surface sm:px-8 sm:py-8"
    >
      {connection.status === "ready" ? (
        <AgentChannels
          key={`${connection.scope}:${connection.generation}`}
          session={connection.session}
        />
      ) : (
        <ConnectionState relay={relay} status={connection.status} />
      )}
    </section>
  );
}

function ConnectionState({
  relay,
  status,
}: {
  relay: RelayData;
  status: "disconnected" | "connecting" | "error";
}) {
  return (
    <div className="mx-auto flex min-h-full max-w-xl flex-col items-center justify-center text-center">
      <UsersRound size={28} aria-hidden="true" />
      <h1 className="mb-2 mt-4 text-3xl font-medium tracking-tight">
        Agent channels
      </h1>
      <p className="max-w-md text-sm text-muted">
        {status === "connecting"
          ? "Connecting to your community…"
          : "Connect to a community to see where your agents work."}
      </p>
      {status === "error" && (
        <button type="button" className="mt-3" onClick={() => relay.retry()}>
          Retry connection
        </button>
      )}
    </div>
  );
}

type ActivityState = Readonly<{
  status: "idle" | "loading" | "ready" | "error";
  events: Awaited<ReturnType<typeof readAgentActivity>>;
  error?: string;
}>;
const noActivity: ActivityState["events"] = Object.freeze([]);
const noLibrary: AgentLibrary = Object.freeze({
  definitions: Object.freeze([]),
  identities: Object.freeze([]),
});

function AgentChannels({ session }: { session: RelaySession }) {
  const library = useSyncExternalStore(
    session.agentLibrary.subscribe,
    session.agentLibrary.snapshot,
    session.agentLibrary.snapshot,
  );
  const archives = useSyncExternalStore(
    session.archives.subscribe,
    session.archives.snapshot,
    session.archives.snapshot,
  );
  const channels = useChannelList(session.channels);
  const retainedLibrary = useRef<AgentLibrary>(noLibrary);
  if (library.status === "ready") retainedLibrary.current = library;
  const displayedLibrary =
    library.status === "ready" ? library : retainedLibrary.current;
  const [activity, setActivity] = useState<ActivityState>({
    status: "idle",
    events: noActivity,
  });
  const activityRef = useRef(activity);
  activityRef.current = activity;
  const [activityAttempt, setActivityAttempt] = useState(0);
  const [query, setQuery] = useState("");

  useEffect(() => {
    void session.agentLibrary.refresh();
    void session.archives.refresh();
  }, [session]);

  const archivedPubkeys = useMemo(() => new Set(archives.archived), [archives]);
  const agents = useMemo(
    () => agentNodes(displayedLibrary, (pubkey) => archivedPubkeys.has(pubkey)),
    [displayedLibrary, archivedPubkeys],
  );
  const pubkeys = useMemo(
    () => agents.flatMap((agent) => agent.identityPubkeys),
    [agents],
  );
  const channelIds = useMemo(
    () => channels.channels.map((channel) => channel.id),
    [channels.channels],
  );

  useEffect(() => {
    // An explicit attempt token restarts this finite read even when the library
    // and roster snapshots are referentially unchanged.
    void activityAttempt;
    if (library.status !== "ready" || channels.status !== "ready") return;
    if (!pubkeys.length || !channelIds.length) {
      setActivity({ status: "idle", events: noActivity });
      return;
    }
    const controller = new AbortController();
    setActivity({
      status: "loading",
      events: activityRef.current.events,
    });
    void readAgentActivity(
      session,
      pubkeys,
      channelIds,
      controller.signal,
    ).then(
      (events) => {
        if (!controller.signal.aborted)
          setActivity({ status: "ready", events });
      },
      (error) => {
        if (!controller.signal.aborted)
          setActivity({
            status: "error",
            events: activityRef.current.events,
            error: error instanceof Error ? error.message : String(error),
          });
      },
    );
    return () => controller.abort();
  }, [
    session,
    library.status,
    channels.status,
    pubkeys,
    channelIds,
    activityAttempt,
  ]);

  const graph = useMemo(
    () =>
      buildAgentChannelGraph(
        channels.channels,
        agents,
        activity.events,
        channels.coverage !== "partial" && channels.status === "ready",
      ),
    [
      channels.channels,
      channels.coverage,
      channels.status,
      agents,
      activity.events,
    ],
  );
  const agentsById = useMemo(
    () => new Map(graph.agents.map((agent) => [agent.id, agent])),
    [graph.agents],
  );
  const edgesByChannel = useMemo(() => {
    const grouped = new Map<string, Array<(typeof graph.edges)[number]>>();
    for (const edge of graph.edges) {
      const edges = grouped.get(edge.channelId);
      if (edges) edges.push(edge);
      else grouped.set(edge.channelId, [edge]);
    }
    return grouped;
  }, [graph.edges]);
  const rows = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return graph.channels
      .flatMap((channel) => {
        const edges = edgesByChannel.get(channel.id) ?? [];
        if (!edges.length) return [];
        const relatedAgents = edges.flatMap((edge) => {
          const agent = agentsById.get(edge.agentId);
          return agent ? [agent] : [];
        });
        if (
          needle &&
          !channel.name.toLocaleLowerCase().includes(needle) &&
          !relatedAgents.some((agent) =>
            agent.name.toLocaleLowerCase().includes(needle),
          )
        )
          return [];
        return [
          {
            channel,
            edges,
            agents: relatedAgents,
            current: edges.some((edge) => edge.membership === "current"),
            membershipUnknown: edges.some(
              (edge) => edge.membership === "unknown",
            ),
            lastObservedAt: Math.max(
              0,
              ...edges.map((edge) => edge.lastObservedAt ?? 0),
            ),
          },
        ];
      })
      .sort(
        (a, b) =>
          Number(b.current) - Number(a.current) ||
          b.lastObservedAt - a.lastObservedAt ||
          a.channel.name.localeCompare(b.channel.name, "en"),
      );
  }, [graph, edgesByChannel, agentsById, query]);

  const relationshipChannelCount = useMemo(
    () => new Set(graph.edges.map((edge) => edge.channelId)).size,
    [graph.edges],
  );
  const updateError = library.error ?? channels.error ?? activity.error;
  const loading =
    library.status === "loading" ||
    channels.status === "loading" ||
    activity.status === "loading";
  const refresh = () => {
    setActivityAttempt((attempt) => attempt + 1);
    void session.agentLibrary.refresh();
    void session.archives.refresh();
    session.channels.refreshList?.();
  };

  return (
    <div className="mx-auto max-w-6xl">
      <header className="flex flex-wrap items-start justify-between gap-5">
        <div>
          <p className="eyebrow m-0">CURRENT COMMUNITY</p>
          <h1 className="mb-2 mt-2 text-3xl font-medium tracking-tight">
            Agent channels
          </h1>
          <p className="m-0 max-w-2xl text-sm text-muted">
            Where your Buzz agents are members now, plus recent agent activity
            we could verify.
          </p>
        </div>
        <button
          type="button"
          className="inline-flex items-center gap-2 rounded-xl bg-soft px-3 py-2 text-xs text-ink"
          disabled={loading || library.status === "unavailable"}
          onClick={refresh}
        >
          <RefreshCw size={14} aria-hidden="true" />
          {activity.status === "error" || library.status === "error"
            ? "Retry"
            : "Refresh"}
        </button>
      </header>

      <div className="mt-7 grid grid-cols-2 gap-3 sm:w-fit sm:grid-cols-[repeat(2,9rem)]">
        <Stat value={relationshipChannelCount} label="channels" />
        <Stat value={agents.length} label="agents" />
      </div>

      <div className="mt-7 flex flex-wrap items-center justify-between gap-3 border-b border-line pb-4">
        <label className="flex min-w-0 flex-1 items-center gap-2 sm:max-w-sm">
          <Search
            size={16}
            className="shrink-0 text-muted"
            aria-hidden="true"
          />
          <span className="sr-only">Search channels and agents</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search channels or agents…"
            className="min-w-0 flex-1 rounded-xl border border-input-line bg-surface px-3 py-2 text-sm"
          />
        </label>
        {loading && (
          <p role="status" className="m-0 text-xs text-muted">
            Updating relationships…
          </p>
        )}
      </div>

      {updateError && !!rows.length && (
        <div role="alert" className="notice mb-0">
          <p className="m-0">
            Showing the relationships already found, but the latest update did
            not finish. {updateError}
          </p>
          <button type="button" className="mt-3" onClick={refresh}>
            Retry update
          </button>
        </div>
      )}

      <PageState
        library={library}
        channels={channels}
        activity={activity}
        hasAgents={agents.length > 0}
        hasRows={rows.length > 0}
        query={query}
        retry={refresh}
      />

      {!!rows.length && (
        <ol className="m-0 divide-y divide-line p-0">
          {rows.map((row) => (
            <ChannelRow key={row.channel.id} {...row} session={session} />
          ))}
        </ol>
      )}

      {!!rows.length && channels.coverage === "partial" && (
        <p className="mt-5 text-xs text-muted">
          The community roster is partial, so membership is shown as unknown and
          additional channel relationships may be missing from this view.
        </p>
      )}
      {!!rows.length && graph.edgesLimited && (
        <p className="mt-5 text-xs text-muted">
          This view is limited to the {GRAPH_EDGE_LIMIT.toLocaleString()} most
          relevant agent-channel relationships.
        </p>
      )}
      {!!rows.length && activity.events.length >= HISTORY_EVENT_LIMIT && (
        <p className="mt-5 text-xs text-muted">
          Activity is limited to the {HISTORY_EVENT_LIMIT.toLocaleString()} most
          recent eligible messages returned for these agents.
        </p>
      )}
      {!!rows.length && archives.status !== "ready" && (
        <p className="mt-5 text-xs text-muted">
          Archive visibility is unavailable. Saved library identities remain
          visible; this does not grant channel access.
        </p>
      )}
    </div>
  );
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className="rounded-2xl border border-line bg-soft/70 px-4 py-3">
      <strong className="block text-2xl font-medium tracking-tight">
        {value}
      </strong>
      <span className="text-xs text-muted">{label}</span>
    </div>
  );
}

function PageState({
  library,
  channels,
  activity,
  hasAgents,
  hasRows,
  query,
  retry,
}: {
  library: AgentLibrary & { status: string; error?: string };
  channels: ReturnType<typeof useChannelList>;
  activity: ActivityState;
  hasAgents: boolean;
  hasRows: boolean;
  query: string;
  retry: () => void;
}) {
  if (library.status === "unavailable")
    return (
      <EmptyState text="Your current Buzz agent library is available through the local live development host." />
    );
  const error = library.error ?? channels.error ?? activity.error;
  if (error && !hasRows)
    return (
      <div role="alert" className="notice">
        <p className="m-0">Couldn’t update agent channels. {error}</p>
        <button type="button" className="mt-3" onClick={retry}>
          Retry
        </button>
      </div>
    );
  if (library.status === "ready" && !hasAgents)
    return (
      <EmptyState text="No active identities are linked to your Buzz agents." />
    );
  if (!hasRows && library.status === "ready" && channels.status === "ready")
    return (
      <EmptyState
        text={
          query
            ? "No channels or agents match your search."
            : activity.status === "loading"
              ? "Checking recent agent activity…"
              : "No current memberships or verified agent activity found in this community."
        }
      />
    );
  return null;
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="py-16 text-center">
      <p role="status" className="mx-auto max-w-lg text-sm text-muted">
        {text}
      </p>
    </div>
  );
}

const CHANNEL_DETAILS_LIMIT = 200;

function ChannelRow({
  channel,
  edges,
  agents,
  current,
  membershipUnknown,
  lastObservedAt,
  session,
}: {
  channel: ReturnType<typeof buildAgentChannelGraph>["channels"][number];
  edges: ReturnType<typeof buildAgentChannelGraph>["edges"];
  agents: readonly AgentNode[];
  current: boolean;
  membershipUnknown: boolean;
  lastObservedAt: number;
  session: RelaySession;
}) {
  const [expanded, setExpanded] = useState(false);
  const details = useMemo(() => {
    const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
    return edges.slice(0, CHANNEL_DETAILS_LIMIT).flatMap((edge) => {
      const agent = agentsById.get(edge.agentId);
      return agent ? [{ edge, agent }] : [];
    });
  }, [agents, edges]);
  return (
    <li className="list-none py-5">
      <details
        className="group"
        onToggle={(event) => setExpanded(event.currentTarget.open)}
      >
        <summary className="grid cursor-pointer list-none grid-cols-[minmax(0,1fr)_auto] items-center gap-4 rounded-xl px-2 py-1 hover:bg-hover">
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h2 className="m-0 truncate text-base font-semibold">
                {channel.name}
              </h2>
              <span
                className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                  current ? "bg-primary text-on-primary" : "bg-soft text-muted"
                }`}
              >
                {current
                  ? "Current"
                  : membershipUnknown
                    ? "Membership unknown"
                    : "Past activity"}
              </span>
            </div>
            <p className="m-0 mt-1 flex flex-wrap items-center gap-x-3 text-xs text-muted">
              <span className="capitalize">{channel.kind ?? "channel"}</span>
              <span>
                {agents.length} {agents.length === 1 ? "agent" : "agents"}
              </span>
              {lastObservedAt > 0 && (
                <span className="inline-flex items-center gap-1">
                  <Clock3 size={12} aria-hidden="true" />
                  Last observed {formatTime(lastObservedAt)}
                </span>
              )}
            </p>
          </div>
          <AvatarStack agents={agents} session={session} />
        </summary>
        {expanded && (
          <ul className="ml-2 mt-3 space-y-2 border-l border-line py-1 pl-4 sm:ml-5">
            {details.map(({ edge, agent }) => (
              <li
                key={edge.agentId}
                className="flex flex-wrap items-center justify-between gap-2 text-sm"
              >
                <span className="font-medium">{agent.name}</span>
                <span className="flex flex-wrap items-center gap-2 text-xs text-muted">
                  {edge.membership === "current" && "Member now"}
                  {edge.membership === "past" && "No longer a member"}
                  {edge.membership === "unknown" && "Membership unknown"}
                  {edge.observedMessageCount > 0 && (
                    <span className="inline-flex items-center gap-1">
                      <History size={12} aria-hidden="true" />
                      {edge.observedMessageCount} observed
                    </span>
                  )}
                </span>
              </li>
            ))}
            {edges.length > CHANNEL_DETAILS_LIMIT && (
              <li className="text-xs text-muted">
                Showing {CHANNEL_DETAILS_LIMIT.toLocaleString()} of{" "}
                {edges.length.toLocaleString()} relationships in this channel.
              </li>
            )}
          </ul>
        )}
      </details>
    </li>
  );
}

function AvatarStack({
  agents,
  session,
}: {
  agents: readonly AgentNode[];
  session: RelaySession;
}) {
  return (
    <div
      className="flex pl-2"
      role="img"
      aria-label={agents.map((agent) => agent.name).join(", ")}
    >
      {agents.slice(0, 4).map((agent, index) => {
        const source = avatarSource(agent.avatar);
        const picture = source?.startsWith("data:")
          ? source
          : source
            ? session.media(source)
            : undefined;
        return (
          <Avatar
            key={agent.id}
            name={agent.name}
            src={picture}
            className={`size-8 rounded-xl border-2 border-surface text-[10px] ${index ? "-ml-2" : ""}`}
          />
        );
      })}
      {agents.length > 4 && (
        <span className="-ml-2 inline-grid size-8 place-items-center rounded-xl border-2 border-surface bg-soft text-[10px] text-muted">
          +{agents.length - 4}
        </span>
      )}
    </div>
  );
}

function formatTime(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
  }).format(new Date(timestamp * 1000));
}
