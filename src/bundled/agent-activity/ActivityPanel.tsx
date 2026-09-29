import { requestWork } from "./request-work";
import { RequestWorkDetails } from "./RequestWorkDetails";
import { useLoadedThread } from "../../features/messages/thread-views";
import { threadActivity } from "./thread-activity";
import { SavedActivity } from "./SavedActivity";
import {
  chooseProfileActivityChannel,
  profileActivityChannels,
  resolveProfileActivityChannel,
} from "./profile-activity-channels";
import styles from "./ActivityPanel.module.css";
import { Button } from "../../shared/design-system/ui/Button";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { publicKeyLabels } from "../../shared/identity/public-key";
import { useIdentityNames } from "../../features/identity-names/react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  activitySelection,
  type ActivitySelection,
} from "../../features/agents/activity-target";
import { activityRecords } from "../../features/agents/activity-records";
import { Accordion } from "../../shared/design-system/ui/Accordion";
import { Select } from "../../shared/design-system/ui/Select";
import { selectProfiles } from "../../features/relay/profile-selection";
import { useRelayConnection } from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { ActivityStream } from "./ActivityStream";
import { activityTranscript } from "./transcript";
import { ActivityFeedStatus } from "./ActivityFeedStatus";
import { ResponseActivity } from "./ResponseActivity";
import { requestActivity } from "./request-activity";

export function ActivityPanel({
  relay,
  target = "",
}: {
  relay: RelayData;
  target?: string;
}) {
  const connection = useRelayConnection(relay);
  if (connection.status !== "ready")
    return (
      <p className="p-4 text-body">
        Connect to a community to view agent activity.
      </p>
    );
  return (
    <ActivityDetails
      key={`${connection.scope}:${connection.generation}:${target}`}
      session={connection.session}
      selection={activitySelection(target)}
    />
  );
}
export function ActivityDetails({
  session,
  selection,
}: {
  session: RelaySession;
  selection?: ActivitySelection | undefined;
}) {
  const embedded = selection?.view === "profile";
  const loadedThread = useLoadedThread(
    session,
    selection?.channelId ?? "",
    selection?.threadRootId ?? "",
  );
  const activity = session.agentActivity;
  const snapshot = useSyncExternalStore(
    activity.subscribe,
    activity.snapshot,
    activity.snapshot,
  );
  const choices = useSyncExternalStore(
    session.agentChoices.subscribe,
    session.agentChoices.snapshot,
  );
  const agents = useMemo(
    () => [
      ...new Set([
        ...snapshot.records.map((row) => row.agent),
        ...(session.activityHistory?.available && choices.status === "ready"
          ? choices.identities.map((row) => row.pubkey)
          : []),
      ]),
    ],
    [snapshot.records, choices, session.activityHistory?.available],
  );
  const [selected, select] = useState(selection?.agent ?? "");
  const [selectedChannel, selectChannel] = useState(selection?.channelId ?? "");
  const [profileChannel, selectProfileChannel] = useState("");
  const profileChannels = useMemo(
    () =>
      embedded
        ? profileActivityChannels(
            snapshot.records,
            snapshot.turns,
            selection.agent,
          )
        : undefined,
    [embedded, snapshot.records, snapshot.turns, selection?.agent],
  );
  const resolvedProfileChannel = profileChannels
    ? resolveProfileActivityChannel(
        profileChannels.channels,
        profileChannel,
        profileChannels.preferred,
      )
    : "";
  const channelId = embedded
    ? resolvedProfileChannel || selection.channelId || ""
    : selectedChannel;
  useEffect(() => {
    if (embedded) selectProfileChannel(resolvedProfileChannel);
  }, [embedded, resolvedProfileChannel]);
  const agentChoices = useMemo(
    () => [...new Set([...agents, ...(selected ? [selected] : [])])],
    [agents, selected],
  );
  const fallbackKeys = useMemo(
    () => publicKeyLabels(agentChoices),
    [agentChoices],
  );
  const resolveName = useIdentityNames(session.names);
  const profiles = useMemo(
    () => selectProfiles(session.profiles, agentChoices),
    [session.profiles, agentChoices],
  );
  // Reuse already loaded channel labels; opening activity does not scan a directory.
  const channels = useSyncExternalStore(
    session.channels.subscribeList,
    session.channels.list,
    session.channels.list,
  ).channels;
  const identities = useSyncExternalStore(
    profiles.subscribe,
    profiles.snapshot,
    profiles.snapshot,
  );
  const agent = embedded ? selection.agent : selected || agents[0] || "";
  const keyLabels = useMemo(
    () => publicKeyLabels(agentChoices),
    [agentChoices],
  );
  const identity = identities.get(agent);
  const name = resolveName(agent, identity?.name ?? "Unknown identity");

  const [expanded, expand] = useState<string[]>([]);
  const agentRecords = snapshot.records.filter((row) => row.agent === agent);
  const records = useMemo(
    () => activityRecords(snapshot.records, agent, channelId),
    [snapshot.records, agent, channelId],
  );
  const profileTranscript = useMemo(
    () => (embedded ? activityTranscript(records) : undefined),
    [embedded, records],
  );
  const channelChoices = [
    ...new Set([
      ...agentRecords.flatMap((row) => row.channelIds),
      ...(session.activityHistory?.available
        ? channels.map((channel) => channel.id)
        : []),
      ...(channelId ? [channelId] : []),
    ]),
  ];
  const region = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!embedded) region.current?.focus();
  }, [embedded]);
  // Keep expansion intent as bounded as the underlying RAM journal.
  useEffect(() => {
    const ids = new Set(records.map((row) => row.id));
    expand((previous) =>
      previous.every((id) => ids.has(id))
        ? previous
        : previous.filter((id) => ids.has(id)),
    );
  }, [records]);
  const turns = snapshot.turns.filter(
    (turn) =>
      turn.agent === agent && (!channelId || turn.channelId === channelId),
  );
  const feedStatus = (
    <ActivityFeedStatus
      status={snapshot.status}
      trimmed={snapshot.trimmed}
      retry={() => session.live.retry()}
    />
  );
  const rawItem = {
    value: "raw",
    title: "Raw events",
    content: (
      <Accordion
        variant="activity"
        value={expanded}
        onValueChange={expand}
        items={records.map((row) => ({
          value: row.id,
          title: `${row.kind} · ${new Date(row.receivedAt).toLocaleTimeString()}`,
          content: (
            <div className="min-w-0">
              <p className="break-all text-body-sm text-subtle">
                Event {row.envelopeId}
              </p>
              {/* biome-ignore lint/a11y/useSemanticElements: Keyboard access to bounded raw plaintext scrolling. */}
              <pre
                // biome-ignore lint/a11y/noNoninteractiveTabindex: Raw text scroll region needs keyboard scrolling.
                tabIndex={0}
                role="region"
                aria-label={`Raw event ${row.envelopeId}`}
                className="max-h-96 overflow-auto bg-inset p-3 text-mono"
              >
                <code>{row.plaintext}</code>
              </pre>
            </div>
          ),
        }))}
      />
    ),
  };
  const aboutItem = {
    value: "about",
    title: <span className="text-caption">About this feed</span>,
    content: (
      <div className="flex flex-col gap-3 text-body-sm text-subtle">
        <p>
          Best-effort activity, not a complete transcript. Publication must be
          enabled on the agent. Missing details can remain available in Raw
          events.
        </p>
        <p>
          Working evidence expires after 30 seconds without a fresh turn record.
          Ended does not mean succeeded.
        </p>
        <p>
          RAM only: up to 200 envelopes / 2 MiB and 512 turn states. Cleared on
          disable, cache/access reset, or session replacement.
        </p>
      </div>
    ),
  };
  const working = turns.filter((turn) => turn.state === "working").length;
  const unknown = turns.filter((turn) => turn.state === "unknown").length;
  const ended = turns.filter((turn) => turn.state === "ended").length;
  if (selection?.messageId && selection.channelId)
    return (
      <section
        ref={region}
        tabIndex={-1}
        data-buzz-ui=""
        aria-label="Agent activity"
        className="flex min-w-0 flex-col gap-4 p-6 text-body-sm text-standard"
      >
        <p className="text-label-sm">
          {resolveName(
            selection.agent,
            identities.get(selection.agent)?.name ?? "Agent",
          )}{" "}
          · Response activity
        </p>
        {feedStatus}
        {snapshot.status !== "unavailable" && (
          <ResponseActivity
            session={session}
            records={snapshot.records}
            agent={selection.agent}
            channelId={selection.channelId}
            messageId={selection.messageId}
            showDiagnostics
          />
        )}
      </section>
    );
  if (selection?.threadRootId && selection.requestId && selection.channelId) {
    const work = requestWork(
      snapshot,
      loadedThread?.root ? [loadedThread.root, ...loadedThread.replies] : [],
      selection.channelId,
      selection.threadRootId,
      session.viewer,
    ).find((work) => work.requestId === selection.requestId);
    const keys = work?.agents.map((agent) => agent.agent) ?? [];
    const suffix = publicKeyLabels(keys);
    const names = new Map(
      keys.map((key) => [
        key,
        `${resolveName(key, identities.get(key)?.name ?? "Agent")} · ${suffix.get(key) ?? ""}`,
      ]),
    );
    return (
      <section
        ref={region}
        tabIndex={-1}
        data-buzz-ui=""
        aria-label="Agent activity"
        className="flex min-w-0 flex-col gap-4 p-6 text-body-sm text-standard"
      >
        <p className="text-label-sm">Request activity</p>
        {feedStatus}
        {work ? (
          <RequestWorkDetails
            key={selection.requestId}
            work={work}
            session={session}
            names={names}
            initialAgent={selection.agent}
          />
        ) : (
          <p>
            Open the originating thread to inspect this request’s retained work.
          </p>
        )}
      </section>
    );
  }
  if (selection?.threadRootId && selection.channelId) {
    const entry = threadActivity(
      snapshot,
      selection.channelId,
      selection.threadRootId,
      loadedThread?.replies,
    ).find((entry) => entry.agent === selection.agent);
    return (
      <section
        ref={region}
        tabIndex={-1}
        data-buzz-ui=""
        aria-label="Agent activity"
        className="flex min-w-0 flex-col gap-4 p-6 text-body-sm text-standard"
      >
        <p className="text-label-sm">
          {resolveName(
            selection.agent,
            identities.get(selection.agent)?.name ?? "Agent",
          )}{" "}
          · Thread activity
        </p>
        {feedStatus}
        {!loadedThread && (
          <p className="text-body-sm text-subtle">
            Only root-linked activity is available while this thread is closed.
          </p>
        )}
        {!entry?.selected.records.length && (
          <p>No retained activity linked to this thread yet.</p>
        )}
        <ActivityStream
          session={session}
          records={entry?.selected.records ?? []}
          turns={entry?.turns ?? []}
          showDiagnostics
        />
        <Accordion
          variant="activity"
          items={[
            {
              value: "identity",
              title: "Exact identity",
              content: (
                <code className="break-all text-mono">{selection.agent}</code>
              ),
            },
          ]}
        />
      </section>
    );
  }
  if (selection?.requestId && selection.channelId) {
    const linked = requestActivity(
      snapshot.records,
      selection.agent,
      selection.channelId,
      selection.requestId,
    );
    return (
      <section
        ref={region}
        tabIndex={-1}
        data-buzz-ui=""
        aria-label="Agent activity"
        className="flex min-w-0 flex-col gap-4 p-6 text-body-sm text-standard"
      >
        <p className="text-label-sm">
          {resolveName(
            selection.agent,
            identities.get(selection.agent)?.name ?? "Agent",
          )}{" "}
          · Request activity
        </p>
        {feedStatus}
        {snapshot.status === "listening" && !linked.records.length && (
          <p>No activity received for this request yet.</p>
        )}
        <ActivityStream
          session={session}
          records={linked.records}
          turns={turns.filter((turn) => linked.turnIds.has(turn.turnId))}
          compact
          showDiagnostics
        />
      </section>
    );
  }
  if (embedded) {
    const channelName = (id: string) =>
      channels.find((channel) => channel.id === id)?.name || "Unknown channel";
    const channelLabel = (id: string) => {
      const name = channelName(id);
      return name === "Unknown channel" ||
        profileChannels?.channels.some(
          (other) => other !== id && channelName(other) === name,
        )
        ? `${name} · ${id}`
        : name;
    };
    const stopped = snapshot.status !== "listening";
    const status =
      snapshot.status === "unavailable"
        ? "Activity isn't available on this connection."
        : snapshot.status === "interrupted"
          ? "Activity feed interrupted."
          : snapshot.status === "disabled"
            ? "Activity is turned off."
            : snapshot.status === "connecting"
              ? "Connecting to activity…"
              : working
                ? `Working now${working > 1 ? ` · ${working} turns` : ""}`
                : unknown
                  ? "Status unknown"
                  : "";
    return (
      <div
        data-buzz-ui=""
        className="flex min-w-0 flex-col gap-4 text-body-sm text-standard"
      >
        <div className={styles.scope}>
          <div
            className="text-body-sm text-subtle"
            role="note"
            aria-label="Activity channel"
          >
            {channelId ? `#${channelLabel(channelId)}` : "All channels"}
          </div>
          {profileChannels && profileChannels.channels.length > 1 && (
            <fieldset
              aria-label="Choose activity channel"
              className={styles.channels}
            >
              {profileChannels.channels.map((id) => (
                <Button
                  key={id}
                  variant="ghost"
                  size="sm"
                  aria-label={`Show #${channelLabel(id)} activity`}
                  aria-pressed={id === channelId}
                  onClick={() => {
                    selectProfileChannel(
                      chooseProfileActivityChannel(
                        profileChannels.channels,
                        channelId,
                        id,
                      ),
                    );
                    expand([]);
                  }}
                >
                  <span
                    aria-hidden="true"
                    className={styles.dot}
                    data-selected={id === channelId || undefined}
                  />
                </Button>
              ))}
            </fieldset>
          )}
        </div>
        {(status || snapshot.trimmed > 0) && (
          <div className="flex flex-col gap-2" role="status">
            {status && (
              <p>
                {status}
                {working > 0 && unknown > 0
                  ? ` · ${unknown} ${unknown === 1 ? "turn needs" : "turns need"} an update`
                  : ""}
              </p>
            )}
            {snapshot.trimmed > 0 && (
              <p className="text-caption text-subtle">
                Some earlier activity is no longer retained in this feed.
              </p>
            )}
          </div>
        )}
        {snapshot.status === "interrupted" && (
          <div>
            <Button size="sm" onClick={() => session.live.retry()}>
              Retry live feed
            </Button>
          </div>
        )}
        {!stopped && !records.length && !turns.length && (
          <div className="flex flex-col gap-2">
            <p className="text-label-sm">No activity captured yet</p>
            <p className="text-body-sm text-subtle">
              New activity will appear here.
              {session.activityHistory?.available
                ? " Open Saved Activity for retained history."
                : " Live activity isn't saved yet."}
            </p>
          </div>
        )}
        {!stopped && !records.length && ended > 0 && !working && !unknown && (
          <p className="text-body-sm text-subtle">
            Earlier work ended. Its activity details are no longer retained.
          </p>
        )}
        {!!records.length && (
          <>
            <p className="text-caption text-subtle">
              Live activity
              {session.activityHistory?.available
                ? " · Saved capture when admitted"
                : " · Not saved yet"}
            </p>
            <ActivityStream
              session={session}
              key={`${agent}:${channelId}`}
              records={records}
              {...(profileTranscript ? { transcript: profileTranscript } : {})}
              turns={turns}
              expandHumanRequests
              showTurnHeading={(profileTranscript?.groups.length ?? 0) > 1}
              showDiagnostics
            />
          </>
        )}
        <SavedActivity
          key={`saved:${agent}:${channelId}`}
          expandHumanRequests
          session={session}
          agent={agent}
          channelId={channelId}
        />
        <Accordion
          variant="activity"
          items={[
            {
              value: "details",
              title: "Details",
              content: (
                <div className="flex min-w-0 flex-col gap-4">
                  <div className="flex flex-col gap-2">
                    <p className="text-label-sm">Channel scope</p>
                    <p className="text-body-sm">
                      {channelId
                        ? "This channel, including threads."
                        : "All channels, including activity without a channel."}
                    </p>
                    {channelId && (
                      <code className="break-all text-mono">{channelId}</code>
                    )}
                  </div>
                  <div className="flex flex-col gap-2">
                    <p className="text-label-sm">Full public key</p>
                    <code className="break-all text-mono">{agent}</code>
                  </div>
                  {turns.length > 0 && (
                    <p className="text-caption text-subtle">
                      {[
                        working ? `${working} working` : "",
                        unknown ? `${unknown} with unknown status` : "",
                        ended ? `${ended} ended` : "",
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                      {ended > 0 ? ". Ended does not mean succeeded." : "."}
                    </p>
                  )}
                  <Accordion variant="activity" items={[rawItem]} />
                </div>
              ),
            },
          ]}
        />
      </div>
    );
  }
  return (
    <section
      ref={region}
      tabIndex={-1}
      data-buzz-ui=""
      aria-label="Agent activity"
      className="flex min-w-0 flex-col gap-4 p-6 text-body text-standard"
    >
      <header className="flex min-w-0 items-center gap-3">
        {agent && (
          <Avatar
            src={
              identity?.picture
                ? session.media(identity.picture, "small")
                : undefined
            }
            alt=""
            fallback={name}
            size="large"
            shape={
              identity?.isAgent || agents.includes(agent)
                ? "squircle"
                : "circle"
            }
          />
        )}
        <div className="min-w-0">
          <h2 className="break-words text-label-sm">
            {agent ? name : "Agent activity"}
          </h2>
          <p className="text-caption text-subtle">
            {session.activityHistory?.available
              ? "Live activity and retained history"
              : "Live activity, not saved history"}
          </p>
        </div>
      </header>
      {feedStatus}
      {agent && (
        <SavedActivity
          key={`saved:${agent}:${channelId}`}
          session={session}
          agent={agent}
          channelId={channelId}
        />
      )}
      {snapshot.status !== "unavailable" && (
        <>
          {!agents.length && !selected ? (
            snapshot.status === "listening" && (
              <p>
                Waiting for live records. Select an agent after its first frame
                arrives; there is no history backfill.
              </p>
            )
          ) : (
            <>
              <div className="grid min-w-0 gap-1">
                <Select
                  label="Agent"
                  value={agent}
                  groups={[
                    {
                      label: "Activity identities",
                      options: agentChoices.map((key) => ({
                        value: key,
                        label: `${resolveName(key, identities.get(key)?.name ?? `Agent · ${fallbackKeys.get(key) ?? ""}`, agentChoices)} · ${keyLabels.get(key) ?? ""}`,
                      })),
                    },
                  ]}
                  onValueChange={(key) => {
                    select(key);
                    expand([]);
                  }}
                />
                <Select
                  label="Channel"
                  value={channelId}
                  groups={[
                    {
                      label: "Activity scope",
                      options: [
                        {
                          value: "",
                          label: "All channels (including unscoped records)",
                        },
                        ...channelChoices.map((id) => ({
                          value: id,
                          label: `${channels.find((channel) => channel.id === id)?.name ?? "Channel"} · ${id}`,
                        })),
                      ],
                    },
                  ]}
                  onValueChange={(id) => {
                    selectChannel(id);
                    expand([]);
                  }}
                />
              </div>
              {channelId && (
                <p className="text-caption text-subtle">
                  Channel activity, including threads
                </p>
              )}
              {(working > 0 || unknown > 0 || !records.length) && (
                <p className="text-caption text-subtle" role="status">
                  {working
                    ? `${working} working ${working === 1 ? "turn" : "turns"}.`
                    : "No fresh working evidence."}{" "}
                  {unknown
                    ? `Status unknown for ${unknown} ${unknown === 1 ? "turn" : "turns"}.`
                    : ""}
                </p>
              )}
              {snapshot.status === "listening" && !records.length && (
                <p>
                  Waiting for live records for this identity
                  {channelId ? " in this channel" : ""}. Only owner-visible
                  agent telemetry appears; there is no history backfill.
                </p>
              )}
              <ActivityStream
                session={session}
                key={`${agent}:${channelId}`}
                records={records}
                turns={turns}
                compact={working > 0}
                showDiagnostics
              />
              <Accordion
                variant="activity"
                items={[
                  {
                    value: "identity",
                    title: <span className="text-caption">Exact identity</span>,
                    content: (
                      <code className="break-all text-mono">{agent}</code>
                    ),
                  },
                ]}
              />
              <Accordion variant="activity" items={[rawItem]} />
            </>
          )}
          <Accordion variant="activity" items={[aboutItem]} />
        </>
      )}
    </section>
  );
}
