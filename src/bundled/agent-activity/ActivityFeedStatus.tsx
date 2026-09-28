import type { RelaySession } from "../../features/relay/session";
import { Button } from "../../shared/design-system/ui/Button";

type Snapshot = ReturnType<RelaySession["agentActivity"]["snapshot"]>;
/** Feed health is independent of the request/response selected for inspection. */
export function ActivityFeedStatus({
  status,
  trimmed,
  retry,
}: Pick<Snapshot, "status" | "trimmed"> & { retry(): void }) {
  return (
    <>
      {status !== "listening" && (
        <p className="text-body-sm text-subtle" role="status">
          {status === "unavailable"
            ? "This host cannot decode agent activity. Live activity currently requires the development broker."
            : `Feed: ${status}. Current work may be unknown.`}
        </p>
      )}
      {status === "interrupted" && (
        <Button size="sm" onClick={retry}>
          Retry live feed
        </Button>
      )}
      {trimmed > 0 && (
        <p className="text-body-sm text-subtle" role="status">
          Retention limited: {trimmed} older records or turn states discarded
          from this feed.
        </p>
      )}
    </>
  );
}
