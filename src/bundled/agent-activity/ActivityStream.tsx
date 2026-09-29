import type { RelaySession } from "../../features/relay/session";
import { ActivityMessageEntry } from "./ActivityMessageEntry";
import { useEffect, useId, useMemo, useState } from "react";
import { Accordion } from "../../shared/design-system/ui/Accordion";
import { Button } from "../../shared/design-system/ui/Button";
import { Button as BaseButton } from "@base-ui/react/button";
import {
  FileTextIcon,
  TerminalWindowIcon,
  ChatCircleIcon,
  BrainIcon,
  PencilSimpleIcon,
  ImageIcon,
  WrenchIcon,
  CaretDownIcon,
} from "../../shared/design-system/icons";
import type { ActivityRecord } from "../../features/agents/activity-records";
import type { ActivityTurn } from "../../features/agents/activity";
import {
  activityTranscript,
  TRANSCRIPT_EVENT_LIMIT,
  type TranscriptEntry,
} from "./transcript";
import styles from "./ActivityStream.module.css";
import {
  activityAction,
  activityPresentation,
  groupActivity,
  toolGroupSummary,
} from "./activity-presentation";

export function ActivityStream({
  records,
  turns,
  compact = false,
  showTurnHeading = true,
  showDiagnostics,
  transcript,
  session,
  expandHumanRequests = false,
}: {
  records: readonly ActivityRecord[];
  session?: RelaySession | undefined;
  transcript?: ReturnType<typeof activityTranscript>;
  turns: readonly ActivityTurn[];
  /** Inline work keeps a small window; the user's expansion intent survives updates. */
  compact?: boolean;
  /** Inline previews already identify the agent and state; inspectors keep turn context. */
  showTurnHeading?: boolean;
  /** Diagnostic evidence is retained but shown only in an inspector, not inline. */
  showDiagnostics: boolean;
  expandHumanRequests?: boolean;
}) {
  const { groups, omitted, source } = useMemo(
    () => transcript ?? activityTranscript(records),
    [records, transcript],
  );
  const [expanded, expand] = useState<string[]>([]);
  const [showAll, setShowAll] = useState(false);
  const streamId = useId();
  const primary = groups
    .filter(
      (group) =>
        !group.entries.length ||
        group.entries.some((entry) => !entry.diagnostic),
    )
    .map((group) => {
      const entries = group.entries.filter((entry) => !entry.diagnostic);
      // The five-entry preview slides; a retained chain's identity does not.
      // Keep separate chains (and turns) separate, without another state store.
      const chainIds = new Map<string, string>();
      for (const chain of groupActivity(entries)) {
        const first = chain[0];
        if (first?.kind === "tool")
          for (const entry of chain) chainIds.set(entry.id, first.id);
      }
      return { ...group, entries, chainIds };
    });
  const diagnostics = groups.flatMap((group) =>
    group.entries.filter((entry) => entry.diagnostic),
  );
  const count = primary.reduce(
    (total, group) => total + group.entries.length,
    0,
  );
  let skip = compact && !showAll ? Math.max(0, count - 5) : 0;
  const shown = primary.flatMap((group) => {
    if (!skip) return [group];
    const dropped = Math.min(skip, group.entries.length);
    skip -= dropped;
    const entries = group.entries.slice(dropped);
    return entries.length ? [{ ...group, entries }] : [];
  });
  useEffect(() => {
    const ids = new Set(
      groups.flatMap((group) => group.entries.map((entry) => entry.id)),
    );
    expand((previous) =>
      previous.every((id) => ids.has(id))
        ? previous
        : previous.filter((id) => ids.has(id)),
    );
  }, [groups]);
  return (
    <section
      id={streamId}
      className={`${styles.stream} ${styles.motion}`}
      onPointerDownCapture={(event) => {
        event.currentTarget.dataset.motionInput = "pointer";
      }}
      onKeyDownCapture={(event) => {
        event.currentTarget.dataset.motionInput = "keyboard";
      }}
      data-buzz-ui=""
      aria-label="Readable activity"
    >
      {omitted > 0 && (
        <p className="text-caption text-subtle" role="status">
          Showing the latest {TRANSCRIPT_EVENT_LIMIT} activity events. The
          general Agent Activity inspector provides Raw events for retained
          envelopes.
        </p>
      )}
      {shown.map((group) => {
        const turn = turns.find(
          (turn) =>
            turn.agent === group.agent &&
            turn.turnId === group.turnId &&
            turn.channelId === group.channelId,
        );
        const state = turn?.state;
        return (
          <section
            key={group.id}
            className={styles.turn}
            aria-label={`${group.turnId ? "Turn" : "Unassigned activity"} ${group.turnId ?? group.id}`}
          >
            {showTurnHeading && (
              <div className={styles.heading}>
                <h3 className="text-label-sm">
                  {group.turnId ? "Turn" : "Unassigned activity"}
                </h3>
                <time
                  className="text-caption text-subtle"
                  dateTime={new Date(group.receivedAt).toISOString()}
                >
                  {new Date(group.receivedAt).toLocaleTimeString([], {
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </time>
                <span className="text-caption text-subtle">
                  {state === "working"
                    ? "Working"
                    : state === "ended"
                      ? "Ended"
                      : "Status unknown"}
                </span>
              </div>
            )}
            {!group.entries.length && (
              <p className="text-body-sm text-subtle">
                {state === "working"
                  ? "Waiting for activity details…"
                  : "No readable work steps retained in this view."}
              </p>
            )}
            {groupActivity(group.entries).map((entries) => {
              const first = entries[0];
              if (!first) return null;
              if (first.communication || first.kind === "message")
                return (
                  <ActivityMessageEntry
                    key={first.id}
                    entry={first}
                    agent={group.agent}
                    session={session}
                    expandHumanRequests={expandHumanRequests}
                    evidence={
                      <Accordion
                        variant="activity"
                        items={[
                          {
                            value: "evidence",
                            title: (
                              <span className="text-caption text-subtle">
                                Message details
                              </span>
                            ),
                            content: (
                              <div className={styles.messageEvidence}>
                                <p className="text-caption text-subtle">
                                  {first.communication?.direction === "incoming"
                                    ? "Reported author"
                                    : "Activity agent"}{" "}
                                  <code className="break-all">
                                    {first.communication?.author ?? group.agent}
                                  </code>
                                </p>
                                {first.communication?.eventId && (
                                  <p className="text-caption text-subtle">
                                    Reported message{" "}
                                    <code className="break-all">
                                      {first.communication.eventId}
                                    </code>
                                  </p>
                                )}
                                <EntryDetail
                                  entry={{ ...first, body: "" }}
                                  source={source}
                                />
                              </div>
                            ),
                          },
                        ]}
                      />
                    }
                  />
                );
              if (first.kind === "thought" && first.body)
                return (
                  <ProgressEntry
                    key={first.id}
                    entry={first}
                    source={source}
                    showDiagnostics={showDiagnostics}
                  />
                );
              if (entries.length > 1)
                return (
                  <ToolGroup
                    key={group.chainIds.get(first.id) ?? first.id}
                    entries={entries}
                    working={state === "working"}
                    source={source}
                  />
                );
              return (
                <Accordion
                  key={first.id}
                  variant="activity"
                  value={expanded}
                  onValueChange={(ids) =>
                    expand((previous) => [
                      ...previous.filter((id) => id !== first.id),
                      ...ids.filter((id) => id === first.id),
                    ])
                  }
                  items={[
                    {
                      value: first.id,
                      title: (
                        <EntryLabel
                          entry={first}
                          working={state === "working"}
                        />
                      ),
                      content: <EntryDetail entry={first} source={source} />,
                    },
                  ]}
                />
              );
            })}
          </section>
        );
      })}
      {!primary.length && records.length > 0 && (
        <p className="text-body-sm text-subtle">
          No work steps have been received yet.
        </p>
      )}
      {compact && count > 5 && (
        <div className="buzz-accordion" data-variant="activity">
          <BaseButton
            type="button"
            className="buzz-accordion-trigger text-body-sm"
            aria-expanded={showAll}
            aria-controls={streamId}
            onClick={() => setShowAll(!showAll)}
          >
            <span>
              {showAll
                ? "Show recent activity"
                : `Show all activity (${count})`}
            </span>
            <CaretDownIcon size={14} aria-hidden="true" />
          </BaseButton>
        </div>
      )}
      {showDiagnostics && diagnostics.length > 0 && (
        <Accordion
          variant="activity"
          items={[
            {
              value: "diagnostics",
              title: (
                <span className="text-caption text-subtle">
                  Setup and diagnostics ({diagnostics.length})
                </span>
              ),
              content: (
                <Accordion
                  variant="activity"
                  items={diagnostics.map((entry) => ({
                    value: entry.id,
                    title: entry.title,
                    content: <EntryDetail entry={entry} source={source} />,
                  }))}
                />
              ),
            },
          ]}
        />
      )}
    </section>
  );
}
function ToolGroup({
  entries,
  working,
  source,
}: {
  entries: TranscriptEntry[];
  working: boolean;
  source: ReturnType<typeof activityTranscript>["source"];
}) {
  const completed = entries.filter((entry) => entry.status === "completed");
  const current = entries.filter((entry) => entry.status !== "completed");
  if (
    completed.length &&
    current.some(
      (entry) => entry.status === "in_progress" || entry.status === "pending",
    )
  )
    return (
      <>
        <ToolGroup entries={completed} working={false} source={source} />
        {current.map((entry) => (
          <Accordion
            key={entry.id}
            variant="activity"
            items={[
              {
                value: entry.id,
                title: <EntryLabel entry={entry} working={working} />,
                content: <EntryDetail entry={entry} source={source} />,
              },
            ]}
          />
        ))}
      </>
    );
  return (
    <ToolGroupDetails entries={entries} working={working} source={source} />
  );
}
function ToolGroupDetails({
  entries,
  working,
  source,
}: {
  entries: TranscriptEntry[];
  working: boolean;
  source: ReturnType<typeof activityTranscript>["source"];
}) {
  const summary = toolGroupSummary(entries, working);
  const actions = new Set(entries.map(activityAction));
  const first = entries[0];
  const action = actions.size === 1 && first ? activityAction(first) : "tool";
  const [choice, setChoice] = useState<boolean>();
  const open = choice ?? (working || summary.active);
  return (
    <Accordion
      variant="activity"
      value={open ? ["group"] : []}
      onValueChange={(values) => setChoice(values.includes("group"))}
      items={[
        {
          value: "group",
          title: (
            <span className={`${styles.label} text-body-sm`}>
              <ActionIcon action={action} />
              <span className="text-label-sm text-standard">
                {entries.length === 1 ? "1 tool call" : summary.label}
              </span>
              <span className="text-caption text-subtle">
                {summary.status ? ` · ${summary.status}` : ""}
              </span>
            </span>
          ),
          content: (
            <div className={styles.toolGroup}>
              <Accordion
                variant="activity"
                items={entries.map((entry) => ({
                  value: entry.id,
                  title: <EntryLabel entry={entry} working={working} />,
                  content: <EntryDetail entry={entry} source={source} />,
                }))}
              />
            </div>
          ),
        },
      ]}
    />
  );
}
function ProgressEntry({
  entry,
  source,
  showDiagnostics,
}: {
  entry: TranscriptEntry;
  source: ReturnType<typeof activityTranscript>["source"];
  showDiagnostics: boolean;
}) {
  const [full, setFull] = useState(false);
  const text = entry.body;
  return (
    <div className={styles.progress}>
      <div className={styles.progressBody}>
        <p className={`${styles.prose} text-body-sm`}>
          {!full && text.length > 500 ? `${text.slice(0, 500)}…` : text}
        </p>
      </div>
      {text.length > 500 && (
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={full}
          onClick={() => setFull(!full)}
        >
          {full ? "Show less text" : "Show full text"}
        </Button>
      )}
      {showDiagnostics && (
        <Accordion
          variant="activity"
          items={[
            {
              value: "source",
              title: <span className="text-caption text-subtle">Details</span>,
              content: (
                <EntryDetail entry={{ ...entry, body: "" }} source={source} />
              ),
            },
          ]}
        />
      )}
    </div>
  );
}
function EntryDetail({
  entry,
  source,
}: {
  entry: TranscriptEntry;
  source: ReturnType<typeof activityTranscript>["source"];
}) {
  const { shellOutput, command } = activityPresentation(entry);
  const [rawOpen, setRawOpen] = useState<string[]>([]);
  const hasReadable = !!(entry.body || entry.input || entry.output);
  const raw = () =>
    entry.sourceIds.map((id) => {
      const record = source(id);
      return record ? (
        <div key={id}>
          <p className="text-caption text-subtle">Event {record.envelopeId}</p>
          <pre className="text-mono">
            <code>{record.plaintext}</code>
          </pre>
        </div>
      ) : null;
    });
  return (
    <div className={styles.detail}>
      {entry.body && (
        <p className={`${styles.prose} text-body-sm`}>{entry.body}</p>
      )}
      {entry.input && (
        <div>
          <p className="text-caption text-subtle">
            {command ? "Command" : "Input"}
          </p>
          <pre className="text-mono">
            <code>{command ?? entry.input}</code>
          </pre>
        </div>
      )}
      {shellOutput ? (
        <>
          {shellOutput.stdout && (
            <div>
              <p className="text-caption text-subtle">Output</p>
              <pre className="text-mono">
                <code>{shellOutput.stdout}</code>
              </pre>
            </div>
          )}
          {shellOutput.stderr && (
            <div>
              <p className="text-caption text-subtle">Standard error</p>
              <pre className="text-mono">
                <code>{shellOutput.stderr}</code>
              </pre>
            </div>
          )}
          {shellOutput.note && (
            <p className="text-caption text-subtle">{shellOutput.note}</p>
          )}
          {!shellOutput.stdout && !shellOutput.stderr && (
            <p className="text-body-sm text-subtle">No text output.</p>
          )}
        </>
      ) : (
        entry.output && (
          <div>
            <p className="text-caption text-subtle">Output</p>
            <pre className="text-mono">
              <code>{entry.output}</code>
            </pre>
          </div>
        )
      )}
      {hasReadable ? (
        <Accordion
          variant="activity"
          value={rawOpen}
          onValueChange={setRawOpen}
          items={[
            {
              value: "raw",
              title: <span className="text-caption">Raw source</span>,
              content: rawOpen.length ? raw() : null,
            },
          ]}
        />
      ) : (
        raw()
      )}
    </div>
  );
}
function EntryLabel({
  entry,
  working,
}: {
  entry: TranscriptEntry;
  working: boolean;
}) {
  const presentation = activityPresentation(entry);
  const status = presentation.shellOutput?.failed
    ? "Failed"
    : entry.status === "completed"
      ? ""
      : entry.status === "failed"
        ? "Failed"
        : entry.status
          ? working
            ? entry.status === "pending"
              ? "Pending"
              : "Running"
            : entry.status === "pending"
              ? "Last seen pending"
              : "Last seen running"
          : "";
  return (
    <span
      className={`${styles.label} ${styles.entryLabel} text-body-sm`}
      data-active={
        working && entry.status === "in_progress" ? "true" : undefined
      }
    >
      <ActionIcon action={activityAction(entry)} />
      <span className={styles.title}>
        <span className="text-label-sm text-standard">
          {presentation.title}
        </span>
        {presentation.target ? (
          <>
            {" "}
            <span className="text-body-sm text-subtle">
              {" "}
              · {presentation.target}
            </span>
          </>
        ) : null}
        {entry.body && !entry.diagnostic && entry.kind !== "event"
          ? ` · ${entry.body.replace(/\s+/g, " ").slice(0, 96)}${entry.body.length > 96 ? "…" : ""}`
          : ""}
        {status &&
          !(status === "Running" && /^running\b/i.test(presentation.title)) && (
            <span className={`${styles.entryStatus} text-caption text-subtle`}>
              {" "}
              {status}
            </span>
          )}
      </span>
    </span>
  );
}

const actionIcons = {
  thought: BrainIcon,
  command: TerminalWindowIcon,
  read: FileTextIcon,
  edit: PencilSimpleIcon,
  image: ImageIcon,
  message: ChatCircleIcon,
  tool: WrenchIcon,
  event: FileTextIcon,
};
function ActionIcon({ action }: { action: ReturnType<typeof activityAction> }) {
  const Icon = actionIcons[action];
  return (
    <Icon
      size={16}
      weight="regular"
      data-activity-action={action}
      aria-hidden="true"
    />
  );
}
