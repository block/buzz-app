import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { RelaySession } from "../../features/relay/session";
import type { AgentView } from "../../features/agents/control";
import { reportedSessionSettings } from "../../features/agents/session-settings";

export function AgentSessionSettings({
  agent,
  session,
}: {
  agent: AgentView;
  session: RelaySession;
}) {
  const activity = session.agentActivity;
  useEffect(() => activity.activate(), [activity]);
  const snapshot = useSyncExternalStore(
    activity.subscribe,
    activity.snapshot,
    activity.snapshot,
  );
  const reports = useMemo(
    () =>
      reportedSessionSettings(snapshot.records, agent.pubkey, agent.relayUrl),
    [snapshot.records, agent.pubkey, agent.relayUrl],
  );
  return (
    <section aria-label="Reported session settings" className="space-y-2">
      <h4 className="text-label">Last reported session settings</h4>
      <p className="text-body-sm text-subtle">
        Observed conversation sessions, not confirmation of the current launch
        or saved choices.
      </p>
      {snapshot.status !== "listening" && (
        <p className="text-body-sm">
          Live settings observation is unavailable or reconnecting.
        </p>
      )}
      {!reports.length && (
        <p className="text-body-sm">
          No session settings in retained activity. New conversation sessions
          report settings after their first message while connected. Existing
          sessions may not resend them.
        </p>
      )}
      {reports.map((report) => (
        <div key={report.sessionId} className="space-y-1">
          <p className="text-body-sm break-all">
            Session {report.sessionId} ·{" "}
            <time dateTime={new Date(report.timestamp).toISOString()}>
              {new Date(report.timestamp).toLocaleString()}
            </time>
          </p>
          <dl className="text-body-sm">
            <div>
              <dt className="inline">Model: </dt>
              <dd className="inline break-all">
                {report.model ?? "Not reported"}
              </dd>
            </div>
            <div>
              <dt className="inline">Effort: </dt>
              <dd className="inline break-all">
                {report.effort ?? "Not reported"}
              </dd>
            </div>
          </dl>
          {report.modelFailure && (
            <p className="text-body-sm text-warning">
              Requested model {report.requestedModel} was{" "}
              {report.modelFailure === "unsupported_model"
                ? "not supported"
                : "rejected"}
              .{" "}
              {report.model
                ? `The session reported ${report.model} instead.`
                : "Fallback model not reported."}
            </p>
          )}
          {report.effortRejected ? (
            <p className="text-body-sm text-warning">
              Requested effort {report.requestedEffort} was rejected.{" "}
              {report.effort
                ? `The session reported ${report.effort} instead.`
                : "Fallback effort not reported."}
            </p>
          ) : report.requestedEffort &&
            report.effort &&
            report.requestedEffort !== report.effort ? (
            <p className="text-body-sm text-warning">
              The session reported effort {report.effort}, different from
              requested {report.requestedEffort}.
            </p>
          ) : null}
        </div>
      ))}
    </section>
  );
}
