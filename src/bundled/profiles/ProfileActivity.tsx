import { useSyncExternalStore } from "react";
import { activityTarget } from "../../features/agents/activity-target";
import type { PanelProps } from "../../features/panels/service";
import type { RelaySession } from "../../features/relay/session";
import { Button } from "../../shared/design-system/ui/Button";

/** Read the plugin-owned capture; mounting a profile never starts telemetry. */
export function ProfileActivity({
  session,
  pubkey,
  context,
}: {
  session: RelaySession;
  pubkey: string;
  context: PanelProps["context"];
}) {
  const snapshot = useSyncExternalStore(
    session.agentActivity.subscribe,
    session.agentActivity.snapshot,
    session.agentActivity.snapshot,
  );
  const channelId = context?.channelId;
  const target = activityTarget(pubkey, channelId);
  if (!channelId || !context?.canOpen(target) || snapshot.status === "disabled")
    return null;

  // Neither public agent hints nor another identity's records grant visibility.
  // Missing conversation context must never broaden this into an all-channel view.
  const turns = snapshot.turns.filter(
    (turn) => turn.agent === pubkey && turn.channelId === channelId,
  );
  const latest = Math.max(...turns.map((turn) => turn.timestamp));
  return (
    <section aria-label="Activity preview" className="flex flex-col gap-2">
      <h3 className="text-body">Latest activity</h3>
      <p role="status" className="text-body-sm text-secondary">
        {snapshot.status === "unavailable" ? (
          "Activity unavailable"
        ) : snapshot.status === "connecting" ? (
          "Connecting…"
        ) : snapshot.status === "interrupted" ? (
          "Activity disconnected"
        ) : !turns.length ? (
          "No activity yet"
        ) : (
          <time dateTime={new Date(latest).toISOString()}>
            {new Date(latest).toLocaleString(undefined, {
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })}
          </time>
        )}
      </p>
      <div>
        <Button size="compact" onClick={() => context.open(target)}>
          View activity
        </Button>
      </div>
    </section>
  );
}
