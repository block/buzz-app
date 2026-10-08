import type { ActivityRecord } from "../../features/agents/activity-records";
import { activityPresentation } from "./activity-presentation";
import { activityTranscript } from "./transcript";

/** Latest reported action from a live turn, never history borrowed by typing. */
export function currentActivity(
  records: readonly ActivityRecord[],
  turns: readonly { turnId: string; state: string }[],
) {
  const live = new Set(
    turns.filter((turn) => turn.state === "working").map((turn) => turn.turnId),
  );
  const transcript = activityTranscript(records);
  const latest = transcript.groups
    .filter((group) => group.turnId && live.has(group.turnId))
    .flatMap((group) => group.entries)
    .filter(
      (entry) =>
        !entry.diagnostic &&
        ["tool", "thought", "message", "plan"].includes(entry.kind),
    )
    .sort(
      (a, b) =>
        Math.max(
          ...b.sourceIds.map(
            (id) => transcript.sourceOrder.get(id) ?? -Infinity,
          ),
        ) -
        Math.max(
          ...a.sourceIds.map(
            (id) => transcript.sourceOrder.get(id) ?? -Infinity,
          ),
        ),
    )[0];
  if (!latest) return;
  const presentation = activityPresentation(latest);
  const status =
    latest.kind === "tool"
      ? presentation.shellOutput?.failed || latest.status === "failed"
        ? " · Failed"
        : latest.status === "completed"
          ? " · Completed"
          : latest.status === "pending"
            ? " · Pending"
            : latest.status === "in_progress"
              ? " · Running"
              : ""
      : "";
  const detail = presentation.target ?? latest.body;
  return {
    title: `${presentation.title}${status}`,
    detail: detail.length > 240 ? `${detail.slice(0, 240)}…` : detail,
  };
}
