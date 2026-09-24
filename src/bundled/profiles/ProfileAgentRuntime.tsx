import { useEffect, useSyncExternalStore } from "react";
import type { AgentControl } from "../../features/agents/control";
import { sameCommunityAgents } from "../../features/agents/choices";
import { agentProcessLabel } from "../agents/agent-edit";
import styles from "./Profiles.module.css";

/** Read-only native evidence for this exact key in the active community. Anything
 * else renders nothing, leaving the ordinary public profile. Errors, runtime
 * availability and status recovery belong to ProfileAgentActions. */
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
      {drift && (
        <p>
          Saved revision {agent.revision} is not running yet (running revision{" "}
          {agent.runningRevision}). Restart from Agents to apply.
        </p>
      )}
      {!!facts.length && (
        <>
          <p className="text-body-sm text-subtle">
            Saved settings; environment overrides may apply.
          </p>
          <dl>
            {facts.map(([label, value]) => (
              <div key={label}>
                <dt className="text-body-sm text-subtle">{label}</dt>
                <dd className="font-mono text-mono">{value}</dd>
              </div>
            ))}
          </dl>
        </>
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
