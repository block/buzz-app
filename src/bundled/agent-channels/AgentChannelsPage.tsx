import {
  Check,
  ExternalLink,
  GitBranch,
  GitMerge,
  GitPullRequest,
  History,
  Network,
  RefreshCw,
  Rocket,
  Search,
  Sparkles,
  UsersRound,
} from "lucide-react";
import {
  type CSSProperties,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type {
  ExternalObjectDetails,
  Objects,
} from "../../features/objects/service";
import type { AgentLibrary } from "../../features/agents/library";
import { useChannelList, useRelayConnection } from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { Avatar } from "../../shared/Avatar";
import { avatarSource } from "../../shared/avatar-source";
import {
  buildAgentDashboard,
  buildAgentFocusNetwork,
  type AgentDashboardRow,
  type AgentFocusNetwork,
} from "./dashboard";
import { extractAgentOutcomes, type AgentOutcomeReference } from "./outcomes";
import {
  agentNodes,
  buildAgentChannelGraph,
  GRAPH_EDGE_LIMIT,
  HISTORY_EVENT_LIMIT,
  readAgentActivity,
  type ChannelNode,
} from "./relationships";

export function AgentChannelsPage({
  relay,
  objects,
}: {
  relay: RelayData;
  objects: Objects;
}) {
  const connection = useRelayConnection(relay);
  return (
    <section
      aria-label="Agent dashboard"
      className="h-full min-h-0 overflow-auto rounded-3xl border border-line bg-surface px-5 py-6 shadow-surface sm:px-8 sm:py-8"
    >
      {connection.status === "ready" ? (
        <AgentDashboard
          key={`${connection.scope}:${connection.generation}`}
          session={connection.session}
          objects={objects}
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
      <Network size={28} aria-hidden="true" />
      <h1 className="mb-2 mt-4 text-3xl font-medium tracking-tight">
        Agent dashboard
      </h1>
      <p className="max-w-md text-sm text-muted">
        {status === "connecting"
          ? "Connecting to your community…"
          : "Connect to a community to see where your agents are working."}
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

function AgentDashboard({
  session,
  objects,
}: {
  session: RelaySession;
  objects: Objects;
}) {
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
  const objectProviders = useSyncExternalStore(
    objects.subscribe,
    objects.snapshot,
    objects.snapshot,
  );
  const providerRevision = objectProviders
    .map((provider) => provider.key)
    .join("\n");
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
  const [selectedAgentId, setSelectedAgentId] = useState<string>();
  const [view, setView] = useState<"map" | "outcomes">("map");

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
    void activityAttempt;
    if (library.status !== "ready" || channels.status !== "ready") return;
    if (!pubkeys.length || !channelIds.length) {
      setActivity({ status: "idle", events: noActivity });
      return;
    }
    const controller = new AbortController();
    setActivity({ status: "loading", events: activityRef.current.events });
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
  const dashboard = useMemo(() => buildAgentDashboard(graph), [graph]);
  const filteredDashboard = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return dashboard;
    return dashboard.filter(
      (row) =>
        row.agent.name.toLocaleLowerCase().includes(needle) ||
        row.relationships.some(({ channel }) =>
          channel.name.toLocaleLowerCase().includes(needle),
        ),
    );
  }, [dashboard, query]);
  const effectiveAgentId = filteredDashboard.some(
    (row) => row.agent.id === selectedAgentId,
  )
    ? selectedAgentId
    : filteredDashboard[0]?.agent.id;
  const focus = useMemo(
    () =>
      effectiveAgentId
        ? buildAgentFocusNetwork(dashboard, effectiveAgentId)
        : undefined,
    [dashboard, effectiveAgentId],
  );
  const relationshipChannelCount = useMemo(
    () => new Set(graph.edges.map((edge) => edge.channelId)).size,
    [graph.edges],
  );
  const observedMessageCount = dashboard.reduce(
    (total, row) => total + row.observedMessageCount,
    0,
  );
  const outcomeReferences = useMemo(() => {
    if (!providerRevision) return Object.freeze([]);
    return extractAgentOutcomes(
      activity.events,
      graph.agents,
      graph.channels,
      objects,
    );
  }, [
    activity.events,
    graph.agents,
    graph.channels,
    objects,
    providerRevision,
  ]);
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
  const hasRelationships = graph.edges.length > 0;

  return (
    <div className="mx-auto max-w-7xl">
      <header className="flex flex-wrap items-start justify-between gap-5">
        <div>
          <p className="eyebrow m-0">CURRENT COMMUNITY</p>
          <h1 className="mb-2 mt-2 text-3xl font-medium tracking-tight">
            Agent dashboard
          </h1>
          <p className="m-0 max-w-2xl text-sm text-muted">
            A bird’s-eye view of where your agents work, what we observed, and
            where their paths cross.
          </p>
          <p className="m-0 mt-3 text-xs text-muted">
            {dashboard.length} agents · {relationshipChannelCount} channels ·{" "}
            {observedMessageCount.toLocaleString()} messages sampled
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

      <div className="mt-5 flex flex-wrap items-center gap-3 border-b border-line pb-4">
        <div
          role="tablist"
          aria-label="Dashboard view"
          className="inline-flex rounded-xl bg-soft p-1"
        >
          <ViewTab
            active={view === "map"}
            icon={<Network size={14} aria-hidden="true" />}
            label="Map"
            onSelect={() => setView("map")}
          />
          <ViewTab
            active={view === "outcomes"}
            icon={<Rocket size={14} aria-hidden="true" />}
            label="Outcomes"
            count={providerRevision ? outcomeReferences.length : undefined}
            onSelect={() => setView("outcomes")}
          />
        </div>
        <label className="flex min-w-0 flex-1 items-center gap-2 sm:max-w-sm">
          <Search
            size={16}
            className="shrink-0 text-muted"
            aria-hidden="true"
          />
          <span className="sr-only">Search agents and channels</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find an agent or channel…"
            className="min-w-0 flex-1 rounded-xl border border-input-line bg-surface px-3 py-2 text-sm"
          />
        </label>
        {loading && (
          <p role="status" className="m-0 text-xs text-muted">
            Updating the map…
          </p>
        )}
      </div>

      {updateError && hasRelationships && (
        <div role="alert" className="notice mb-0">
          <p className="m-0">
            Showing the dashboard already found, but the latest update did not
            finish. {updateError}
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
        hasRelationships={hasRelationships}
        retry={refresh}
      />

      {hasRelationships && view === "map" && (
        <>
          <section aria-labelledby="agent-roster-title" className="mt-7">
            <div className="mb-3 flex items-end justify-between gap-4">
              <div>
                <p className="eyebrow m-0">YOUR AGENTS</p>
                <h2
                  id="agent-roster-title"
                  className="m-0 mt-1 text-lg font-semibold"
                >
                  Overview for
                </h2>
              </div>
              <span className="text-xs text-muted">
                {filteredDashboard.length} of {dashboard.length}
              </span>
            </div>
            {filteredDashboard.length ? (
              <>
                <select
                  aria-label="Choose an agent"
                  value={effectiveAgentId}
                  onChange={(event) => setSelectedAgentId(event.target.value)}
                  className="w-full rounded-xl border border-input-line bg-surface px-3 py-3 text-sm sm:hidden"
                >
                  {filteredDashboard.map((row) => (
                    <option key={row.agent.id} value={row.agent.id}>
                      {row.agent.name} · {row.currentChannelCount} current ·{" "}
                      {row.observedMessageCount} sampled
                    </option>
                  ))}
                </select>
                <div className="hidden gap-2 sm:grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {filteredDashboard.map((row) => (
                    <AgentCard
                      key={row.agent.id}
                      row={row}
                      selected={row.agent.id === effectiveAgentId}
                      session={session}
                      onSelect={() => setSelectedAgentId(row.agent.id)}
                    />
                  ))}
                </div>
              </>
            ) : (
              <EmptyState text="No agents or channels match your search." />
            )}
          </section>

          {focus && (
            <section aria-labelledby="network-title" className="mt-8">
              <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
                <div>
                  <p className="eyebrow m-0">RELATIONSHIP MAP</p>
                  <h2
                    id="network-title"
                    className="m-0 mt-1 text-lg font-semibold"
                  >
                    Agent network
                  </h2>
                </div>
                <p className="m-0 text-xs text-muted">
                  Agent → channel → collaborator
                </p>
              </div>
              <AgentNetwork
                focus={focus}
                session={session}
                onSelectAgent={setSelectedAgentId}
              />
              <AgentDetails focus={focus} />
            </section>
          )}
        </>
      )}

      {hasRelationships &&
        view === "outcomes" &&
        (providerRevision ? (
          <OutcomesDashboard
            references={outcomeReferences}
            objects={objects}
            dashboard={dashboard}
            channels={graph.channels}
            session={session}
            query={query}
            onSelectAgent={(agentId) => {
              setSelectedAgentId(agentId);
              setView("map");
            }}
          />
        ) : (
          <section className="mt-8 rounded-3xl border border-dashed border-line bg-soft/30 p-8 text-center">
            <GitPullRequest
              size={26}
              className="mx-auto text-muted"
              aria-hidden="true"
            />
            <h2 className="mb-2 mt-4 text-lg font-semibold">
              GitHub outcomes are off
            </h2>
            <p className="mx-auto mb-0 max-w-lg text-sm text-muted">
              Enable the GitHub plugin to match shared pull requests with their
              latest public state. The relationship map works independently.
            </p>
          </section>
        ))}

      {hasRelationships && channels.coverage === "partial" && (
        <Footnote>
          The community roster is partial, so membership is shown as unknown and
          additional relationships may be missing.
        </Footnote>
      )}
      {hasRelationships && graph.edgesLimited && (
        <Footnote>
          The dashboard is limited to the {GRAPH_EDGE_LIMIT.toLocaleString()}{" "}
          most relevant agent-channel relationships.
        </Footnote>
      )}
      {hasRelationships && activity.events.length >= HISTORY_EVENT_LIMIT && (
        <Footnote>
          Message totals are a recent sample of up to{" "}
          {HISTORY_EVENT_LIMIT.toLocaleString()} eligible messages across this
          community—not lifetime totals.
        </Footnote>
      )}
      {hasRelationships && archives.status !== "ready" && (
        <Footnote>
          Archive visibility is unavailable. Saved library identities remain
          visible; this does not grant channel access.
        </Footnote>
      )}
    </div>
  );
}

type LoadedOutcome = Readonly<{
  outcome: AgentOutcomeReference;
  details?: ExternalObjectDetails;
  error?: string;
}>;

function ViewTab({
  active,
  icon,
  label,
  count,
  onSelect,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  count?: number | undefined;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onSelect}
      className={`inline-flex items-center gap-2 rounded-lg border-0 px-3 py-1.5 text-xs font-semibold ${
        active ? "bg-surface text-ink shadow-card" : "bg-transparent text-muted"
      }`}
    >
      {icon}
      {label}
      {count !== undefined && (
        <span
          className={`text-[10px] ${active ? "text-primary" : "text-muted"}`}
        >
          {count}
        </span>
      )}
    </button>
  );
}

function OutcomesDashboard({
  references,
  objects,
  dashboard,
  channels,
  session,
  query,
  onSelectAgent,
}: {
  references: readonly AgentOutcomeReference[];
  objects: Objects;
  dashboard: readonly AgentDashboardRow[];
  channels: readonly ChannelNode[];
  session: RelaySession;
  query: string;
  onSelectAgent: (agentId: string) => void;
}) {
  const [loaded, setLoaded] = useState<readonly LoadedOutcome[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "ready">("idle");
  const [selectedKey, setSelectedKey] = useState<string>();
  useEffect(() => {
    if (!references.length) {
      setLoaded([]);
      setStatus("idle");
      return;
    }
    const controller = new AbortController();
    setStatus("loading");
    void loadOutcomeDetails(references, objects, controller.signal).then(
      (next) => {
        if (!controller.signal.aborted) {
          setLoaded(next);
          setStatus("ready");
        }
      },
      () => {
        if (!controller.signal.aborted) setStatus("ready");
      },
    );
    return () => controller.abort();
  }, [objects, references]);

  const agents = useMemo(
    () => new Map(dashboard.map((row) => [row.agent.id, row])),
    [dashboard],
  );
  const channelNames = useMemo(
    () => new Map(channels.map((channel) => [channel.id, channel.name])),
    [channels],
  );
  const needle = query.trim().toLocaleLowerCase();
  const visible = loaded.filter(({ outcome, details }) => {
    if (!needle) return true;
    return (
      details?.title.toLocaleLowerCase().includes(needle) ||
      outcome.reference.group?.toLocaleLowerCase().includes(needle) ||
      outcome.evidence.some((evidence) =>
        agents
          .get(evidence.agentId)
          ?.agent.name.toLocaleLowerCase()
          .includes(needle),
      )
    );
  });
  const merged = loaded.filter(
    (item) => item.details?.state === "Merged",
  ).length;
  const open = loaded.filter((item) => item.details?.state === "open").length;
  const draft = loaded.filter((item) => item.details?.state === "Draft").length;
  const repositoryCount = new Set(
    loaded.flatMap(({ outcome }) => outcome.reference.group ?? []),
  ).size;
  const selected =
    visible.find((item) => item.outcome.key === selectedKey) ?? visible[0];

  if (!references.length)
    return (
      <section className="mt-8 rounded-3xl border border-dashed border-line bg-soft/30 p-8 text-center">
        <GitPullRequest
          size={26}
          className="mx-auto text-muted"
          aria-hidden="true"
        />
        <h2 className="mb-2 mt-4 text-lg font-semibold">
          No pull requests in the sample yet
        </h2>
        <p className="mx-auto mb-0 max-w-lg text-sm text-muted">
          When one of your agents shares a public GitHub pull request in a
          channel, its outcome will land here with the signed message as
          evidence.
        </p>
      </section>
    );

  return (
    <section aria-labelledby="outcomes-title" className="mt-7">
      <div className="relative overflow-hidden rounded-3xl border border-line bg-soft/30 p-5 sm:p-6">
        <div className="pointer-events-none absolute -right-16 -top-24 size-72 rounded-full bg-success-surface opacity-70 blur-3xl" />
        <div className="relative flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="eyebrow m-0 inline-flex items-center gap-2">
              <Sparkles size={13} aria-hidden="true" /> SHIPPED WORK
            </p>
            <h2 id="outcomes-title" className="mb-1 mt-2 text-xl font-semibold">
              Outcomes
            </h2>
            <p className="m-0 max-w-2xl text-sm text-muted">
              Pull requests your agents shared, enriched with their latest
              public GitHub state. Association is backed by the signed Buzz
              message.
            </p>
          </div>
          {status === "loading" && (
            <p role="status" className="m-0 text-xs text-muted">
              Following branches to GitHub…
            </p>
          )}
        </div>
        <dl className="relative mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <OutcomeMetric
            icon={<GitMerge size={16} />}
            value={merged}
            label="merged"
            tone="success"
          />
          <OutcomeMetric
            icon={<GitPullRequest size={16} />}
            value={open}
            label="open"
          />
          <OutcomeMetric
            icon={<GitBranch size={16} />}
            value={draft}
            label="draft"
          />
          <OutcomeMetric
            icon={<Rocket size={16} />}
            value={repositoryCount}
            label="repositories"
          />
        </dl>
      </div>

      {status === "ready" && visible.length === 0 ? (
        <EmptyState text="No outcomes match your search." />
      ) : (
        <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="min-w-0 space-y-4">
            <OutcomeFlow
              items={visible}
              selected={selected}
              agents={agents}
              channelNames={channelNames}
              session={session}
              onSelect={(key) => setSelectedKey(key)}
            />
            <div className="overflow-hidden rounded-2xl border border-line">
              <div className="flex items-center justify-between border-b border-line px-4 py-3">
                <h3 className="m-0 text-sm font-semibold">All pull requests</h3>
                <span className="text-[11px] text-muted">
                  {visible.length} outcomes
                </span>
              </div>
              <div className="divide-y divide-line">
                {visible.map((item) => (
                  <OutcomeRow
                    key={item.outcome.key}
                    item={item}
                    selected={item === selected}
                    agents={agents}
                    channelNames={channelNames}
                    onSelect={() => setSelectedKey(item.outcome.key)}
                  />
                ))}
              </div>
            </div>
          </div>
          {selected && (
            <OutcomeInspector
              item={selected}
              agents={agents}
              channelNames={channelNames}
              onSelectAgent={onSelectAgent}
            />
          )}
        </div>
      )}
      <p className="mb-0 mt-4 text-[11px] leading-relaxed text-muted">
        Public GitHub data only. “Shared by” proves observable association—not
        PR authorship or that an agent caused the merge.
      </p>
    </section>
  );
}

function OutcomeFlow({
  items,
  selected,
  agents,
  channelNames,
  session,
  onSelect,
}: {
  items: readonly LoadedOutcome[];
  selected: LoadedOutcome | undefined;
  agents: Map<string, AgentDashboardRow>;
  channelNames: Map<string, string>;
  session: RelaySession;
  onSelect: (key: string) => void;
}) {
  return (
    <div className="overflow-hidden rounded-3xl border border-line bg-soft/30">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
        <div>
          <h3 className="m-0 text-sm font-semibold">Shipping paths</h3>
          <p className="m-0 mt-0.5 text-[11px] text-muted">
            Follow each signed share from agent to GitHub outcome.
          </p>
        </div>
        <div className="flex items-center gap-3 text-[10px] text-muted">
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-success" /> Landed
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2 rounded-full border border-input-line bg-surface" />
            In flight
          </span>
        </div>
      </div>
      <div className="overflow-x-auto p-3 sm:p-4">
        <div className="min-w-[650px]">
          <div className="mb-2 grid grid-cols-[8rem_9rem_minmax(8rem,1fr)_12rem] gap-3 px-3 text-[9px] font-semibold uppercase tracking-[0.14em] text-muted">
            <span>Agent signal</span>
            <span>Channel</span>
            <span>Branch</span>
            <span>GitHub outcome</span>
          </div>
          <div className="space-y-2">
            {items.length ? (
              items.map((item) => (
                <OutcomePath
                  key={item.outcome.key}
                  item={item}
                  selected={item === selected}
                  agents={agents}
                  channelNames={channelNames}
                  session={session}
                  onSelect={() => onSelect(item.outcome.key)}
                />
              ))
            ) : (
              <div
                role="status"
                className="rounded-2xl border border-dashed border-line bg-surface/60 px-4 py-8 text-center text-xs text-muted"
              >
                Tracing shared pull requests…
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function OutcomePath({
  item,
  selected,
  agents,
  channelNames,
  session,
  onSelect,
}: {
  item: LoadedOutcome;
  selected: boolean;
  agents: Map<string, AgentDashboardRow>;
  channelNames: Map<string, string>;
  session: RelaySession;
  onSelect: () => void;
}) {
  const evidence = item.outcome.evidence[0];
  const uniqueAgentIds = [
    ...new Set(item.outcome.evidence.map((item) => item.agentId)),
  ];
  const uniqueChannelIds = [
    ...new Set(item.outcome.evidence.map((item) => item.channelId)),
  ];
  const state = item.details?.state;
  const merged = state === "Merged";
  const facts = new Map(item.details?.facts ?? []);
  const title =
    item.details?.title ??
    `${item.outcome.reference.group} ${item.outcome.reference.label}`;
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={`${title}, ${state ?? "checking"}. Inspect shipping path`}
      onClick={onSelect}
      className={`group relative grid w-full grid-cols-[8rem_9rem_minmax(8rem,1fr)_12rem] items-center gap-3 overflow-hidden rounded-2xl border px-3 py-3 text-left shadow-none ${
        selected
          ? "border-input-line bg-surface shadow-card"
          : "border-line bg-surface/60 hover:bg-surface"
      }`}
    >
      <span
        className={`pointer-events-none absolute left-[6.5rem] right-[10.5rem] top-1/2 border-t ${
          merged
            ? "border-solid border-success"
            : "border-dashed border-input-line"
        }`}
      />
      <span className="relative z-10 flex min-w-0 items-center">
        <span className="flex -space-x-2">
          {uniqueAgentIds.slice(0, 3).map((agentId) => {
            const agent = agents.get(agentId);
            return agent ? (
              <AgentAvatar
                key={agentId}
                row={agent}
                session={session}
                className="size-9 rounded-xl border-2 border-surface text-[9px] shadow-card"
              />
            ) : null;
          })}
        </span>
        <span className="ml-2 min-w-0">
          <strong className="block truncate text-[11px]">
            {uniqueAgentIds.length === 1
              ? (agents.get(uniqueAgentIds[0] ?? "")?.agent.name ?? "Agent")
              : `${uniqueAgentIds.length} agents`}
          </strong>
          <span className="block text-[9px] text-muted">shared</span>
        </span>
      </span>
      <span className="relative z-10 min-w-0 rounded-xl border border-line bg-soft px-2.5 py-2 shadow-card">
        <span className="block truncate text-[10px] font-semibold">
          #{channelNames.get(evidence?.channelId ?? "") ?? "channel"}
        </span>
        <span className="mt-0.5 block text-[9px] text-muted">
          {uniqueChannelIds.length > 1
            ? `+${uniqueChannelIds.length - 1} more`
            : evidence
              ? formatRelativeTime(evidence.sharedAt)
              : "signed share"}
        </span>
      </span>
      <span className="relative z-10 min-w-0 px-2">
        <span className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-surface px-2 py-1 text-[9px] text-muted shadow-card">
          <GitBranch size={10} className="shrink-0" aria-hidden="true" />
          <span className="truncate">
            {String(facts.get("Branch") ?? "branch → main")}
          </span>
        </span>
      </span>
      <span
        className={`relative z-10 grid min-h-16 grid-cols-[auto_minmax(0,1fr)] items-center gap-2 rounded-xl border p-2.5 ${
          merged
            ? "border-success bg-success-surface text-success"
            : "border-line bg-surface text-ink"
        }`}
      >
        <span
          className={`grid size-8 place-items-center rounded-lg ${
            merged ? "bg-surface/70" : "bg-soft text-muted"
          }`}
        >
          {merged ? (
            <GitMerge size={15} aria-hidden="true" />
          ) : (
            <GitPullRequest size={15} aria-hidden="true" />
          )}
        </span>
        <span className="min-w-0">
          <span className="block text-[9px] font-semibold uppercase tracking-wide">
            {merged ? "Landed" : state || "Checking"}
          </span>
          <strong className="mt-0.5 block truncate text-[10px] text-ink">
            {item.outcome.reference.group} {item.outcome.reference.label}
          </strong>
        </span>
      </span>
    </button>
  );
}

async function loadOutcomeDetails(
  references: readonly AgentOutcomeReference[],
  objects: Objects,
  signal: AbortSignal,
): Promise<readonly LoadedOutcome[]> {
  const results: LoadedOutcome[] = [];
  const queue = [...references];
  await Promise.all(
    Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (queue.length) {
        signal.throwIfAborted();
        const outcome = queue.shift();
        if (!outcome) return;
        try {
          const details = await objects.load(outcome.reference.url, signal);
          results.push(
            Object.freeze({ outcome, ...(details ? { details } : {}) }),
          );
        } catch (error) {
          if (signal.aborted) throw error;
          results.push(
            Object.freeze({
              outcome,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      }
    }),
  );
  const order = new Map(
    references.map((outcome, index) => [outcome.key, index]),
  );
  return Object.freeze(
    results.sort(
      (a, b) =>
        (order.get(a.outcome.key) ?? 0) - (order.get(b.outcome.key) ?? 0),
    ),
  );
}

function OutcomeMetric({
  icon,
  value,
  label,
  tone,
}: {
  icon: React.ReactNode;
  value: number;
  label: string;
  tone?: "success";
}) {
  return (
    <div className="rounded-2xl border border-line bg-surface/80 p-3 backdrop-blur-sm">
      <dt
        className={`flex items-center gap-2 text-[11px] ${tone ? "text-success" : "text-muted"}`}
      >
        {icon} {label}
      </dt>
      <dd className="m-0 mt-2 text-2xl font-semibold tracking-tight">
        {value}
      </dd>
    </div>
  );
}

function OutcomeRow({
  item,
  selected,
  agents,
  channelNames,
  onSelect,
}: {
  item: LoadedOutcome;
  selected: boolean;
  agents: Map<string, AgentDashboardRow>;
  channelNames: Map<string, string>;
  onSelect: () => void;
}) {
  const evidence = item.outcome.evidence[0];
  const agent = evidence ? agents.get(evidence.agentId) : undefined;
  const state = item.details?.state;
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={`grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-none border-0 px-4 py-4 text-left ${
        selected ? "bg-hover" : "bg-surface hover:bg-soft/60"
      }`}
    >
      <span
        className={`grid size-9 place-items-center rounded-xl ${state === "Merged" ? "bg-success-surface text-success" : "bg-soft text-muted"}`}
      >
        {state === "Merged" ? (
          <GitMerge size={17} />
        ) : (
          <GitPullRequest size={17} />
        )}
      </span>
      <span className="min-w-0">
        <span className="flex min-w-0 items-center gap-2">
          <strong className="truncate text-sm">
            {item.details?.title ??
              `${item.outcome.reference.group} ${item.outcome.reference.label}`}
          </strong>
          <OutcomeState state={state} loading={!item.details && !item.error} />
        </span>
        <span className="mt-1 block truncate text-[11px] text-muted">
          {item.outcome.reference.group} · shared by{" "}
          {agent?.agent.name ?? "agent"}
          {evidence
            ? ` in #${channelNames.get(evidence.channelId) ?? "channel"}`
            : ""}
        </span>
      </span>
      <span className="text-right text-[10px] text-muted">
        {evidence ? formatRelativeTime(evidence.sharedAt) : ""}
      </span>
    </button>
  );
}

function OutcomeState({
  state,
  loading,
}: {
  state: string | undefined;
  loading?: boolean;
}) {
  const merged = state === "Merged";
  return (
    <span
      className={`shrink-0 rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${merged ? "bg-success-surface text-success" : "bg-soft text-muted"}`}
    >
      {loading ? "checking" : state || "unavailable"}
    </span>
  );
}

function OutcomeInspector({
  item,
  agents,
  channelNames,
  onSelectAgent,
}: {
  item: LoadedOutcome;
  agents: Map<string, AgentDashboardRow>;
  channelNames: Map<string, string>;
  onSelectAgent: (agentId: string) => void;
}) {
  const facts = new Map(item.details?.facts ?? []);
  const uniqueAgents = [
    ...new Set(item.outcome.evidence.map((evidence) => evidence.agentId)),
  ];
  return (
    <aside className="self-start overflow-hidden rounded-2xl border border-line bg-soft/30 lg:sticky lg:top-0">
      <div className="border-b border-line p-4">
        <p className="eyebrow m-0">OUTCOME EVIDENCE</p>
        <div className="mt-3 flex items-start gap-3">
          <span
            className={`grid size-10 shrink-0 place-items-center rounded-xl ${item.details?.state === "Merged" ? "bg-success-surface text-success" : "bg-surface text-muted"}`}
          >
            {item.details?.state === "Merged" ? (
              <Check size={19} />
            ) : (
              <GitPullRequest size={19} />
            )}
          </span>
          <div className="min-w-0">
            <OutcomeState
              state={item.details?.state}
              loading={!item.details && !item.error}
            />
            <h3 className="mb-0 mt-2 text-base font-semibold leading-snug">
              {item.details?.title ??
                `${item.outcome.reference.group} ${item.outcome.reference.label}`}
            </h3>
          </div>
        </div>
        <a
          href={item.outcome.reference.url}
          target="_blank"
          rel="noreferrer"
          className="mt-4 inline-flex items-center gap-1 text-xs font-semibold text-primary"
        >
          Open pull request <ExternalLink size={12} />
        </a>
      </div>
      <div className="p-4">
        <dl className="grid grid-cols-2 gap-3">
          <InspectorFact
            label="Repository"
            value={item.outcome.reference.group ?? "—"}
          />
          <InspectorFact label="Branch" value={facts.get("Branch") ?? "—"} />
          <InspectorFact label="Changes" value={facts.get("Changes") ?? "—"} />
          <InspectorFact
            label="Files"
            value={facts.get("Files changed") ?? "—"}
          />
        </dl>
        <div className="mt-5 border-t border-line pt-4">
          <p className="m-0 text-[10px] font-semibold uppercase tracking-wide text-muted">
            Shared by agents
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {uniqueAgents.map((agentId) => {
              const agent = agents.get(agentId);
              return agent ? (
                <button
                  key={agentId}
                  type="button"
                  onClick={() => onSelectAgent(agentId)}
                  className="rounded-full bg-surface px-3 py-1.5 text-[11px] font-semibold text-ink"
                >
                  {agent.agent.name} · view map
                </button>
              ) : null;
            })}
          </div>
        </div>
        <ul className="m-0 mt-4 space-y-2 p-0">
          {item.outcome.evidence.slice(0, 4).map((evidence) => (
            <li
              key={evidence.messageEventId}
              className="list-none rounded-xl border border-line bg-surface p-3 text-[11px]"
            >
              <span className="font-semibold">
                {agents.get(evidence.agentId)?.agent.name ?? "Agent"}
              </span>
              <span className="text-muted">
                {" "}
                shared in #{channelNames.get(evidence.channelId) ?? "channel"} ·{" "}
                {formatRelativeTime(evidence.sharedAt)}
              </span>
              <code
                className="mt-1 block truncate text-[9px] text-muted"
                title={evidence.messageEventId}
              >
                signed {evidence.messageEventId.slice(0, 10)}…
              </code>
            </li>
          ))}
        </ul>
        {item.error && (
          <p role="alert" className="mb-0 mt-4 text-[11px] text-warning">
            {item.error}
          </p>
        )}
      </div>
    </aside>
  );
}

function InspectorFact({
  label,
  value,
}: {
  label: string;
  value: string | number;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] text-muted">{label}</dt>
      <dd
        className="m-0 mt-1 truncate text-xs font-semibold"
        title={String(value)}
      >
        {value}
      </dd>
    </div>
  );
}

function AgentCard({
  row,
  selected,
  session,
  onSelect,
}: {
  row: AgentDashboardRow;
  selected: boolean;
  session: RelaySession;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={`flex min-w-0 items-center gap-3 rounded-2xl border px-3 py-3 text-left ${
        selected
          ? "border-primary bg-primary text-on-primary"
          : "border-line bg-soft/50 hover:bg-hover"
      }`}
    >
      <AgentAvatar
        row={row}
        session={session}
        className={`size-11 shrink-0 rounded-2xl text-xs ${
          selected ? "border-2 border-on-primary/40" : ""
        }`}
      />
      <span className="min-w-0 flex-1">
        <strong className="block truncate text-sm font-semibold">
          {row.agent.name}
        </strong>
        <span
          className={`mt-1 block text-[11px] ${
            selected ? "text-on-primary" : "text-muted"
          }`}
        >
          {row.currentChannelCount} current · {row.observedMessageCount} sampled
        </span>
      </span>
      {row.lastObservedAt !== undefined && (
        <span
          className={`hidden text-[10px] xl:block ${
            selected ? "text-on-primary" : "text-muted"
          }`}
        >
          {formatRelativeTime(row.lastObservedAt)}
        </span>
      )}
    </button>
  );
}

const VIEW_WIDTH = 800;
const VIEW_HEIGHT = 500;

function AgentNetwork({
  focus,
  session,
  onSelectAgent,
}: {
  focus: AgentFocusNetwork;
  session: RelaySession;
  onSelectAgent: (agentId: string) => void;
}) {
  const channelPositions = radialPositions(
    focus.channels.length,
    152,
    VIEW_WIDTH / 2,
    VIEW_HEIGHT / 2,
    -Math.PI / 2,
  );
  const collaboratorPositions = radialPositions(
    focus.collaborators.length,
    229,
    VIEW_WIDTH / 2,
    VIEW_HEIGHT / 2,
    -Math.PI / 2 + Math.PI / Math.max(focus.collaborators.length, 1),
  );
  const channelPosition = new Map(
    focus.channels.map(({ channel }, index) => [
      channel.id,
      channelPositions[index],
    ]),
  );

  return (
    <div className="overflow-x-auto rounded-3xl border border-line bg-soft/30">
      <div className="relative mx-auto aspect-[8/5] min-w-[680px] max-w-[1000px] overflow-hidden">
        <span className="sr-only">
          {focus.selected.agent.name} is connected to {focus.channels.length}{" "}
          displayed channels and {focus.collaborators.length} displayed
          collaborators.
        </span>
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,var(--surface)_0,transparent_63%)]" />
        <svg
          aria-hidden="true"
          viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
          className="absolute inset-0 size-full"
        >
          {channelPositions.map((position, index) => (
            <line
              key={`primary-${focus.channels[index]?.channel.id}`}
              x1={VIEW_WIDTH / 2}
              y1={VIEW_HEIGHT / 2}
              x2={position?.x}
              y2={position?.y}
              stroke="var(--primary)"
              strokeWidth="2"
              strokeOpacity="0.65"
            />
          ))}
          {focus.collaborators.flatMap((collaborator, collaboratorIndex) =>
            collaborator.channelIds.flatMap((channelId) => {
              const from = channelPosition.get(channelId);
              const to = collaboratorPositions[collaboratorIndex];
              return from && to
                ? [
                    <line
                      key={`${collaborator.row.agent.id}-${channelId}`}
                      x1={from.x}
                      y1={from.y}
                      x2={to.x}
                      y2={to.y}
                      stroke="var(--border-input)"
                      strokeWidth="1.5"
                      strokeOpacity="0.75"
                    />,
                  ]
                : [];
            }),
          )}
        </svg>

        <div
          className="absolute z-20 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center"
          style={nodeStyle({ x: VIEW_WIDTH / 2, y: VIEW_HEIGHT / 2 })}
        >
          <div className="rounded-[1.4rem] border-4 border-primary bg-surface p-1 shadow-card">
            <AgentAvatar
              row={focus.selected}
              session={session}
              className="size-20 rounded-2xl text-lg"
            />
          </div>
          <span className="mt-2 max-w-36 truncate rounded-full bg-surface px-3 py-1 text-sm font-semibold shadow-card">
            {focus.selected.agent.name}
          </span>
        </div>

        {focus.channels.map((relationship, index) => {
          const position = channelPositions[index];
          if (!position) return null;
          return (
            <div
              key={relationship.channel.id}
              className="absolute z-10 w-32 -translate-x-1/2 -translate-y-1/2 rounded-xl border border-input-line bg-surface px-2 py-2 text-center shadow-card"
              style={nodeStyle(position)}
              title={relationship.channel.name}
            >
              <span className="block truncate text-[11px] font-semibold">
                #{relationship.channel.name}
              </span>
              <span className="mt-0.5 block text-[9px] text-muted">
                {relationship.edge.membership === "current"
                  ? "current"
                  : relationship.edge.membership === "past"
                    ? "past"
                    : "membership unknown"}
                {relationship.edge.observedMessageCount > 0
                  ? ` · ${relationship.edge.observedMessageCount}`
                  : ""}
              </span>
            </div>
          );
        })}

        {focus.collaborators.map((collaborator, index) => {
          const position = collaboratorPositions[index];
          if (!position) return null;
          return (
            <button
              type="button"
              key={collaborator.row.agent.id}
              onClick={() => onSelectAgent(collaborator.row.agent.id)}
              className="absolute z-10 flex w-24 -translate-x-1/2 -translate-y-1/2 flex-col items-center rounded-2xl p-1 hover:bg-hover"
              style={nodeStyle(position)}
              aria-label={`Focus ${collaborator.row.agent.name}, ${collaborator.channelIds.length} shared ${collaborator.channelIds.length === 1 ? "channel" : "channels"}`}
            >
              <AgentAvatar
                row={collaborator.row}
                session={session}
                className="size-11 rounded-2xl border-2 border-surface text-[10px] shadow-card"
              />
              <span className="mt-1 max-w-24 truncate rounded-full bg-surface px-2 py-0.5 text-[10px] font-semibold shadow-card">
                {collaborator.row.agent.name}
              </span>
              <span className="mt-0.5 text-[9px] text-muted">
                {collaborator.channelIds.length} shared
              </span>
            </button>
          );
        })}
      </div>
      {(focus.channelsLimited || focus.collaboratorsLimited) && (
        <p className="m-0 border-t border-line px-4 py-3 text-center text-[11px] text-muted">
          Showing the strongest relationships for a readable map. Full channel
          detail is below.
        </p>
      )}
    </div>
  );
}

function AgentDetails({ focus }: { focus: AgentFocusNetwork }) {
  const row = focus.selected;
  return (
    <div className="mt-4 grid gap-4 lg:grid-cols-[15rem_minmax(0,1fr)]">
      <aside className="rounded-2xl border border-line bg-soft/50 p-4">
        <p className="eyebrow m-0">AT A GLANCE</p>
        <dl className="mt-3 grid grid-cols-2 gap-3">
          <Metric value={row.currentChannelCount} label="current channels" />
          <Metric value={row.pastChannelCount} label="past channels" />
          <Metric value={row.observedMessageCount} label="messages sampled" />
          <Metric
            value={
              row.lastObservedAt ? formatRelativeTime(row.lastObservedAt) : "—"
            }
            label="last observed"
          />
        </dl>
        <p className="mb-0 mt-4 text-[11px] leading-relaxed text-muted">
          Membership comes from the current signed roster. Activity is a bounded
          recent sample, not an execution or online-status signal.
        </p>
      </aside>
      <div className="rounded-2xl border border-line">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h3 className="m-0 text-sm font-semibold">Channel activity</h3>
          <span className="text-[11px] text-muted">
            {row.relationships.length} total
          </span>
        </div>
        <ul className="m-0 max-h-72 divide-y divide-line overflow-auto p-0">
          {row.relationships.map(({ channel, edge }) => (
            <li
              key={channel.id}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-3"
            >
              <span className="min-w-0">
                <strong className="block truncate text-sm">
                  #{channel.name}
                </strong>
                <span className="mt-0.5 block text-[11px] capitalize text-muted">
                  {channel.kind ?? "channel"} ·{" "}
                  {membershipLabel(edge.membership)}
                </span>
              </span>
              <span className="text-right text-[11px] text-muted">
                {edge.observedMessageCount > 0 ? (
                  <>
                    <span className="inline-flex items-center gap-1 text-ink">
                      <History size={11} aria-hidden="true" />
                      {edge.observedMessageCount} sampled
                    </span>
                    <span className="mt-0.5 block">
                      {edge.lastObservedAt
                        ? formatRelativeTime(edge.lastObservedAt)
                        : ""}
                    </span>
                  </>
                ) : (
                  "No sampled messages"
                )}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Metric({ value, label }: { value: string | number; label: string }) {
  return (
    <div>
      <dt className="text-[10px] text-muted">{label}</dt>
      <dd className="m-0 mt-0.5 text-base font-semibold">{value}</dd>
    </div>
  );
}

function AgentAvatar({
  row,
  session,
  className,
}: {
  row: AgentDashboardRow;
  session: RelaySession;
  className: string;
}) {
  const source = avatarSource(row.agent.avatar);
  const picture = source?.startsWith("data:")
    ? source
    : source
      ? session.media(source)
      : undefined;
  return <Avatar name={row.agent.name} src={picture} className={className} />;
}

function PageState({
  library,
  channels,
  activity,
  hasAgents,
  hasRelationships,
  retry,
}: {
  library: AgentLibrary & { status: string; error?: string };
  channels: ReturnType<typeof useChannelList>;
  activity: ActivityState;
  hasAgents: boolean;
  hasRelationships: boolean;
  retry: () => void;
}) {
  if (library.status === "unavailable")
    return (
      <EmptyState text="Your current Buzz agent library is available through the local live development host." />
    );
  const error = library.error ?? channels.error ?? activity.error;
  if (error && !hasRelationships)
    return (
      <div role="alert" className="notice">
        <p className="m-0">Couldn’t update the agent dashboard. {error}</p>
        <button type="button" className="mt-3" onClick={retry}>
          Retry
        </button>
      </div>
    );
  if (library.status === "ready" && !hasAgents)
    return (
      <EmptyState text="No active identities are linked to your Buzz agents." />
    );
  if (
    !hasRelationships &&
    library.status === "ready" &&
    channels.status === "ready"
  )
    return (
      <EmptyState
        text={
          activity.status === "loading"
            ? "Mapping recent agent activity…"
            : "No current memberships or verified agent activity found in this community."
        }
      />
    );
  return null;
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="py-16 text-center">
      <UsersRound
        className="mx-auto mb-3 text-muted"
        size={22}
        aria-hidden="true"
      />
      <p role="status" className="mx-auto max-w-lg text-sm text-muted">
        {text}
      </p>
    </div>
  );
}

function Footnote({ children }: { children: React.ReactNode }) {
  return <p className="mt-5 text-xs text-muted">{children}</p>;
}

function radialPositions(
  count: number,
  radius: number,
  centerX: number,
  centerY: number,
  start: number,
) {
  if (!count) return [];
  return Array.from({ length: count }, (_, index) => {
    const angle = start + (index / count) * Math.PI * 2;
    return {
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius,
    };
  });
}

function nodeStyle(position: { x: number; y: number }): CSSProperties {
  return {
    left: `${(position.x / VIEW_WIDTH) * 100}%`,
    top: `${(position.y / VIEW_HEIGHT) * 100}%`,
  };
}

function membershipLabel(membership: "current" | "past" | "unknown") {
  if (membership === "current") return "member now";
  if (membership === "past") return "past activity";
  return "membership unknown";
}

function formatRelativeTime(timestamp: number) {
  const elapsedDays = Math.max(
    0,
    Math.floor((Date.now() - timestamp * 1000) / 86_400_000),
  );
  if (elapsedDays === 0) return "today";
  if (elapsedDays === 1) return "1d ago";
  if (elapsedDays < 30) return `${elapsedDays}d ago`;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year:
      new Date(timestamp * 1000).getFullYear() === new Date().getFullYear()
        ? undefined
        : "numeric",
  }).format(new Date(timestamp * 1000));
}
