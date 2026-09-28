import { SavedActivity } from "./SavedActivity";
import type { RelaySession } from "../../features/relay/session";
import { useMemo } from "react";
import type { ActivityRecord } from "../../features/agents/activity-records";
import { ActivityStream } from "./ActivityStream";
import { responseActivity } from "./response-activity";

/** Shared by inline and panel views. A missing boundary never widens the scope. */
export function ResponseActivity({
  records,
  agent,
  channelId,
  messageId,
  showDiagnostics = false,
  session,
}: {
  records: readonly Omit<ActivityRecord, "envelopeId">[];
  session?: RelaySession | undefined;
  agent: string;
  channelId: string;
  messageId: string;
  showDiagnostics?: boolean;
}) {
  const selected = useMemo(
    () => responseActivity(records, agent, channelId, messageId),
    [records, agent, channelId, messageId],
  );
  if (selected.status !== "available")
    return (
      <>
        <p className="text-body-sm text-subtle" role="status">
          {selected.reason === "not-retained"
            ? session?.activityHistory?.available
              ? "No matching activity remains in the live feed. Open saved activity below."
              : "Activity unavailable for this response. No activity is retained for this agent here. Activity is live-only and clears when the app reloads."
            : "Activity unavailable for this response. Its send boundary is missing or ambiguous in the retained feed."}
        </p>
        {session && (
          <SavedActivity
            key={`${agent}:${channelId}:${messageId}`}
            session={session}
            agent={agent}
            channelId={channelId}
            messageId={messageId}
          />
        )}
      </>
    );
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <ActivityStream
        records={selected.records}
        session={session}
        turns={[]}
        showTurnHeading={false}
        showDiagnostics={showDiagnostics}
      />
    </div>
  );
}
