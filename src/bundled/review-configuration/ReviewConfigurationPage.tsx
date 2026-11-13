import { useReviewChannel } from "./submission-updates";
import { Checkbox } from "../../shared/design-system/ui/Checkbox";
import { createAdmissionReader, type ReadAdmission } from "./admission";
import { AdmissionEditor } from "./AdmissionEditor";
import type { ToolDescription } from "../../buzz-mcp/session-tools";
import {
  createPullReader,
  createPullStatusReader,
  type ReadPull,
  type ReadPullStatus,
} from "./pull-facts";
const publicPullReader = createPullReader();
const publicStatusReader = createPullStatusReader();
const publicAdmissionReader = createAdmissionReader();
import { LaneRules, ruleDescription } from "./LaneRules";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAgentChoices } from "../../features/agents/use-choices";
import type { PageNavigation } from "../../features/navigation/service";
import { messageRoute, ReviewMessageDialog } from "./ReviewMessageDialog";
import { ReviewSubmissions } from "./ReviewSubmissions";
import type { Navigation } from "../../features/navigation/controller";
import { splitPartition } from "../../features/relay/partition";
import { LaneReviewers, ReviewerIdentity } from "./LaneReviewers";
import { useChannelList, useRelayConnection } from "../../features/relay/react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import {
  ArrowLeftIcon,
  ListChecksIcon,
  GitPullRequestIcon,
} from "../../shared/design-system/icons";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { FullPageSurface } from "../../shared/design-system/ui/FullPageSurface";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { Input } from "../../shared/design-system/ui/Input";
import {
  PanelHeader,
  PanelHeaderLabel,
} from "../../shared/design-system/ui/PanelHeader";
import { Select } from "../../shared/design-system/ui/Select";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import {
  loadConfigurations,
  repositoryName,
  saveConfiguration,
  type ReviewConfig,
  type ReviewLane,
  type SavedReviewConfig,
} from "./configuration";
import "./review-configuration.css";

export type ReviewPage = "configuration" | "submit" | "all";
export const reviewPageTitle = (page: ReviewPage) =>
  page === "submit"
    ? "Submit PR"
    : page === "all"
      ? "Pull requests"
      : "Review Configuration";

function Frame({
  children,
  page = "configuration",
}: {
  children: ReactNode;
  page?: ReviewPage;
}) {
  const title = reviewPageTitle(page);
  return (
    <FullPageSurface aria-label={title}>
      <div className="review-config-page text-body">
        <PanelHeader
          title={
            <PanelHeaderLabel
              title={title}
              icon={
                page === "all" ? <GitPullRequestIcon /> : <ListChecksIcon />
              }
            />
          }
        />
        <div className="review-config-scroll">
          <div className="review-config-content" data-review-page={page}>
            {children}
          </div>
        </div>
      </div>
    </FullPageSurface>
  );
}

export function ReviewConfigurationPage({
  relay,
  navigator,
  navigation,
  readPull = publicPullReader,
  readStatus = publicStatusReader,
  readAdmission = publicAdmissionReader,
  describeTool,
  page = "configuration",
}: {
  page?: ReviewPage;
  relay: RelayData;
  navigator?: Navigation;
  navigation?: PageNavigation | undefined;
  readPull?: ReadPull;
  readStatus?: ReadPullStatus;
  readAdmission?: ReadAdmission;
  describeTool?: ((name: string) => ToolDescription | undefined) | undefined;
}) {
  const connection = useRelayConnection(relay);
  const messageTrigger = useRef<HTMLElement | null>(null);
  const target = navigation?.target;
  const preview =
    target?.kind === "page" ? messageRoute(target.route?.params) : undefined;
  const scope = splitPartition(connection.scope ?? "");
  const base = {
    version: 1 as const,
    kind: "page" as const,
    pluginId: "buzz.review-configuration",
    pageId: page,
    ...(scope ? { scope } : {}),
  };
  const closeMessage = () =>
    navigator?.dismiss((visit) => {
      if (
        visit.kind !== "page" ||
        visit.pluginId !== base.pluginId ||
        visit.pageId !== page ||
        visit.scope?.viewer !== scope?.viewer ||
        visit.scope?.communityOrigin !== scope?.communityOrigin
      )
        return false;
      const route = messageRoute(visit.route?.params);
      return (
        !!route &&
        route.channel === preview?.channel &&
        route.message === preview?.message
      );
    }, base);
  if (connection.status === "ready")
    return (
      <>
        <ReviewConfigurationCommunity
          key={`${connection.scope}:${connection.generation}`}
          session={connection.session}
          messageChannel={preview?.channel}
          onOpenMessage={
            navigator
              ? async (channel, message, trigger) => {
                  messageTrigger.current = trigger;
                  const result = await navigator.open(
                    {
                      ...base,
                      route: { version: 1, params: { channel, message } },
                    },
                    { focus: "preserve" },
                  );
                  if (result.status === "failed")
                    throw new Error("Could not open the message.");
                }
              : undefined
          }
          page={page}
          readPull={readPull}
          readStatus={readStatus}
          readAdmission={readAdmission}
          describeTool={describeTool}
          onNavigate={
            navigator
              ? async (page) => {
                  const result = await navigator.open({
                    version: 1,
                    kind: "page",
                    pluginId: "buzz.review-configuration",
                    pageId: page,
                  });
                  if (result.status === "failed")
                    throw new Error("Could not open review page.");
                }
              : undefined
          }
          onOpenThread={async (channelId, id) => {
            const scope = splitPartition(connection.scope ?? "");
            if (!navigator || !scope)
              throw new Error("Thread navigation is unavailable.");
            const result = await navigator.open({
              version: 1,
              kind: "conversation",
              scope,
              channelId,
              messageId: id,
              threadRootId: id,
            });
            if (result.status === "failed")
              throw new Error("Could not open the review thread.");
          }}
        />
        {preview && navigator && (
          <ReviewMessageDialog
            key={`${preview.channel}:${preview.message}`}
            session={connection.session}
            target={preview}
            onClose={closeMessage}
            finalFocus={() =>
              messageTrigger.current?.isConnected
                ? messageTrigger.current
                : null
            }
          />
        )}
      </>
    );
  return (
    <Frame page={page}>
      <p>
        {connection.status === "connecting"
          ? "Connecting to your community…"
          : page !== "configuration"
            ? "Connect to a community to submit PRs."
            : "Connect to a community to configure reviews."}
      </p>
      {connection.status === "error" && (
        <>
          <p role="alert">{connection.error}</p>
          <Button onClick={() => relay.retry()}>Retry connection</Button>
        </>
      )}
    </Frame>
  );
}

export function ReviewConfigurationCommunity({
  session,
  messageChannel,
  onOpenMessage,
  onOpenThread,
  onNavigate,
  readPull = publicPullReader,
  readStatus = publicStatusReader,
  readAdmission = publicAdmissionReader,
  describeTool,
  page = "configuration",
}: {
  session: RelaySession;
  messageChannel?: string | undefined;
  onOpenMessage?:
    | ((channel: string, id: string, trigger: HTMLElement) => Promise<void>)
    | undefined;
  page?: ReviewPage;
  readPull?: ReadPull;
  readStatus?: ReadPullStatus;
  readAdmission?: ReadAdmission;
  describeTool?: ((name: string) => ToolDescription | undefined) | undefined;
  onNavigate?: ((page: ReviewPage) => Promise<void>) | undefined;
  onOpenThread?: ((channel: string, id: string) => Promise<void>) | undefined;
}) {
  const list = useChannelList(session.channels);
  const [channel, setChannel] = useReviewChannel(session.scope);
  useEffect(() => {
    if (messageChannel) setChannel(messageChannel);
  }, [messageChannel, setChannel]);
  const [editing, setEditing] = useState(false);
  const [navigationError, setNavigationError] = useState("");
  async function navigate(destination: ReviewPage) {
    try {
      await onNavigate?.(destination);
    } catch (reason) {
      setNavigationError(
        reason instanceof Error
          ? reason.message
          : "Could not open review page.",
      );
    }
  }
  const channels = list.channels.filter(
    (item) =>
      !item.metadataPending &&
      !item.huddle &&
      !item.archived &&
      !item.pending &&
      (item.channelType === "stream" || item.channelType === "forum"),
  );
  useEffect(() => {
    if (list.status !== "ready" || list.coverage === "partial" || editing)
      return;
    if (list.channels.some((item) => item.metadataPending)) return;
    if (channel && channels.some((item) => item.id === channel)) return;
    setChannel(channels.length === 1 ? (channels[0]?.id ?? "") : "");
  }, [
    list.status,
    list.coverage,
    list.channels,
    channels,
    channel,
    editing,
    setChannel,
  ]);
  const selected = channels.find((item) => item.id === channel);
  const readable = !!selected && !selected.cached && !selected.metadataCached;
  const writable =
    !!selected &&
    !selected.metadataCached &&
    !selected.cached &&
    !selected.readOnly &&
    !!session.configArtifactWriter;
  const channelSelector = (
    <>
      {page !== "configuration" && channels.length === 1 ? (
        <p className="text-caption text-subtle">
          Review channel: {selected?.name}
        </p>
      ) : (
        <Select
          label="Review channel"
          variant="field"
          value={channel}
          onValueChange={setChannel}
          disabled={editing}
          placeholder="Choose a channel"
          groups={[
            {
              label: "Channels",
              options: channels.map((item) => ({
                value: item.id,
                label: item.name,
              })),
            },
          ]}
          description="Repositories and reviews are shared with this channel."
        />
      )}
      {list.status === "loading" && <p role="status">Loading channels…</p>}
      {list.status === "error" && (
        <p role="alert">Could not load channels. Reconnect to try again.</p>
      )}
      {channel && !writable && (
        <p role="alert">
          Saving is unavailable until channel access is confirmed. Your open
          draft is preserved.
        </p>
      )}
    </>
  );
  return (
    <Frame page={page}>
      {page !== "configuration" && (
        <div className="review-config-actions">
          <Button
            disabled={editing || !onNavigate}
            onClick={() => void navigate("configuration")}
          >
            <ArrowLeftIcon /> Back to Review Configuration
          </Button>
          {page === "all" && (
            <Button
              variant="prominent"
              disabled={editing || !onNavigate}
              onClick={() => void navigate("submit")}
            >
              Submit PR
            </Button>
          )}
        </div>
      )}
      {navigationError && <p role="alert">{navigationError}</p>}
      {(page !== "configuration" || !channel) && channelSelector}
      {channel &&
        (page !== "configuration" ? (
          <ReviewSubmissions
            key={`${channel}:${page}`}
            mode={page}
            readable={readable}
            session={session}
            channel={channel}
            writable={writable}
            onEditingChange={setEditing}
            onOpenThread={onOpenThread}
            onOpenMessage={onOpenMessage}
            readPull={readPull}
            readStatus={readStatus}
            readAdmission={readAdmission}
            describeTool={describeTool}
          />
        ) : (
          <ChannelConfiguration
            key={channel}
            session={session}
            channel={channel}
            writable={writable}
            onEditingChange={setEditing}
            channelSelector={channelSelector}
            onSubmit={onNavigate ? () => void navigate("submit") : undefined}
            onShowPulls={onNavigate ? () => void navigate("all") : undefined}
          />
        ))}
    </Frame>
  );
}

function ChannelConfiguration({
  session,
  channel,
  writable,
  onEditingChange,
  channelSelector,
  onSubmit,
  onShowPulls,
}: {
  channelSelector: ReactNode;
  onSubmit?: (() => void) | undefined;
  onShowPulls?: (() => void) | undefined;
  session: RelaySession;
  channel: string;
  writable: boolean;
  onEditingChange: (editing: boolean) => void;
}) {
  const choices = useAgentChoices(session, true, true);
  const [admissionEditing, setAdmissionEditing] = useState(false);
  const [laneId, setLaneId] = useState<string>();
  const [rows, setRows] = useState<SavedReviewConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [warning, setWarning] = useState("");
  const [remaining, setRemaining] = useState(0);
  const [reload, setReload] = useState(0);
  const [editor, setEditor] = useState<SavedReviewConfig | "new">();
  const [repository, setRepository] = useState("");
  const selected = rows.find((row) => row.config.repository === repository);
  const editorTrigger = useRef<HTMLElement | null>(null);
  const lanesRegion = useRef<HTMLElement | null>(null);
  useEffect(() => {
    onEditingChange(editor !== undefined || admissionEditing);
    return () => onEditingChange(false);
  }, [editor, admissionEditing, onEditingChange]);
  useEffect(() => {
    if (editor === undefined) {
      const trigger = editorTrigger.current;
      if (trigger?.isConnected && !trigger.matches(":disabled"))
        trigger.focus();
      else lanesRegion.current?.focus();
    }
  }, [editor]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Reload explicitly requests a fresh snapshot.
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    loadConfigurations(
      session,
      channel,
      AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
    )
      .then((next) => {
        if (!controller.signal.aborted) {
          setRows(next.rows);
          setRemaining(
            next.truncated ? 0 : 100 - next.rows.length - next.unreadable,
          );
          setWarning(
            [
              next.unreadable
                ? `${next.unreadable} saved configuration(s) could not be read. They may use a newer format or contain invalid data; other repositories remain editable.`
                : "",
              next.truncated
                ? "Showing the first 100 configurations. Use another review channel for additional repositories."
                : "",
            ]
              .filter(Boolean)
              .join(" "),
          );
        }
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted)
          setError(
            reason instanceof Error
              ? reason.message
              : "Could not load configurations.",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [session, channel, reload]);
  function saved(next: SavedReviewConfig) {
    if (editor === "new") setRemaining((value) => value - 1);
    setRows((current) =>
      [
        ...current.filter((row) => row.artifactId !== next.artifactId),
        next,
      ].sort((a, b) => a.config.repository.localeCompare(b.config.repository)),
    );
    setRepository(next.config.repository);
    setEditor(undefined);
    setNotice(`Saved ${next.config.repository}.`);
  }
  return (
    <>
      {!selected && editor !== "new" ? (
        <>
          <div className="review-config-actions">
            <Button
              ref={editorTrigger}
              disabled={loading || !!error || !writable || remaining <= 0}
              onClick={(event) => {
                editorTrigger.current = event.currentTarget;
                setNotice("");
                setEditor("new");
              }}
            >
              Register repository
            </Button>
            <Button disabled={!onSubmit} onClick={onSubmit}>
              Submit PR
            </Button>
            <Button disabled={!onShowPulls} onClick={onShowPulls}>
              Pull requests
            </Button>
          </div>
          {channelSelector}
          <InlineHeader
            title="Repositories"
            actions={
              <Button
                disabled={loading || admissionEditing}
                onClick={() => setReload((value) => value + 1)}
              >
                Reload
              </Button>
            }
          />
          {loading ? (
            <p role="status">Loading configurations…</p>
          ) : error ? (
            <p role="alert">{error} Use Reload to try again.</p>
          ) : rows.length ? (
            <div className="review-config-repositories">
              {rows.map((row) => (
                <NavigationItem
                  key={row.artifactId}
                  aria-label={`Open ${row.config.repository}`}
                  multiline
                  label={
                    <span className="review-config-repository-label">
                      <span>{row.config.repository}</span>
                      <span className="text-caption text-subtle">
                        {row.config.lanes.map((lane) => lane.name).join(" · ")}
                      </span>
                    </span>
                  }
                  trailing="Open"
                  onClick={() => {
                    setRepository(row.config.repository);
                    setNotice("");
                  }}
                />
              ))}
            </div>
          ) : (
            <p>
              {warning
                ? "No readable configurations in this channel."
                : "No repositories configured in this channel. Register one to save its review lanes."}
            </p>
          )}
          {warning && <p role="alert">{warning}</p>}
        </>
      ) : (
        <>
          {channelSelector}
          {!editor && (
            <div>
              <Button
                disabled={admissionEditing}
                onClick={() => {
                  setRepository("");
                  setNotice("");
                }}
              >
                <ArrowLeftIcon /> Back to repositories
              </Button>
            </div>
          )}
          {selected && (
            <>
              <InlineHeader title={selected.config.repository} />
              <section
                className="review-config-form"
                aria-label="Repository configuration"
                ref={lanesRegion}
                tabIndex={-1}
              >
                {editor ? (
                  <ConfigurationEditor
                    key={editor === "new" ? "new" : editor.revision}
                    session={session}
                    channel={channel}
                    writable={writable}
                    previous={editor === "new" ? undefined : editor}
                    laneId={laneId}
                    existing={rows}
                    onCancel={() => setEditor(undefined)}
                    onSaved={saved}
                  />
                ) : (
                  <>
                    <AdmissionEditor
                      session={session}
                      channel={channel}
                      previous={selected}
                      writable={writable && !loading && !error}
                      onSaved={saved}
                      onEditingChange={setAdmissionEditing}
                    />
                    <InlineHeader
                      title="Lanes"
                      subtitle="Each lane has its own agents, instructions, and routing rules."
                      actions={
                        <Button
                          disabled={loading || admissionEditing}
                          onClick={() => {
                            setNotice("");
                            setReload((value) => value + 1);
                          }}
                        >
                          Reload
                        </Button>
                      }
                    />
                    {error && <p role="alert">{error}</p>}
                    <SettingsGroup layout="cards">
                      {selected.config.lanes.map((lane) => (
                        <section
                          key={lane.id}
                          aria-label={`${lane.name} lane`}
                          className="review-config-lane-card"
                        >
                          <InlineHeader
                            title={lane.name}
                            actions={
                              <Button
                                ref={(node) => {
                                  if (laneId === lane.id)
                                    editorTrigger.current = node;
                                }}
                                disabled={
                                  !writable ||
                                  loading ||
                                  !!error ||
                                  admissionEditing
                                }
                                aria-label={`Edit ${lane.name} lane`}
                                onClick={() => {
                                  setLaneId(lane.id);
                                  setNotice("");
                                  setEditor(selected);
                                }}
                              >
                                Edit lane
                              </Button>
                            }
                          />
                          <div className="review-config-reviewers">
                            <span className="text-caption text-subtle">
                              Agents
                            </span>
                            {lane.reviewers.length ? (
                              lane.reviewers.map((pubkey) => (
                                <ReviewerIdentity
                                  key={pubkey}
                                  pubkey={pubkey}
                                  choices={choices}
                                />
                              ))
                            ) : (
                              <p>No agents assigned.</p>
                            )}
                          </div>
                          <div className="review-config-summary-section">
                            <span className="text-caption text-subtle">
                              Routing rules ·{" "}
                              {lane.routing?.mode === "any"
                                ? "Match any"
                                : "Match all"}
                            </span>
                            {lane.routing?.rules.length ? (
                              <ul>
                                {lane.routing.rules.map((rule) => (
                                  <li key={rule.id}>{ruleDescription(rule)}</li>
                                ))}
                              </ul>
                            ) : (
                              <p>
                                All PRs · Add a routing rule when editing this
                                lane.
                              </p>
                            )}
                          </div>
                          <div className="review-config-summary-section">
                            <span className="text-caption text-subtle">
                              Instructions
                            </span>
                            <p className="review-config-instructions">
                              {lane.instructions}
                            </p>
                            <p>
                              Automatic approval:{" "}
                              {lane.autoApprove ? "Allowed" : "Not allowed"}
                            </p>
                          </div>
                        </section>
                      ))}
                    </SettingsGroup>
                    <div>
                      <Button
                        ref={(node) => {
                          if (!laneId) editorTrigger.current = node;
                        }}
                        variant="prominent"
                        disabled={
                          !writable ||
                          loading ||
                          !!error ||
                          admissionEditing ||
                          selected.config.lanes.length >= 12
                        }
                        onClick={() => {
                          setLaneId(undefined);
                          setNotice("");
                          setEditor(selected);
                        }}
                      >
                        Add lane
                      </Button>
                    </div>
                  </>
                )}
              </section>
            </>
          )}
          {editor === "new" && (
            <ConfigurationEditor
              session={session}
              channel={channel}
              writable={writable}
              previous={undefined}
              existing={rows}
              onCancel={() => setEditor(undefined)}
              onSaved={saved}
            />
          )}
        </>
      )}
      {notice && <p role="status">{notice}</p>}
    </>
  );
}

function ConfigurationEditor({
  session,
  channel,
  writable,
  previous,
  laneId,
  existing,
  onCancel,
  onSaved,
}: {
  session: RelaySession;
  channel: string;
  writable: boolean;
  previous: SavedReviewConfig | undefined;
  laneId?: string | undefined;
  existing: readonly SavedReviewConfig[];
  onCancel: () => void;
  onSaved: (saved: SavedReviewConfig) => void;
}) {
  const choices = useAgentChoices(session, true, true);
  const [refreshingAgents, setRefreshingAgents] = useState(false);
  const [agentRefreshError, setAgentRefreshError] = useState("");
  const original = previous?.config.lanes.find((lane) => lane.id === laneId);
  const [repository, setRepository] = useState(
    previous?.config.repository ?? "",
  );
  const [lane, setLane] = useState<ReviewLane>(() => ({
    ...(original ?? {
      id: crypto.randomUUID(),
      name: previous ? "" : "General",
      instructions: "",
      reviewers: [],
    }),
    routing: original?.routing?.rules.length
      ? original.routing
      : {
          mode: "all",
          rules: [
            {
              id: crypto.randomUUID(),
              field: "title",
              operator: "contains",
              value: "",
            },
          ],
        },
  }));
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState("");
  const editorRegion = useRef<HTMLFormElement>(null);
  useEffect(() => {
    editorRegion.current?.focus();
  }, []);
  const operation = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => operation.current?.abort(), []);
  async function save(remove = false) {
    if (operation.current || !writable) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setError("");
    try {
      if (
        !previous &&
        existing.some(
          (row) => row.config.repository === repositoryName(repository),
        )
      )
        throw new Error(
          "This repository is already configured in this channel. Cancel and edit its saved settings.",
        );
      if (!remove && !lane.routing?.rules.length)
        throw new Error(
          "Add at least one routing rule before saving this lane.",
        );
      const lanes = previous?.config.lanes ?? [];
      const draft: ReviewConfig = {
        version: 1,
        reminderMinutes: 15,
        ...(previous?.config.admission
          ? { admission: previous.config.admission }
          : {}),
        repository,
        lanes: remove
          ? lanes.filter((item) => item.id !== lane.id)
          : original
            ? lanes.map((item) => (item.id === lane.id ? lane : item))
            : [...lanes, lane],
      };
      const result = await saveConfiguration(
        session,
        channel,
        draft,
        previous,
        AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
      );
      if (!controller.signal.aborted) onSaved(result);
    } catch (reason) {
      if (!controller.signal.aborted)
        setError(
          `${reason instanceof Error ? reason.message : "Could not save lane."} Your draft is still here. If settings changed elsewhere or the save timed out, copy your changes, then Cancel and Reload before retrying.`,
        );
    } finally {
      operation.current = undefined;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <form
      ref={editorRegion}
      tabIndex={-1}
      aria-label="Edit lane"
      noValidate
      className="review-config-form"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div>
        <Button disabled={busy} onClick={onCancel}>
          <ArrowLeftIcon />{" "}
          {previous ? "Back to lanes" : "Back to repositories"}
        </Button>
      </div>
      <InlineHeader
        title={
          original
            ? `Edit ${original.name}`
            : previous
              ? "Add lane"
              : "Register repository"
        }
        subtitle="Save this lane before adding another."
      />
      {!previous && (
        <SettingsGroup layout="form">
          <Field
            label="GitHub repository"
            description="Use owner/repository or the full repository URL."
          >
            <Input
              required
              value={repository}
              disabled={busy}
              maxLength={250}
              placeholder="example-org/project"
              onValueChange={setRepository}
            />
          </Field>
        </SettingsGroup>
      )}
      <SettingsGroup layout="form">
        <Field label="Lane name">
          <Input
            required
            maxLength={80}
            disabled={busy}
            value={lane.name}
            onValueChange={(name) => setLane({ ...lane, name })}
          />
        </Field>
        <LaneReviewers
          lane={1}
          reviewers={lane.reviewers}
          choices={choices}
          disabled={busy}
          onChange={(reviewers) => setLane({ ...lane, reviewers })}
        />
        {choices.pending && <p role="status">Loading reviewer agents…</p>}
        {!choices.pending && !choices.selectable.length && (
          <p>
            No reviewer agents are available. Create or connect an agent, then
            refresh.
          </p>
        )}
        {choices.error && (
          <p role="alert">Some agents could not be loaded: {choices.error}</p>
        )}
        {choices.archives.error && (
          <p role="alert">
            Archived agents could not be checked: {choices.archives.error}
          </p>
        )}
        {agentRefreshError && <p role="alert">{agentRefreshError}</p>}
        <div>
          <Button
            disabled={busy || refreshingAgents}
            loading={refreshingAgents}
            onClick={async () => {
              setRefreshingAgents(true);
              setAgentRefreshError("");
              try {
                await session.agentChoices.refresh(true);
              } catch (reason) {
                setAgentRefreshError(
                  reason instanceof Error
                    ? reason.message
                    : "Could not refresh agents.",
                );
              } finally {
                setRefreshingAgents(false);
              }
            }}
          >
            Refresh agents
          </Button>
        </div>
        <Field
          label="Instructions"
          description="What should the agents review in this lane?"
        >
          <Textarea
            required
            rows={3}
            maxLength={8000}
            disabled={busy}
            value={lane.instructions}
            onChange={(event) =>
              setLane({ ...lane, instructions: event.target.value })
            }
          />
        </Field>
        <section className="review-config-form" aria-label="Lane routing rules">
          <Checkbox
            label="Allow automatic approval"
            checked={lane.autoApprove ?? false}
            disabled={busy}
            onCheckedChange={(checked) =>
              setLane({ ...lane, autoApprove: checked })
            }
          />
          <p className="text-caption text-subtle">
            Off by default. When off, reviewers must not approve on GitHub. When
            on, they may approve only after reviewing and finding no issues.
            Applies to new submissions.
          </p>
          <LaneRules
            lane={1}
            value={lane.routing}
            disabled={busy}
            onChange={(routing) => setLane({ ...lane, routing })}
          />
        </section>
      </SettingsGroup>
      {error && <p role="alert">{error}</p>}
      {removing ? (
        <div className="review-config-form">
          <p>
            Remove {original?.name} and its routing rules? Existing review
            threads are kept.
          </p>
          <div className="review-config-actions">
            <Button disabled={busy} onClick={() => setRemoving(false)}>
              Keep lane
            </Button>
            <Button
              disabled={busy || !writable}
              onClick={() => void save(true)}
            >
              Confirm remove lane
            </Button>
          </div>
        </div>
      ) : (
        <div className="review-config-actions">
          <Button disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="prominent"
            loading={busy}
            disabled={!writable}
          >
            Save lane
          </Button>
          {original && previous && previous.config.lanes.length > 1 && (
            <Button
              disabled={busy || !writable}
              onClick={() => setRemoving(true)}
            >
              Remove lane
            </Button>
          )}
        </div>
      )}
      <div>
        <Button disabled>Add lane</Button>
        <p className="text-caption text-subtle">
          Save or cancel this lane first.
        </p>
      </div>
    </form>
  );
}
