import type { Context } from "@buzz/author";
import {
  GitHubError,
  approvePullRequest,
  fetchPullRequestDetail,
  fetchPullRequestFiles,
  fetchViewerLogin,
  hasApprovalForSha,
} from "./github";
import {
  buildAgentSummaryRequest,
  channelMembership,
  repliesFromAgent,
} from "./relaySummary";
import type {
  AgentSummarySelection,
  RelayData,
  ThreadReader,
} from "./relayTypes";
import type {
  PullRequestDetail,
  PullRequestFile,
  PullRequestSummary,
} from "./types";

type ReactRuntime = Context["react"];

// Bounded so a plugin that never disposes its thread reader can't wait
// forever on an agent that's offline or never replies.
const AGENT_REPLY_TIMEOUT_MS = 60_000;
const THREAD_POLL_INTERVAL_MS = 1_000;

type AgentSummaryState =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "waiting" }
  // The agent doesn't signal "done" — this is always the latest matching
  // reply seen so far, and the watch stays alive in case more arrive.
  | { kind: "replied"; content: string }
  | { kind: "timed-out" }
  | { kind: "error"; message: string };

type ApproveState =
  | { kind: "idle" }
  | { kind: "approving" }
  | { kind: "approved" }
  | { kind: "stale" }
  // The POST's outcome is unknown, or a status check couldn't confirm one
  // way or the other. Only action available is checking again — never a
  // second Approve, which would risk a duplicate submission.
  | { kind: "uncertain"; message?: string }
  | { kind: "checking" }
  // A check affirmatively found no matching approval exists for this commit.
  // The only state that offers Retry approve.
  | { kind: "confirmed-not-approved" };

export function createPullRequestDetailView(React: ReactRuntime) {
  return function PullRequestDetailView(props: {
    token: string;
    pullRequest: PullRequestSummary;
    relay: RelayData;
    relaySnapshot: ReturnType<RelayData["snapshot"]>;
    summarySelection: AgentSummarySelection;
  }) {
    const { token, pullRequest, relay, relaySnapshot, summarySelection } =
      props;
    const [detail, setDetail] = React.useState<PullRequestDetail | null>(null);
    const [files, setFiles] = React.useState<PullRequestFile[] | null>(null);
    const [filesTruncated, setFilesTruncated] = React.useState(false);
    const [loadError, setLoadError] = React.useState<string | null>(null);
    const [approveState, setApproveState] = React.useState<ApproveState>({
      kind: "idle",
    });
    const [agentSummaryState, setAgentSummaryState] =
      React.useState<AgentSummaryState>({ kind: "idle" });
    // Computed as soon as the diff loads, not deferred to the click handler:
    // the user must see what will actually be sent (included/omitted files,
    // truncation) before committing to send it to a channel.
    const summaryRequest = React.useMemo(
      () =>
        detail && files
          ? buildAgentSummaryRequest(detail, files, {
              moreFilesBeyondFetchCap: filesTruncated,
            })
          : null,
      [detail, files, filesTruncated],
    );

    // Tracks the live thread watch (reader + subscription + timers) so it can
    // be torn down exactly once, from whichever path notices it should stop:
    // the timeout elapses, the selection or relay generation changes, the
    // pull request changes, or the component unmounts. Disposing only stops
    // observing — a message already sent to the agent can't be un-sent. `id`
    // gives each watch an identity: a callback captured by an older watch
    // (e.g. a refresh() promise still in flight when a newer watch replaces
    // it) checks its captured id against the current watch before touching
    // state, so a stale callback can never resurrect a torn-down watch.
    const agentWatchRef = React.useRef<{
      id: number;
      reader: ThreadReader | null;
      unsubscribe: (() => void) | null;
      intervalId: ReturnType<typeof setInterval> | null;
      timeoutId: ReturnType<typeof setTimeout> | null;
      isRefreshing: boolean;
    }>({
      id: 0,
      reader: null,
      unsubscribe: null,
      intervalId: null,
      timeoutId: null,
      isRefreshing: false,
    });
    const nextWatchIdRef = React.useRef(0);

    function disposeAgentWatch() {
      const watch = agentWatchRef.current;
      watch.unsubscribe?.();
      watch.reader?.dispose();
      if (watch.intervalId !== null) clearInterval(watch.intervalId);
      if (watch.timeoutId !== null) clearTimeout(watch.timeoutId);
      agentWatchRef.current = {
        id: 0,
        reader: null,
        unsubscribe: null,
        intervalId: null,
        timeoutId: null,
        isRefreshing: false,
      };
    }

    // Stop observing (never claim to cancel an already-sent message) when the
    // component unmounts, the summary selection changes, or the relay
    // reconnects to a new session/community.
    React.useEffect(() => disposeAgentWatch, []);
    React.useEffect(() => {
      disposeAgentWatch();
      setAgentSummaryState({ kind: "idle" });
    }, [summarySelection, relaySnapshot.generation]);

    // Scoped to the component's lifetime (not the per-pullRequest load
    // effect below): cancels an in-flight approve/check-status request chain
    // on unmount, so navigating away mid-approve can't still fire a real
    // GitHub mutation (or a stray setState) after the user believes they left.
    const lifetimeControllerRef = React.useRef<AbortController | null>(null);
    React.useEffect(() => {
      const controller = new AbortController();
      lifetimeControllerRef.current = controller;
      return () => controller.abort();
    }, []);

    React.useEffect(() => {
      const controller = new AbortController();
      setDetail(null);
      setFiles(null);
      setFilesTruncated(false);
      setLoadError(null);
      setApproveState({ kind: "idle" });
      disposeAgentWatch();
      setAgentSummaryState({ kind: "idle" });
      // Sequential, not Promise.all: files must be pinned to the exact head
      // SHA the detail load observed, not fetched independently — a push
      // landing between two concurrent requests could otherwise show a diff
      // that doesn't match the commit the Approve button pins to.
      fetchPullRequestDetail(
        token,
        pullRequest.repository,
        pullRequest.number,
        controller.signal,
      )
        .then(async (nextDetail) => {
          if (controller.signal.aborted) return;
          setDetail(nextDetail);
          const result = await fetchPullRequestFiles(
            token,
            pullRequest.repository,
            nextDetail.baseSha,
            nextDetail.headSha,
            controller.signal,
          );
          if (controller.signal.aborted) return;
          setFiles(result.items);
          setFilesTruncated(result.truncated);
        })
        .catch((error) => {
          if (controller.signal.aborted) return;
          setLoadError(
            error instanceof GitHubError
              ? error.message
              : "Could not load this pull request.",
          );
        });
      return () => controller.abort();
    }, [token, pullRequest.repository, pullRequest.number]);

    async function handleApprove() {
      if (!detail) return;
      const signal = lifetimeControllerRef.current?.signal;
      setApproveState({ kind: "approving" });
      try {
        const outcome = await approvePullRequest(
          token,
          pullRequest.repository,
          pullRequest.number,
          detail.headSha,
          signal,
        );
        if (signal?.aborted) return;
        setApproveState({ kind: outcome === "stale" ? "stale" : "approved" });
      } catch {
        if (signal?.aborted) return;
        // The POST's outcome is unknown (network error, timeout): never
        // resubmit automatically. The user explicitly checks first.
        setApproveState({ kind: "uncertain" });
      }
    }

    async function handleCheckStatus() {
      if (!detail) return;
      const signal = lifetimeControllerRef.current?.signal;
      setApproveState({ kind: "checking" });
      try {
        const login = await fetchViewerLogin(token, signal);
        const result = await hasApprovalForSha(
          token,
          pullRequest.repository,
          pullRequest.number,
          login,
          detail.headSha,
          signal,
        );
        if (signal?.aborted) return;
        if (result.found) {
          setApproveState({ kind: "approved" });
        } else if (result.truncated) {
          // Too many reviews to confirm absence from this call alone: stay
          // blocked rather than risk a duplicate approval on a false negative.
          setApproveState({
            kind: "uncertain",
            message:
              "This pull request has too many reviews to confirm from here. Check on GitHub before approving again.",
          });
        } else {
          setApproveState({ kind: "confirmed-not-approved" });
        }
      } catch (error) {
        if (signal?.aborted) return;
        // The check itself failed: still uncertain, not confirmed absent —
        // never surface Retry approve from here.
        setApproveState({
          kind: "uncertain",
          message:
            error instanceof GitHubError
              ? error.message
              : "Could not confirm the approval.",
        });
      }
    }

    function handleSendToAgent() {
      if (!detail || !files || !summarySelection) return;
      const { agentPubkey, channelId } = summarySelection;

      // Re-verify the relay session is still the one the selection was made
      // under, and that the agent is still confirmed a member of the
      // selected channel, immediately before sending — not just at selection
      // time.
      const currentSnapshot = relay.snapshot();
      if (currentSnapshot.generation !== relaySnapshot.generation) {
        setAgentSummaryState({
          kind: "error",
          message:
            "The connection changed since you picked an agent and channel. Reselect them in Settings.",
        });
        return;
      }
      const channel = currentSnapshot.session.channels
        .list()
        .channels.find((candidate) => candidate.id === channelId);
      const membership = channelMembership(channel, agentPubkey);
      if (membership !== "member") {
        setAgentSummaryState({
          kind: "error",
          message:
            membership === "not-member"
              ? "The selected agent is no longer a member of the selected channel."
              : "Can't confirm the selected agent is a member of the selected channel from here.",
        });
        return;
      }

      if (!summaryRequest?.hasUsableDiff) {
        setAgentSummaryState({
          kind: "error",
          message:
            "No diff was available to summarize (every changed file was binary, too large, or otherwise had no patch).",
        });
        return;
      }

      setAgentSummaryState({ kind: "sending" });
      let eventId: string;
      try {
        eventId = currentSnapshot.session.messages.send(
          channelId,
          summaryRequest.prompt,
          [agentPubkey],
        );
      } catch (error) {
        setAgentSummaryState({
          kind: "error",
          message:
            error instanceof Error
              ? error.message
              : "Could not send the diff to the agent.",
        });
        return;
      }

      setAgentSummaryState({ kind: "waiting" });
      disposeAgentWatch();
      const watchId = ++nextWatchIdRef.current;
      const reader = currentSnapshot.session.thread(channelId, eventId);
      const watch = agentWatchRef.current;
      watch.id = watchId;
      watch.reader = reader;

      // A callback from an older, already-replaced watch (e.g. a refresh()
      // promise still in flight when disposeAgentWatch() ran) must not act —
      // it captured `watchId` from its own generation, so compare against the
      // ref's *current* id rather than assuming this closure is still live.
      function isCurrentWatch() {
        return agentWatchRef.current.id === watchId;
      }

      function checkForReply() {
        if (!isCurrentWatch()) return;
        const snapshot = reader.snapshot();
        const replies = repliesFromAgent(snapshot.replies, agentPubkey);
        if (replies.length > 0) {
          // The agent has no completion signal: this may not be the final
          // message, so the watch stays alive and future replies keep
          // updating the displayed content rather than disposing on the
          // first match.
          setAgentSummaryState({
            kind: "replied",
            content: replies[replies.length - 1].content,
          });
        }
      }

      watch.unsubscribe = reader.subscribe(checkForReply);
      watch.intervalId = setInterval(() => {
        if (!isCurrentWatch()) return;
        if (watch.isRefreshing) return; // no overlapping refreshes
        watch.isRefreshing = true;
        reader
          .refresh()
          .then(checkForReply)
          .finally(() => {
            watch.isRefreshing = false;
          });
      }, THREAD_POLL_INTERVAL_MS);
      watch.timeoutId = setTimeout(() => {
        if (!isCurrentWatch()) return;
        disposeAgentWatch();
        setAgentSummaryState({ kind: "timed-out" });
      }, AGENT_REPLY_TIMEOUT_MS);
      reader.refresh().then(checkForReply);
    }

    if (loadError) return <p role="alert">{loadError}</p>;
    if (!detail || !files) return <p>Loading…</p>;

    return (
      <section
        className="beacon-detail"
        aria-label={`Pull request #${pullRequest.number}`}
      >
        <header className="beacon-detail-header">
          <p className="beacon-eyebrow">
            {detail.repository} <span>#{detail.number}</span>
          </p>
          <h2>{detail.title}</h2>
          <div className="beacon-detail-meta">
            <span>
              by <strong>{detail.author}</strong>
            </span>
            <span className="beacon-branches">
              <code>{detail.headRefName}</code>
              <span aria-hidden="true">→</span>
              <code>{detail.baseRefName}</code>
            </span>
          </div>
        </header>
        <div className="beacon-review-grid">
          <section
            className="beacon-card beacon-summary"
            aria-label="Agent summary"
          >
            <div className="beacon-section-heading">
              <h3>Agent summary</h3>
              <span className="beacon-badge beacon-accent">Buzz agent</span>
            </div>
            {!summarySelection && (
              <p>
                Pick a summary agent and channel in Settings to send this diff
                for a summary. There's no built-in AI provider — this posts the
                diff as a message to an existing Buzz agent you choose.
              </p>
            )}
            {summarySelection &&
              (() => {
                const agentName =
                  relaySnapshot.session.agentLibrary
                    .snapshot()
                    .identities.find(
                      (identity) =>
                        identity.pubkey === summarySelection.agentPubkey,
                    )?.name ?? summarySelection.agentPubkey;
                const channelName =
                  relaySnapshot.session.channels
                    .list()
                    .channels.find(
                      (channel) => channel.id === summarySelection.channelId,
                    )?.name ?? summarySelection.channelId;
                const canSend = Boolean(summaryRequest?.hasUsableDiff);
                return (
                  <div>
                    <p className="beacon-sharing">
                      Sends this pull request's title, URL, base/head commits,
                      and diff to <strong>{agentName}</strong> in{" "}
                      <strong>{channelName}</strong>. Every member of that
                      channel can read the diff you send.
                    </p>
                    {summaryRequest?.hasUsableDiff && (
                      <p className="beacon-coverage">
                        Will include {summaryRequest.includedFiles.length}{" "}
                        changed file(s).{" "}
                        {summaryRequest.omittedFiles.length > 0 &&
                          `${summaryRequest.omittedFiles.length} file(s) omitted: ${summaryRequest.omittedFiles.join(", ")}.`}{" "}
                        {summaryRequest.truncated &&
                          "This summary will be partial coverage, not the complete diff."}
                      </p>
                    )}
                    {summaryRequest && !summaryRequest.hasUsableDiff && (
                      <p role="alert">
                        No diff is available to send (every changed file was
                        binary, too large, or otherwise had no patch).
                      </p>
                    )}
                    {agentSummaryState.kind === "idle" && (
                      <button
                        className="beacon-primary"
                        type="button"
                        onClick={handleSendToAgent}
                        disabled={!canSend}
                      >
                        Send diff to agent
                      </button>
                    )}
                    {agentSummaryState.kind === "sending" && <p>Sending…</p>}
                    {agentSummaryState.kind === "waiting" && (
                      <p>Waiting for {agentName} to reply…</p>
                    )}
                    {agentSummaryState.kind === "replied" && (
                      <div className="beacon-reply">
                        <span className="beacon-eyebrow">
                          Latest agent reply
                        </span>
                        <pre>{agentSummaryState.content}</pre>
                        <p className="beacon-reply-note">
                          {agentName} doesn't signal when it's done — this is
                          the latest reply seen; more may still arrive.
                        </p>
                      </div>
                    )}
                    {agentSummaryState.kind === "timed-out" && (
                      <p role="alert">
                        {agentName} hasn't replied yet.{" "}
                        <button
                          type="button"
                          onClick={handleSendToAgent}
                          disabled={!canSend}
                        >
                          Send again
                        </button>
                      </p>
                    )}
                    {agentSummaryState.kind === "error" && (
                      <p role="alert">{agentSummaryState.message}</p>
                    )}
                  </div>
                );
              })()}
          </section>
          <section className="beacon-files" aria-label="Changed files">
            <div className="beacon-section-heading">
              <h3>
                Changed files{" "}
                <span className="beacon-count">{files.length}</span>
              </h3>
              <span className="beacon-diff-totals">
                <span className="beacon-added">
                  +{files.reduce((total, file) => total + file.additions, 0)}
                </span>
                <span className="beacon-removed">
                  −{files.reduce((total, file) => total + file.deletions, 0)}
                </span>
              </span>
            </div>
            {filesTruncated && (
              <p role="alert">
                This pull request changed more files than can be shown here.
                Open it on GitHub to see the complete diff before approving.
              </p>
            )}
            {files.map((file) => (
              <details className="beacon-file" key={file.filename}>
                <summary>
                  <span className="beacon-filename">{file.filename}</span>
                  <span className="beacon-file-stats">
                    (<span className="beacon-added">+{file.additions}</span>/
                    <span className="beacon-removed">−{file.deletions}</span>)
                  </span>
                </summary>
                {file.patch ? (
                  <pre className="beacon-diff">
                    <code>
                      {Array.from(
                        file.patch.matchAll(/[^\n]+\n?|\n/g),
                        (match) => (
                          <span
                            key={match.index}
                            className={
                              match[0].startsWith("+")
                                ? "beacon-diff-add"
                                : match[0].startsWith("-")
                                  ? "beacon-diff-remove"
                                  : match[0].startsWith("@@")
                                    ? "beacon-diff-hunk"
                                    : undefined
                            }
                          >
                            {match[0].replace(/\n$/, "")}
                          </span>
                        ),
                      )}
                    </code>
                  </pre>
                ) : (
                  <p className="beacon-no-patch">
                    Binary or too large to display.
                  </p>
                )}
              </details>
            ))}
          </section>
          <section className="beacon-card beacon-approval" aria-label="Approve">
            <h3>Your review</h3>
            <p className="beacon-muted">
              Review the changes before approving this commit.
            </p>
            <div className="beacon-commit">
              <span>Head commit</span>
              <code>{detail.headSha.slice(0, 7)}</code>
            </div>
            {approveState.kind === "idle" && (
              <button
                className="beacon-primary"
                type="button"
                onClick={handleApprove}
              >
                Approve {detail.headSha.slice(0, 7)}
              </button>
            )}
            {approveState.kind === "approving" && <p>Submitting approval…</p>}
            {approveState.kind === "approved" && (
              <p className="beacon-approved" role="status">
                Approved.
              </p>
            )}
            {approveState.kind === "stale" && (
              <p role="alert">
                The pull request changed since you viewed this diff. Reopen it
                to review the new commit before approving.
              </p>
            )}
            {approveState.kind === "uncertain" && (
              <div role="alert">
                <p>
                  {approveState.message ??
                    "GitHub didn't confirm whether the approval went through. Check before retrying — don't submit a second approval blind."}
                </p>
                <button type="button" onClick={handleCheckStatus}>
                  Check status
                </button>
              </div>
            )}
            {approveState.kind === "checking" && <p>Checking…</p>}
            {approveState.kind === "confirmed-not-approved" && (
              <div role="alert">
                <p>No approval from you was found on this commit.</p>
                <button
                  className="beacon-primary"
                  type="button"
                  onClick={handleApprove}
                >
                  Retry approve
                </button>
              </div>
            )}
            <p className="beacon-approval-note">
              GitHub's current head is checked again before submitting. Agent
              replies never submit approvals.
            </p>
          </section>
        </div>
      </section>
    );
  };
}
