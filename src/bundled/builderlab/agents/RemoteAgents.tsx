import { useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "../../../shared/design-system/ui/Button";
import type { LoginSnapshot, OAuthSession } from "../oauth/session";
import type { AgentClient, RemoteAgent } from "./client";

export function RemoteAgents({
  client,
  session,
  active,
}: {
  client: AgentClient;
  session: OAuthSession;
  active(): boolean;
}) {
  const login = useSyncExternalStore(session.subscribe, session.snapshot);
  return login.status === "signed-in" ? (
    <AgentList client={client} account={login.account} active={active} />
  ) : null;
}

function AgentList({
  client,
  account,
  active,
}: {
  client: AgentClient;
  account: LoginSnapshot["account"];
  active(): boolean;
}) {
  const [revision, setRevision] = useState(0);
  const [agents, setAgents] = useState<readonly RemoteAgent[]>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Account changes and explicit refreshes must restart the read.
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setAgents(undefined);
    setError(undefined);
    void client.list(controller.signal).then(
      (rows) => {
        if (!controller.signal.aborted) {
          setAgents(rows);
          setLoading(false);
        }
      },
      (reason) => {
        if (!controller.signal.aborted) {
          setError(
            reason instanceof Error ? reason.message : "Could not load agents.",
          );
          setLoading(false);
        }
      },
    );
    return () => controller.abort();
  }, [client, account, revision]);
  return (
    <section
      data-buzz-ui=""
      className="mt-6 flex flex-col gap-3"
      aria-label="Remote agents"
    >
      <h3 className="text-heading-sm text-primary">Remote agents</h3>
      {loading && (
        <p role="status" className="text-body-sm text-secondary">
          Loading remote agents…
        </p>
      )}
      {error && (
        <p role="alert" className="text-body-sm text-danger">
          {error}
        </p>
      )}
      {agents?.length === 0 && (
        <p className="text-body-sm text-secondary">No remote agents yet.</p>
      )}
      {agents && agents.length > 0 && (
        <ul className="flex flex-col gap-3">
          {agents.map((agent) => (
            <li key={agent.id} className="flex flex-col gap-1">
              <div className="text-body-sm text-primary">
                {agent.name} · {agent.status}
              </div>
              <span className="break-all text-mono text-secondary">
                {agent.pubkey}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div>
        <Button
          variant="outline"
          loading={loading}
          onClick={() => {
            if (active()) setRevision((value) => value + 1);
          }}
        >
          {error ? "Retry" : "Refresh agents"}
        </Button>
      </div>
    </section>
  );
}
