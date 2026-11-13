import { reviewChannel } from "./access";
import type { RelaySession } from "../../features/relay/session";
import { REVIEW_SUBMISSION } from "../../features/agents/pr-review";
import { TRIAGE_REPORT } from "../../features/agents/pr-triage";
import type { ReadAdmission } from "./admission";
import type { ReadPull } from "./pull-facts";
import { decodeSubmission, deviceId, submitReview } from "./submissions";
import {
  pendingTriage,
  setTriageError,
  subscribeTriage,
} from "./triage-recovery";

/** No fleet-wide scan or poll. One bounded current-head read per local pending
 * submission at startup, then event-driven recovery; every send uses the existing
 * Web Lock, signed artifact/CAS and durable outbox. */
export function watchTriage(
  session: RelaySession,
  readPull: ReadPull,
  readAdmission: ReadAdmission,
  documentation: (name: string) => string,
) {
  const controller = new AbortController();
  const running = new Set<string>();
  const dirty = new Set<string>();
  const seen = new Set<string>();
  async function resume(artifact: string) {
    if (controller.signal.aborted) return;
    if (running.has(artifact)) {
      dirty.add(artifact);
      return;
    }
    running.add(artifact);
    try {
      do {
        dirty.delete(artifact);
        const hint = pendingTriage(session.scope).find(
          (item) => item.artifact === artifact,
        );
        if (!hint || !session.snapshotRead) break;
        const signal = AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(120_000),
        ]);
        reviewChannel(session, hint.channel, true);
        const head = (
          await session.snapshotRead(
            [
              {
                kinds: [45010],
                "#h": [hint.channel],
                "#d": [artifact],
                artifact: "current",
                limit: 1,
              },
            ],
            { signal },
          )
        )[0];
        if (!head) break; // Initial create may still be publishing; its echo wakes us.
        const row = await decodeSubmission(head, hint.channel);
        const value = row.value;
        if (
          value.submitter !== session.viewer ||
          value.device !== deviceId(session.scope)
        )
          break;
        if (!value.triage) break;
        await submitReview(
          session,
          hint.channel,
          {
            config: value.config,
            revision: value.configRevision,
            artifactId: "",
          },
          String(value.pr),
          value.triage.reviewers,
          signal,
          () => {},
          true,
          () => readPull(value.config.repository, value.pr, signal),
          undefined,
          documentation("pr_review_status_update"),
          {
            read: readAdmission,
            documentation: documentation("pr_triage_decision"),
            existingOnly: true,
          },
        );
        setTriageError(session.scope, artifact, "");
      } while (dirty.has(artifact) && !controller.signal.aborted);
    } catch (reason) {
      if (!controller.signal.aborted)
        setTriageError(
          session.scope,
          artifact,
          `${reason instanceof Error ? reason.message : "Could not continue triage."} Submit the PR again to retry on the submitting device.`,
        );
    } finally {
      running.delete(artifact);
      dirty.delete(artifact);
    }
  }
  async function all() {
    try {
      for (const hint of pendingTriage(session.scope))
        await resume(hint.artifact);
    } catch (reason) {
      setTriageError(
        session.scope,
        "startup",
        reason instanceof Error
          ? reason.message
          : "Triage recovery is unavailable.",
      );
    }
  }
  const stopHints = subscribeTriage(
    session.scope,
    (artifact) => void resume(artifact),
  );
  const stopLive = session.subscribeLive(
    ({ events }) => {
      for (const event of events) {
        if (seen.has(event.id)) continue;
        const tag = (name: string) =>
          event.tags.find((tag) => tag[0] === name)?.[1];
        const artifact =
          event.kind === 9 && tag("t") === TRIAGE_REPORT
            ? tag("triage")
            : event.kind === 45010 &&
                tag("type") === REVIEW_SUBMISSION &&
                event.pubkey === session.viewer
              ? tag("d")
              : undefined;
        if (!artifact) continue;
        seen.add(event.id);
        if (seen.size > 1000) {
          const first = seen.values().next().value;
          if (first) seen.delete(first);
        }
        void resume(artifact);
      }
    },
    { replay: true },
  );
  const storage = (event: StorageEvent) => {
    if (event.key === `buzz.review.triage:${session.scope}`) all();
  };
  window.addEventListener("storage", storage);
  let timer = setTimeout(() => void all(), 250 + Math.random() * 1000);
  let connected = session.live.snapshot().status === "connected";
  const stopConnection = session.live.subscribe(() => {
    const next = session.live.snapshot().status === "connected";
    if (next && !connected) {
      clearTimeout(timer);
      timer = setTimeout(() => void all(), 250 + Math.random() * 1000);
    }
    connected = next;
  });
  return () => {
    controller.abort();
    clearTimeout(timer);
    stopHints();
    stopLive();
    stopConnection();
    window.removeEventListener("storage", storage);
  };
}
