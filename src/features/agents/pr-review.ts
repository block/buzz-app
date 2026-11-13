import type { BuzzEvent } from "../../buzz-mcp/client";
import { uuidv5 } from "./agent-config-artifacts";

export const REVIEW_SUBMISSION = "buzz.review.submission";
export const REVIEW_REPORT = "buzz.review.status";
export const REVIEW_STATUSES = [
  "reviewing",
  "request_changes",
  "lgtm_not_approved",
  "approved",
] as const;
export type ReviewStatus =
  | (typeof REVIEW_STATUSES)[number]
  | "done"
  | "wait_author";
export const reviewLabels: Record<ReviewState, string> = {
  need_review: "Needs review",
  reviewing: "Reviewing",
  request_changes: "Changes requested",
  lgtm_not_approved: "Looks good · not approved",
  approved: "Approved",
  done: "Completed · outcome unspecified",
  wait_author: "Waiting on author",
};
export type ReviewState = ReviewStatus | "need_review";
type Event = Pick<
  BuzzEvent,
  "kind" | "id" | "pubkey" | "tags" | "content" | "created_at"
>;
const hex = /^[0-9a-f]{64}$/;
export const reviewToken = /^[0-9a-f-]{36}$/;
export const reviewTag = (event: Event, name: string) =>
  event.tags.find((tag) => tag[0] === name)?.[1];

export type ReviewTarget = Readonly<{
  channel: string;
  artifact: string;
  request: string;
  root: string;
  reviewer: string;
  index: number;
  autoApprove?: boolean;
}>;

/** One active review per lane thread. Resolve its current request from the
 * submitter-owned artifact; the model never chooses a target. */
export async function reviewTarget(
  head: Event,
  channel: string,
  root: string,
  reviewer: string,
): Promise<ReviewTarget> {
  const value = JSON.parse(head.content);
  const matches = Array.isArray(value?.threads)
    ? value.threads.flatMap((thread: { id?: string }, index: number) =>
        thread?.id === root ? [index] : [],
      )
    : [];
  const index = matches[0];
  const artifact = reviewTag(head, "d");
  const thread = value?.threads?.[index];
  const lane = value?.config?.lanes?.[index - (value.version === 1 ? 1 : 0)];
  if (
    matches.length !== 1 ||
    !artifact ||
    head.kind !== 45010 ||
    reviewTag(head, "h") !== channel ||
    reviewTag(head, "type") !== REVIEW_SUBMISSION ||
    ![1, 2, 3, 4].includes(value.version) ||
    value.deleted ||
    (value.version === 4 && value.triage?.state !== "admitted") ||
    value.submitter !== head.pubkey ||
    !hex.test(root) ||
    !Number.isSafeInteger(value.pr) ||
    value.pr < 1 ||
    typeof value.config?.repository !== "string" ||
    !Array.isArray(lane?.reviewers) ||
    lane.reviewers.length !== 1 ||
    lane.reviewers[0] !== reviewer ||
    typeof thread?.request !== "string" ||
    !reviewToken.test(thread.request) ||
    (await uuidv5(
      channel,
      `${REVIEW_SUBMISSION}:${value.config.repository}:${value.pr}`,
    )) !== artifact
  )
    throw new Error(
      "Review thread is unavailable or assigned to another reviewer.",
    );
  return {
    channel,
    artifact,
    request: thread.request,
    root,
    reviewer,
    index,
    autoApprove: lane.autoApprove === true,
  };
}

export function reportStatus(
  event: Event,
  target: ReviewTarget,
): ReviewStatus | undefined {
  const status = reviewTag(event, "status");
  const sequence = reportSequence(event);
  const marker = event.tags.find((tag) => tag[0] === "review");
  if (
    !Number.isSafeInteger(sequence) ||
    sequence < 1 ||
    event.kind !== 9 ||
    event.pubkey !== target.reviewer ||
    reviewTag(event, "h") !== target.channel ||
    reviewTag(event, "t") !== REVIEW_REPORT ||
    reviewTag(event, "r") !== target.request ||
    marker?.[1] !== target.artifact ||
    marker[2] !== String(target.index) ||
    !event.tags.some(
      (tag) => tag[0] === "e" && tag[1] === target.root && tag[3] === "reply",
    ) ||
    (!REVIEW_STATUSES.includes(status as (typeof REVIEW_STATUSES)[number]) &&
      status !== "done" &&
      status !== "wait_author") ||
    (status === "approved" && !target.autoApprove)
  )
    return undefined;
  return status as ReviewStatus;
}

export const reportSequence = (event: Event) =>
  Number(reviewTag(event, "review-sequence"));

export function latestReport(events: readonly Event[], target: ReviewTarget) {
  return events
    .filter((event) => reportStatus(event, target))
    .sort(
      (a, b) =>
        reportSequence(b) - reportSequence(a) ||
        b.created_at - a.created_at ||
        a.id.localeCompare(b.id),
    )[0];
}

export function overallReviewStatus(
  states: readonly ReviewState[],
): ReviewState {
  if (states.includes("request_changes")) return "request_changes";
  if (states.includes("wait_author")) return "wait_author";
  if (states.includes("reviewing")) return "reviewing";
  if (!states.length || states.includes("need_review")) return "need_review";
  if (states.includes("done")) return "done";
  return states.every((state) => state === "approved")
    ? "approved"
    : "lgtm_not_approved";
}
