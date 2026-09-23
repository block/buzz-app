import { useEffect, useSyncExternalStore } from "react";
import type { AgentControl } from "../../features/agents/control";
import { sameCommunityAgents } from "../../features/agents/choices";
import { Button } from "../../shared/design-system/ui/Button";
import { agentProcessLabel } from "../agents/agent-edit";
import styles from "./Profiles.module.css";

/** Read-only native evidence for this exact key in the active community. Anything
 * else renders nothing, leaving the ordinary public profile. */
export function ProfileAgentRuntime({
  control,
  scope,
  pubkey,
}: {
  control: AgentControl;
  scope: string;
  pubkey: string;
}) {
  const state = useSyncExternalStore(
    control.subscribe,
    control.snapshot,
    control.snapshot,
  );
  useEffect(() => {
    void control.refresh();
  }, [control]);
  const data = state.data;
  const agent = data
    ? sameCommunityAgents(data.agents, scope).find(
        (candidate) => candidate.pubkey === pubkey,
      )
    : undefined;
  if (!data || !agent) return null;
  const drift =
    agent.runningRevision !== null && agent.runningRevision !== agent.revision;
  const facts = [
    ["Harness", agent.harness.command],
    ["Provider", agent.harness.provider],
    ["Model", agent.harness.model],
    ["Workspace", agent.workspace],
  ].filter(([, value]) => value);
  return (
    <section aria-label="Local agent" className={styles.runtime}>
      <h3 className="text-body">Local agent</h3>
      <p role="status">{agentProcessLabel(agent)}</p>
      {state.status === "error" && (
        <div role="alert">
          <p>Last known host status. Current status could not be confirmed.</p>
          <Button size="compact" onClick={() => void control.refresh()}>
            Retry status
          </Button>
        </div>
      )}
      {!data.runtimeAvailable && (
        <p>
          {data.runtimeMessage ?? "This app's agent runtime is unavailable."}
        </p>
      )}
      {drift && (
        <p>
          Saved revision {agent.revision} is not running yet (running revision{" "}
          {agent.runningRevision}). Restart from Agents to apply.
        </p>
      )}
      {agent.error && <p className={styles.runtimeError}>{agent.error}</p>}
      {!!facts.length && (
        <dl>
          {facts.map(([label, value]) => (
            <div key={label}>
              <dt className="text-body-sm text-subtle">{label}</dt>
              <dd className="font-mono text-mono">{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {agent.systemPrompt && (
        <details>
          <summary>Instructions</summary>
          <p className={styles.about}>{agent.systemPrompt}</p>
        </details>
      )}
      {!!agent.diagnostics.length && (
        <details>
          <summary>Host diagnostics</summary>
          <pre className="font-mono text-mono">
            {agent.diagnostics.join("\n")}
          </pre>
        </details>
      )}
    </section>
  );
}
