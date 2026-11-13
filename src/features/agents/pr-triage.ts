import type { BuzzEvent } from "../../buzz-mcp/client";
import { uuidv5 } from "./agent-config-artifacts";
import { REVIEW_SUBMISSION, reviewTag, reviewToken } from "./pr-review";

export const TRIAGE_REPORT = "buzz.review.triage";
export type TriageDecision = { decision: "admit" | "reject"; message: string };
export type TriageTarget = {
  channel: string;
  artifact: string;
  request: string;
  root: string;
  reviewer: string;
};
type Event = Pick<
  BuzzEvent,
  "kind" | "id" | "pubkey" | "tags" | "content" | "created_at"
>;
export function validateTriageDecision(value: unknown): TriageDecision {
  const item = value as Partial<TriageDecision> | null;
  if (
    !item ||
    Object.keys(item).some((key) => key !== "decision" && key !== "message") ||
    (item.decision !== "admit" && item.decision !== "reject") ||
    typeof item.message !== "string" ||
    !item.message.trim() ||
    item.message.length > 4000
  )
    throw new Error(
      "Supply only decision: admit or reject, and a message (1–4,000 characters). Buzz supplies the triage target.",
    );
  return { decision: item.decision, message: item.message.trim() };
}
export async function triageTarget(
  head: Event,
  channel: string,
  root: string,
  reviewer: string,
): Promise<TriageTarget> {
  const value = JSON.parse(head.content);
  const triage = value?.triage;
  const artifact = reviewTag(head, "d");
  if (
    head.kind !== 45010 ||
    reviewTag(head, "h") !== channel ||
    reviewTag(head, "type") !== REVIEW_SUBMISSION ||
    value.version !== 4 ||
    value.deleted ||
    value.submitter !== head.pubkey ||
    !artifact ||
    !Number.isSafeInteger(value.pr) ||
    value.pr < 1 ||
    typeof value.config?.repository !== "string" ||
    !/^[0-9a-f]{64}$/.test(root) ||
    triage?.thread?.id !== root ||
    triage.agent !== reviewer ||
    typeof triage.thread.request !== "string" ||
    !reviewToken.test(triage.thread.request) ||
    !["pending", "admitted", "rejected"].includes(triage.state) ||
    (await uuidv5(
      channel,
      `${REVIEW_SUBMISSION}:${value.config.repository}:${value.pr}`,
    )) !== artifact
  )
    throw new Error("This thread has no active triage assigned to you.");
  return { channel, artifact, request: triage.thread.request, root, reviewer };
}
export function triageReport(
  event: Event,
  target: TriageTarget,
): TriageDecision | undefined {
  if (
    event.kind !== 9 ||
    event.pubkey !== target.reviewer ||
    reviewTag(event, "h") !== target.channel ||
    reviewTag(event, "t") !== TRIAGE_REPORT ||
    reviewTag(event, "r") !== target.request ||
    reviewTag(event, "triage") !== target.artifact ||
    !event.tags.some(
      (tag) => tag[0] === "e" && tag[1] === target.root && tag[3] === "reply",
    )
  )
    return;
  try {
    return validateTriageDecision({
      decision: reviewTag(event, "decision"),
      message: event.content,
    });
  } catch {
    return;
  }
}
export function latestTriageDecision(
  events: readonly Event[],
  target: TriageTarget,
) {
  const reports = events.flatMap((event) => {
    const decision = triageReport(event, target);
    return decision ? [{ ...decision, id: event.id }] : [];
  });
  const first = reports[0];
  if (
    first &&
    reports.some(
      (report) =>
        report.decision !== first.decision || report.message !== first.message,
    )
  )
    throw new Error(
      "Conflicting triage decisions. Delete and resubmit to request a fresh triage.",
    );
  return first;
}
