import { useSubmissionUpdates } from "./submission-updates";
import { ReviewStatusLabel, ReviewDate } from "./ReviewStatusLabel";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import { useLaneMessages } from "./use-lane-messages";
import { createAdmissionReader, type ReadAdmission } from "./admission";
import { triageError, subscribeTriageErrors } from "./triage-recovery";
import type { ToolDescription } from "../../buzz-mcp/session-tools";
import {
  overallReviewStatus,
  reviewLabels,
} from "../../features/agents/pr-review";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useAgentChoices } from "../../features/agents/use-choices";
import type { RelaySession } from "../../features/relay/session";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { TrashIcon } from "../../shared/design-system/icons";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import { Input } from "../../shared/design-system/ui/Input";
import { ReviewerIdentity } from "./LaneReviewers";
import { loadConfigurations } from "./configuration";
import {
  createPullReader,
  createPullStatusReader,
  type PullStatus,
  type ReadPullStatus,
  type ReadPull,
} from "./pull-facts";
import {
  deliveryThreads,
  deleteSubmission,
  remindSubmission,
  prUrl,
  threadUrl,
  pullRepository,
  pullRequest,
  submitReview,
  submissionLane,
  type SavedSubmission,
} from "./submissions";

const publicPullReader = createPullReader();
const publicStatusReader = createPullStatusReader();
const publicAdmissionReader = createAdmissionReader();
function TriageError({ scope, artifact }: { scope: string; artifact: string }) {
  const message = useSyncExternalStore(subscribeTriageErrors, () =>
    triageError(scope, artifact),
  );
  return message ? <p role="alert">{message}</p> : null;
}

export function ReviewSubmissions({
  session,
  mode = "submit",
  channel,
  writable,
  readable = true,
  onEditingChange,
  onOpenThread,
  onOpenMessage,
  readPull = publicPullReader,
  readStatus = publicStatusReader,
  readAdmission = publicAdmissionReader,
  describeTool,
}: {
  session: RelaySession;
  mode?: "submit" | "all";
  channel: string;
  writable: boolean;
  readable?: boolean;
  onEditingChange: (editing: boolean) => void;
  onOpenThread?: ((channel: string, id: string) => Promise<void>) | undefined;
  onOpenMessage?:
    | ((channel: string, id: string, trigger: HTMLElement) => Promise<void>)
    | undefined;
  readPull?: ReadPull;
  readStatus?: ReadPullStatus;
  readAdmission?: ReadAdmission;
  describeTool?: ((name: string) => ToolDescription | undefined) | undefined;
}) {
  const choices = useAgentChoices(session, true, true);
  const [pr, setPr] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [result, setResult] = useState<SavedSubmission>();
  const updates = useSubmissionUpdates(
    session,
    channel,
    readable && (mode === "all" || !!result),
  );
  const {
    rows,
    loading: listLoading,
    error: listError,
    warning,
    store,
  } = updates;
  const setRows = store.setRows;
  const [statuses, setStatuses] = useState<
    Record<string, { value: PullStatus | "Unavailable"; error?: string }>
  >({});
  const input = useRef<HTMLInputElement>(null);
  const listHeading = useRef<HTMLDivElement>(null);
  const deleteTrigger = useRef<HTMLButtonElement | null>(null);
  const [removing, setRemoving] = useState<SavedSubmission>();
  const [reminding, setReminding] = useState<{
    row: SavedSubmission;
    laneId?: string;
  }>();
  const [reminderMessage, setReminderMessage] = useState("");
  const reminderTrigger = useRef<HTMLElement | null>(null);
  function openReminder(
    row: SavedSubmission,
    laneId: string | undefined,
    trigger: HTMLElement,
  ) {
    reminderTrigger.current = trigger;
    setReminderMessage(row.value.reminderMessage ?? "");
    setReminding({ row, ...(laneId ? { laneId } : {}) });
  }
  const [deleteError, setDeleteError] = useState("");
  const [reload, setReload] = useState(0);
  const operation = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => operation.current?.abort(), []);
  useEffect(() => {
    onEditingChange(
      busy || !!removing || !!reminding || (!result && !!pr.trim()),
    );
    return () => onEditingChange(false);
  }, [busy, pr, result, removing, reminding, onEditingChange]);
  useEffect(() => {
    if (!reminding || busy || listLoading) return;
    const current = rows.find(
      (row) => row.artifactId === reminding.row.artifactId,
    );
    if (current && current.revision !== reminding.row.revision) {
      setReminding({ ...reminding, row: current });
      if (current.value.notifying)
        setReminderMessage(current.value.reminderMessage ?? "");
    }
  }, [rows, reminding, busy, listLoading]);
  const resultId = result?.artifactId;
  const rootsKey = [
    ...new Set(
      (mode === "all" ? rows : result ? [result] : [])
        .flatMap((row) => [
          row.value.triage?.thread.id,
          ...row.value.threads.map((thread) => thread.id),
        ])
        .filter((id): id is string => !!id),
    ),
  ]
    .sort()
    .join(":");
  const laneMessages = useLaneMessages(
    session,
    channel,
    readable ? rootsKey : "",
    reload,
  );
  useEffect(() => {
    if (!resultId) return;
    setResult(
      (current) =>
        rows.find((row) => row.artifactId === current?.artifactId) ?? current,
    );
  }, [rows, resultId]);
  useEffect(() => {
    if (reload) store.reload();
  }, [reload, store]);

  const statusRowsKey = rows.map((row) => row.revision).join(":");
  // biome-ignore lint/correctness/useExhaustiveDependencies: Report updates preserve PR/revision; only saved-row changes and explicit Reload require GitHub reads.
  useEffect(() => {
    if (mode !== "all") return;
    const controller = new AbortController();
    setStatuses({});
    let next = 0;
    async function worker() {
      while (!controller.signal.aborted) {
        const row = rows[next++];
        if (!row) return;
        try {
          const value = await readStatus(
            row.value.config.repository,
            row.value.pr,
            AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
          );
          if (!controller.signal.aborted)
            setStatuses((current) => ({
              ...current,
              [row.revision]: { value },
            }));
        } catch (reason) {
          if (!controller.signal.aborted)
            setStatuses((current) => ({
              ...current,
              [row.revision]: {
                value: "Unavailable",
                error:
                  reason instanceof Error
                    ? reason.message
                    : "Could not read PR status.",
              },
            }));
        }
      }
    }
    // Limit GitHub/desktop work when the bounded saved list contains many PRs.
    for (let index = 0; index < Math.min(rows.length, 4); index++)
      void worker();
    return () => controller.abort();
  }, [statusRowsKey, mode, readStatus, reload]);

  async function submit() {
    if (operation.current || !writable) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(120_000),
    ]);
    operation.current = controller;
    setBusy(true);
    setError("");
    setResult(undefined);
    setStatus("Finding repository and assigning reviewers…");
    let existing = false;
    let recorded = false;
    let alreadyComplete: boolean | undefined;
    try {
      const repository = pullRepository(pr);
      const configurations = await loadConfigurations(session, channel, signal);
      const saved = configurations.rows.find(
        (row) => row.config.repository === repository,
      );
      if (!saved) {
        if (configurations.truncated || configurations.unreadable)
          throw new Error(
            "Could not confirm this repository's configuration. Check Review Configuration and try again.",
          );
        throw new Error(
          `${repository} is not configured in this channel. Add it in Review Configuration, then submit again.`,
        );
      }
      const record = await submitReview(
        session,
        channel,
        saved,
        pr,
        saved.config.lanes.map((lane) => lane.reviewers[0] ?? ""),
        signal,
        (next) => {
          if (controller.signal.aborted) return;
          recorded = true;
          alreadyComplete ??= deliveryThreads(next.value).every(
            (thread) => thread.delivered,
          );
          setResult(next);
        },
        true,
        () => readPull(repository, pullRequest(pr, repository), signal),
        () => {
          existing = true;
        },
        toolDocumentation(),
        {
          read: readAdmission,
          documentation: saved.config.admission?.triage
            ? toolDocumentation("pr_triage_decision")
            : "",
        },
      );
      if (controller.signal.aborted) return;
      setResult(record);
      setStatus(
        record.value.triage?.state === "pending"
          ? "Submitted — awaiting agent triage. Keep Buzz connected on this device to continue automatically."
          : record.value.triage?.state === "rejected"
            ? `Rejected: ${record.value.triage.message}`
            : existing && alreadyComplete
              ? "Already exists — reviewers notified in their existing threads."
              : "Submitted — reviewers assigned and requests delivered.",
      );
    } catch (reason) {
      if (!controller.signal.aborted) {
        setStatus("");
        setError(
          `${reason instanceof Error ? reason.message : "Could not submit PR."}${recorded ? " Existing threads are preserved. Submit again to retry unconfirmed delivery." : ""}`,
        );
      }
    } finally {
      operation.current = undefined;
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  function toolDocumentation(name = "pr_review_status_update") {
    const tool = describeTool?.(name);
    if (!tool)
      throw new Error(
        "Review reporting is unavailable. Update Buzz before sending review requests.",
      );
    if (tool.name === "pr_review_status_update") return tool.description;
    return `Tool: ${tool.name}\n${tool.description}\nArguments: ${JSON.stringify(tool.inputSchema)}`;
  }

  async function remind(row: SavedSubmission, laneId?: string, message = "") {
    if (operation.current || !writable) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setError("");
    const name = `${row.value.config.repository}#${row.value.pr}`;
    setStatus(
      `Reminding reviewers for ${name}${laneId ? ` · ${row.value.config.lanes.find((lane) => lane.id === laneId)?.name}` : ""}…`,
    );
    try {
      const updated = await remindSubmission(
        session,
        channel,
        row,
        AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]),
        async (repository, pr, signal) => {
          try {
            const value = await readStatus(repository, pr, signal);
            if (!controller.signal.aborted)
              setStatuses((current) => ({
                ...current,
                [row.revision]: { value },
              }));
            return value;
          } catch (reason) {
            if (!controller.signal.aborted)
              setStatuses((current) => ({
                ...current,
                [row.revision]: { value: "Unavailable" },
              }));
            throw reason;
          }
        },
        toolDocumentation(),
        laneId,
        message,
      );
      if (!controller.signal.aborted) {
        setReminding(undefined);
        // A reviewer may have reported while later lane notifications were pending.
        // Reload captures those reports; the read effect buffers concurrent arrivals.
        setReload((value) => value + 1);
        if (updated)
          setRows((rows) =>
            rows.map((entry) =>
              entry.artifactId === updated.artifactId ? updated : entry,
            ),
          );
        setStatus(
          `Reviewers reminded for ${name}${laneId ? ` · ${row.value.config.lanes.find((lane) => lane.id === laneId)?.name}` : ""}. Status reset to needs review for the reminded lanes.`,
        );
      }
    } catch (reason) {
      if (!controller.signal.aborted) {
        setStatus("");
        setError(
          `${reason instanceof Error ? reason.message : "Could not remind reviewers."} Reload to refresh PR status; use Remind to retry unconfirmed delivery when available.`,
        );
        setReload((value) => value + 1);
      }
    } finally {
      operation.current = undefined;
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  async function remove() {
    if (!removing || operation.current || !writable) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setDeleteError("");
    setError("");
    setStatus("");
    try {
      await deleteSubmission(
        session,
        channel,
        removing,
        AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
      );
      if (controller.signal.aborted) return;
      setRows((current) =>
        current.filter((row) => row.artifactId !== removing.artifactId),
      );
      setRemoving(undefined);
      setStatus(
        "Submission deleted from the list. Existing conversations are kept.",
      );
    } catch (reason) {
      if (!controller.signal.aborted)
        setDeleteError(
          `${reason instanceof Error ? reason.message : "Could not delete submission."} Close this confirmation and reload to check the saved state before retrying.`,
        );
    } finally {
      operation.current = undefined;
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  function fullMessage(id: string | undefined, label: string) {
    return id ? (
      <a
        className="review-config-message-link"
        href={threadUrl(channel, id)}
        aria-label={`Full message: ${label}`}
        onClick={(event) => {
          if (
            !onOpenMessage ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey
          )
            return;
          event.preventDefault();
          void onOpenMessage(channel, id, event.currentTarget).catch((reason) =>
            setError(
              reason instanceof Error
                ? reason.message
                : "Could not open the message.",
            ),
          );
        }}
      >
        Full message
      </a>
    ) : null;
  }

  function canRemind(row: SavedSubmission) {
    return (
      !busy &&
      !listLoading &&
      writable &&
      (!row.value.triage || row.value.triage.state === "admitted") &&
      row.value.submitter === session.viewer &&
      ["Open", "Draft"].includes(statuses[row.revision]?.value ?? "") &&
      row.value.threads.every((thread) => thread.delivered)
    );
  }

  function table(records: SavedSubmission[], deletable: boolean) {
    return (
      <section
        className="review-config-table-scroll"
        aria-label="Submitted PRs table"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: The table scrollport must support keyboard horizontal scrolling.
        tabIndex={0}
      >
        <table className="review-config-table text-body-sm">
          <thead>
            <tr>
              <th scope="col">Pull request</th>
              {deletable && <th scope="col">GitHub status</th>}
              <th scope="col">Review status</th>
              <th scope="col">Lane threads</th>
              <th scope="col">Lane status</th>
              <th scope="col">Lane last message</th>
              {deletable && <th scope="col">Actions</th>}
            </tr>
          </thead>
          {records.map((row) => {
            const name = `${row.value.config.repository}#${row.value.pr}`;
            const triage = row.value.triage;
            const lanes = [
              ...(triage
                ? [
                    {
                      name: "Admission Triage",
                      reviewers: [triage.agent],
                      thread: triage.thread,
                      status:
                        triage.state === "pending"
                          ? "Awaiting triage"
                          : triage.state === "admitted"
                            ? "Admitted"
                            : "Rejected",
                      messageId: triage.decision ?? triage.thread.id,
                      laneId: undefined,
                    },
                  ]
                : []),
              ...row.value.threads.map((thread, index) => {
                const lane = submissionLane(row.value, index);
                const report = row.reviewReports?.find((event) =>
                  event.tags.some(
                    (tag) => tag[0] === "review" && tag[2] === String(index),
                  ),
                );
                return {
                  name: lane?.name ?? "Overview",
                  reviewers: lane?.reviewers ?? [],
                  thread,
                  status: lane
                    ? reviewLabels[row.reviewStates?.[index] ?? "need_review"]
                    : "—",
                  messageId: report?.id ?? thread.id,
                  laneId: lane?.id,
                };
              }),
            ];
            const overall =
              triage?.state === "pending"
                ? "Awaiting triage"
                : triage?.state === "rejected"
                  ? "Rejected"
                  : reviewLabels[
                      overallReviewStatus(
                        row.value.threads.flatMap((_thread, index) =>
                          submissionLane(row.value, index)
                            ? [row.reviewStates?.[index] ?? "need_review"]
                            : [],
                        ),
                      )
                    ];
            return (
              <tbody key={row.artifactId} aria-label={name}>
                {lanes.map((lane, index) => {
                  const latest = lane.thread.id
                    ? laneMessages[lane.thread.id]
                    : undefined;
                  return (
                    <tr
                      key={
                        lane.laneId ??
                        (lane.name === "Admission Triage"
                          ? "triage"
                          : "overview")
                      }
                    >
                      {index === 0 && (
                        <>
                          <th scope="rowgroup" rowSpan={lanes.length}>
                            <a
                              href={prUrl(row.value)}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {name}
                            </a>
                            <div className="review-config-cell text-caption text-subtle">
                              <span>
                                Submitted:{" "}
                                <ReviewDate
                                  value={row.value.submittedAt}
                                  missing="Not recorded"
                                />
                              </span>
                              <span>
                                Last reviewed:{" "}
                                <ReviewDate
                                  value={
                                    row.reviewHistoryIncomplete
                                      ? undefined
                                      : row.lastReviewedAt
                                  }
                                  missing={
                                    row.reviewHistoryIncomplete
                                      ? "Unavailable"
                                      : "Not yet"
                                  }
                                />
                              </span>
                              {store.unread(row) && (
                                <>
                                  <strong className="text-accent">
                                    Updated
                                  </strong>
                                  <Button
                                    size="sm"
                                    aria-label={`Mark ${name} seen`}
                                    onClick={(event) => {
                                      const link = event.currentTarget
                                        .closest("th")
                                        ?.querySelector("a");
                                      store.markSeen(row);
                                      link?.focus();
                                    }}
                                  >
                                    Mark seen
                                  </Button>
                                </>
                              )}
                            </div>
                          </th>
                          {deletable && (
                            <td
                              rowSpan={lanes.length}
                              title={statuses[row.revision]?.error}
                            >
                              {statuses[row.revision]?.value ?? "Loading…"}
                            </td>
                          )}
                          <td rowSpan={lanes.length}>
                            <div className="review-config-cell">
                              <ReviewStatusLabel label={overall} />
                            </div>
                          </td>
                        </>
                      )}
                      <td>
                        <div className="review-config-cell">
                          <strong>{lane.name}</strong>
                          {lane.reviewers.map((pubkey) => (
                            <ReviewerIdentity
                              key={pubkey}
                              pubkey={pubkey}
                              choices={choices}
                            />
                          ))}
                          {lane.thread.id ? (
                            <Button
                              size="sm"
                              disabled={busy || !onOpenThread}
                              onClick={() =>
                                lane.thread.id &&
                                void onOpenThread?.(
                                  channel,
                                  lane.thread.id,
                                ).catch((reason) =>
                                  setError(
                                    reason instanceof Error
                                      ? reason.message
                                      : "Could not open thread.",
                                  ),
                                )
                              }
                            >
                              Open{" "}
                              {lane.name === "Admission Triage"
                                ? "triage"
                                : lane.name === "Overview"
                                  ? "overview"
                                  : lane.name}{" "}
                              thread
                            </Button>
                          ) : (
                            <span>Thread delivery pending</span>
                          )}
                          {lane.name === "Admission Triage" && (
                            <>
                              {triage?.state === "pending" && (
                                <p className="text-caption text-subtle">
                                  Continues on the submitting device. Submit
                                  this PR again to retry.
                                </p>
                              )}
                              <TriageError
                                scope={session.scope}
                                artifact={row.artifactId}
                              />
                            </>
                          )}
                        </div>
                      </td>
                      <td>
                        <div className="review-config-cell">
                          <ReviewStatusLabel
                            label={
                              lane.thread.delivered
                                ? lane.status
                                : "Sending review request"
                            }
                          />
                          {deletable && lane.laneId && (
                            <Button
                              size="sm"
                              disabled={
                                !canRemind(row) ||
                                (!!row.value.notifying &&
                                  row.value.notifyingLane !== lane.laneId)
                              }
                              aria-label={`Remind ${lane.name} reviewers for ${name}`}
                              onClick={(event) =>
                                openReminder(
                                  row,
                                  lane.laneId,
                                  event.currentTarget,
                                )
                              }
                            >
                              Remind
                            </Button>
                          )}
                        </div>
                      </td>
                      <td className="review-config-last-message">
                        <div className="review-config-cell">
                          {!lane.thread.id ? (
                            "No message yet"
                          ) : !latest ? (
                            "Loading message…"
                          ) : latest.error ? (
                            <span>{latest.error}</span>
                          ) : latest.message ? (
                            <>
                              <time
                                className="text-caption text-subtle"
                                dateTime={new Date(
                                  latest.message.createdAt * 1000,
                                ).toISOString()}
                              >
                                {new Date(
                                  latest.message.createdAt * 1000,
                                ).toLocaleString()}
                              </time>
                              <p>
                                {latest.message.content.slice(0, 160)}
                                {latest.message.content.length > 160 ? "…" : ""}
                              </p>
                            </>
                          ) : (
                            "No message available"
                          )}
                          {fullMessage(
                            latest?.message?.id ?? lane.messageId,
                            `${name} ${lane.name} last message`,
                          )}
                        </div>
                      </td>
                      {index === 0 && deletable && (
                        <td rowSpan={lanes.length}>
                          <div className="review-config-actions">
                            {row.value.notifying &&
                              !row.value.notifyingLane && (
                                <Button
                                  size="sm"
                                  disabled={!canRemind(row)}
                                  onClick={(event) =>
                                    openReminder(
                                      row,
                                      undefined,
                                      event.currentTarget,
                                    )
                                  }
                                >
                                  Retry pending reminders
                                </Button>
                              )}
                            <IconButton
                              icon={<TrashIcon />}
                              title="Delete submission"
                              size="sm"
                              disabled={
                                busy ||
                                listLoading ||
                                !writable ||
                                row.value.submitter !== session.viewer
                              }
                              onClick={(event) => {
                                deleteTrigger.current = event.currentTarget;
                                setDeleteError("");
                                setRemoving(row);
                              }}
                              aria-label={`Delete ${name}`}
                            />
                          </div>
                          {row.value.submitter !== session.viewer && (
                            <p className="text-caption text-subtle">
                              Only the submitter can remind or delete.
                            </p>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            );
          })}
        </table>
      </section>
    );
  }

  return (
    <section className="review-config-form" aria-label="PR submissions">
      {mode === "submit" && (
        <form
          className="review-config-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Field
            label="GitHub PR URL"
            description="We’ll assign a reviewer to each matching lane. Submitting an existing PR notifies its reviewers again."
          >
            <Input
              ref={input}
              required
              maxLength={300}
              value={pr}
              disabled={busy}
              placeholder="https://github.com/example-org/project/pull/123"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              onValueChange={(value) => {
                setPr(value);
                setError("");
                setStatus("");
                setResult(undefined);
              }}
            />
          </Field>
          <div>
            <Button
              type="submit"
              variant="prominent"
              loading={busy}
              disabled={!writable || !pr.trim()}
            >
              Submit PR
            </Button>
          </div>
          {pr && (
            <Button
              disabled={busy}
              onClick={() => {
                setPr("");
                setResult(undefined);
                setError("");
                setStatus("");
                input.current?.focus();
              }}
            >
              Clear
            </Button>
          )}
        </form>
      )}
      {error && !reminding && <p role="alert">{error}</p>}
      {status && (
        <p role="status">
          {result?.value.triage?.state === "rejected"
            ? `Rejected: ${result.value.triage.message}`
            : result?.value.triage?.state === "admitted" &&
                status.startsWith("Submitted — awaiting")
              ? "Admitted — review routing has started."
              : status}
        </p>
      )}
      {result && (
        <section className="review-config-form" aria-label="Submission result">
          <InlineHeader
            title={`${result.value.config.repository}#${result.value.pr}`}
          />
          {table([result], false)}
          {listError && (
            <p role="alert">
              {listError} Open Pull requests and Reload to refresh.
            </p>
          )}
        </section>
      )}
      {mode === "all" && (
        <section className="review-config-form" aria-label="All PRs">
          <div ref={listHeading} tabIndex={-1}>
            <InlineHeader
              title="Submitted pull requests"
              actions={
                <Button
                  disabled={busy || listLoading || !!removing}
                  onClick={() => {
                    setStatus("");
                    setError("");
                    setReload((value) => value + 1);
                  }}
                >
                  Reload
                </Button>
              }
            />
          </div>
          <LoadingRegion
            pending={listLoading}
            label="Loading submissions…"
            statusVisibility="screen-reader"
          >
            {!listLoading && !listError && !rows.length && (
              <p>
                {warning
                  ? "No readable submissions in this result."
                  : "No submissions in the list. Use Submit PR to start a review."}
              </p>
            )}
            {rows.length > 0 && table(rows, true)}
          </LoadingRegion>
          {listError && (
            <p role="alert">{listError} Use Reload to try again.</p>
          )}
          {Object.values(statuses).some(
            (status) => status.value === "Unavailable",
          ) && (
            <p role="alert">
              Some GitHub statuses could not be loaded. Remind is disabled for
              those PRs. Use Reload to try again.
            </p>
          )}
          {warning && <p role="alert">{warning}</p>}
        </section>
      )}
      {reminding && (
        <AlertDialog
          title={`Remind ${reminding.row.value.config.repository}#${reminding.row.value.pr}${reminding.laneId ? ` · ${reminding.row.value.config.lanes.find((lane) => lane.id === reminding.laneId)?.name}` : ""}`}
          description="Ask the reviewer to look again. Sending resets the selected lane to Needs review."
          pending={busy}
          finalFocus={() =>
            reminderTrigger.current?.isConnected
              ? reminderTrigger.current
              : listHeading.current
          }
          onClose={() => setReminding(undefined)}
          actions={
            <>
              <Button disabled={busy} onClick={() => setReminding(undefined)}>
                Cancel
              </Button>
              <Button
                variant="prominent"
                loading={busy}
                disabled={!writable || listLoading || !!listError}
                onClick={() =>
                  void remind(reminding.row, reminding.laneId, reminderMessage)
                }
              >
                Send reminder
              </Button>
            </>
          }
        >
          <Field
            label="Message (optional)"
            description="Included in the reminder posted to the reviewer’s thread."
          >
            <Textarea
              rows={3}
              maxLength={4000}
              value={reminderMessage}
              disabled={busy || !!reminding.row.value.notifying}
              onChange={(event) => setReminderMessage(event.target.value)}
            />
          </Field>
          {reminding.row.value.notifying && (
            <p>Retrying the saved reminder with its original message.</p>
          )}
          {error && <p role="alert">{error}</p>}
        </AlertDialog>
      )}
      {removing && (
        <AlertDialog
          title={`Delete ${removing.value.config.repository}#${removing.value.pr}?`}
          description="Remove this submission from the shared list. The GitHub PR and existing conversations stay available. This does not stop an active review. Submitting the same URL again starts a new review with new threads."
          pending={busy}
          finalFocus={() =>
            deleteTrigger.current?.isConnected
              ? deleteTrigger.current
              : listHeading.current
          }
          onClose={() => setRemoving(undefined)}
          actions={
            <>
              <Button disabled={busy} onClick={() => setRemoving(undefined)}>
                Cancel
              </Button>
              <Button
                variant="prominent"
                disabled={!writable}
                loading={busy}
                onClick={() => void remove()}
              >
                Delete submission
              </Button>
            </>
          }
        >
          {deleteError && <p role="alert">{deleteError}</p>}
        </AlertDialog>
      )}
    </section>
  );
}
