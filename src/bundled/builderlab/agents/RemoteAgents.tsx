import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "../../../shared/design-system/ui/Button";
import { Field } from "../../../shared/design-system/ui/Field";
import { Input } from "../../../shared/design-system/ui/Input";
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
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const operation = useRef<AbortController | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Account changes and explicit refreshes must restart the read.
  useEffect(() => {
    const controller = new AbortController();
    operation.current = controller;
    setBusy(false);
    setName("");
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
  const change = async (agent?: RemoteAgent) => {
    const signal = operation.current?.signal;
    if (!signal || signal.aborted || busy || loading || !active()) return;
    const current = () => !signal.aborted && active();
    setBusy(true);
    setError(undefined);
    const show = (row: RemoteAgent) =>
      setAgents((rows) => [
        ...(rows ?? []).filter((item) => item.id !== row.id),
        row,
      ]);
    try {
      const registered = agent ?? (await client.register(name, signal));
      if (!current()) return;
      show(registered);
      if (!agent) setName("");
      const ready = await client.attest(registered, signal, active);
      if (current()) show(ready);
    } catch (reason) {
      if (current())
        setError(
          reason instanceof Error
            ? reason.message
            : "Could not create the agent. Retry the same name.",
        );
    } finally {
      if (current()) setBusy(false);
    }
  };
  return (
    <section
      data-buzz-ui=""
      className="mt-6 flex flex-col gap-3"
      aria-label="Remote agents"
    >
      <h3 className="text-heading-sm text-primary">Remote agents</h3>
      <form
        className="flex flex-col items-start gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void change();
        }}
      >
        <Field
          label="Agent name"
          description="Up to 64 letters, numbers, spaces, dots, hyphens or underscores."
        >
          <Input
            value={name}
            onValueChange={setName}
            maxLength={64}
            required
            disabled={busy || loading}
          />
        </Field>
        <Button
          type="submit"
          variant="prominent"
          loading={busy}
          disabled={loading || !name.trim()}
        >
          Create agent
        </Button>
      </form>
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
              {agent.status === "Unattested" && (
                <div>
                  <Button
                    variant="outline"
                    disabled={busy || loading}
                    onClick={() => void change(agent)}
                  >
                    Finish setup
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <div>
        <Button
          variant="outline"
          loading={loading}
          disabled={busy}
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
