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
  const working = turns.filter((turn) => turn.state === "working").length;
  const unknown = turns.filter((turn) => turn.state === "unknown").length;
  const ended = turns.length - working - unknown;
  const latest = Math.max(...turns.map((turn) => turn.timestamp));
  return (
    <section aria-label="Activity preview" className="flex flex-col gap-2">
      <h3 className="text-body">Activity in this channel</h3>
      <p className="text-body-sm text-secondary">
        Owner-only agent telemetry, including threads. Quiet means unknown, not
        idle.
      </p>
      <p role="status" className="text-body-sm">
        {snapshot.status === "unavailable"
          ? "Activity is unavailable on this host."
          : snapshot.status === "connecting"
            ? "Connecting to live activity…"
            : snapshot.status === "interrupted"
              ? "Activity feed interrupted. Current work is unknown."
              : !turns.length
                ? "No turn activity received for this identity in this channel."
                : `${working} working · ${unknown} unknown · ${ended} ended`}
      </p>
      {turns.length > 0 && (
        <p className="text-body-sm text-secondary">
          Latest turn signal:{" "}
          <time dateTime={new Date(latest).toISOString()}>
            {new Date(latest).toLocaleString()}
          </time>
          . Ended does not necessarily mean succeeded.
        </p>
      )}
      <div>
        <Button size="compact" onClick={() => context.open(target)}>
          View activity
        </Button>
      </div>
    </section>
  );
}
