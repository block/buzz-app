import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type {
  AgentControl,
  AgentView,
  RestartChange,
  RestartDiffEntry,
} from "../../features/agents/control";
import { useAgentControl } from "../../features/agents/control-react";
import { sameCommunityAgents } from "../../features/agents/choices";
import { useIdentityNames } from "../../features/identity-names/react";
import { selectProfiles } from "../../features/relay/profile-selection";
import type { RelaySession } from "../../features/relay/session";
import { Button } from "../../shared/design-system/ui/Button";
import { Switch } from "../../shared/design-system/ui/Switch";
import { ToastNotice } from "../../shared/design-system/ui/Toast";
import { AgentEditor } from "../agents/AgentEditor";
import styles from "./Profiles.module.css";

// Base Buzz copy. This app has no automatic restart, so only the "off" blurb applies.
const AUTO_RESTART_OFF_BLURB =
  "Configuration changed since this agent started. Automatic restart is off for this agent — stop and respawn it to apply the changes.";

/** The exact native record for this key in the active community, if unambiguous. */
export function useRuntimeAgent(
  control: AgentControl | undefined,
  scope: string | undefined,
  pubkey: string,
): AgentView | undefined {
  const state = useSyncExternalStore(
    control?.subscribe ?? noSubscribe,
    control?.snapshot ?? noState,
    control?.snapshot ?? noState,
  );
  if (!scope || !state?.data) return undefined;
  const matches = sameCommunityAgents(state.data.agents, scope).filter(
    (agent) => agent.pubkey === pubkey,
  );
  return matches.length === 1 ? matches[0] : undefined;
}
const noSubscribe = () => () => {};
const noState = () => null;

/** Owner-only saved and running configuration. The caller verifies ownership. */
export function ProfileRuntime({
  control,
  agent,
  session,
  owner,
}: {
  control: AgentControl;
  agent: AgentView;
  session: RelaySession;
  owner: string;
}) {
  const state = useAgentControl(control);
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<{
    title: string;
    tone: "success" | "error";
  } | null>(null);
  const ownerName = useOwnerName(session, owner);
  const setStart = control.setStartOnAppLaunch;
  const blocked = !setStart || state.busy || state.status !== "ready";
  const toggle = (enabled: boolean) => {
    if (blocked) return;
    setNotice(null);
    void setStart(agent.id, enabled).then(
      (data) => {
        const updated = data.agents.find((item) => item.id === agent.id);
        if (!updated) return;
        setNotice({
          tone: "success",
          title: updated.startOnAppLaunch
            ? `Will start ${updated.name} automatically when the desktop app opens.`
            : `${updated.name} will stay manual-start only.`,
        });
      },
      () =>
        setNotice({
          tone: "error",
          title: "Failed to update startup preference.",
        }),
    );
  };
  const configuration = [
    ["Runtime", agent.harness.command],
    ["Who can send instructions", respondToLabel(agent.respondTo, ownerName)],
    ["ACP command", agent.acpCommand],
    ["MCP command", agent.mcpCommand],
    ["Backend", agent.backend],
  ].filter((row): row is [string, string] => !!row[1]);
  const editBlocked = state.busy || state.status !== "ready";
  const advanced = [
    ["Workspace", agent.workspace],
    // Names only: environment values stay native.
    ["Environment", agent.harness.environmentKeys.join(", ")],
    ["Databricks workspace (HTTPS origin)", agent.harness.databricks?.host],
    ["Model filter (optional)", agent.harness.databricks?.filter],
  ].filter((row): row is [string, string] => !!row[1]);
  return (
    <div className={styles.runtimeTab}>
      {agent.restartDiff.length > 0 && (
        <section aria-label="Restart required" className={styles.runtime}>
          <h3 className="text-body">Restart required</h3>
          <p className="text-body-sm text-subtle">{AUTO_RESTART_OFF_BLURB}</p>
          <RestartDiffList restartDiff={agent.restartDiff} />
        </section>
      )}
      <section aria-label="Activity" className={styles.runtime}>
        <h3 className="text-body">Activity</h3>
        <Rows rows={[["Status", statusLabel(agent.status)]]} />
        <Switch
          label="Start on launch"
          checked={agent.startOnAppLaunch}
          disabled={blocked}
          onCheckedChange={toggle}
        />
      </section>
      {state.status === "error" && (
        <div className="flex flex-col items-start gap-2">
          {state.error && <p role="alert">{state.error}</p>}
          <Button
            size="compact"
            disabled={state.busy}
            onClick={() => void control.refresh()}
          >
            Retry status
          </Button>
        </div>
      )}
      {!state.data?.runtimeAvailable && (
        <p className="text-body-sm text-secondary">
          {state.data?.runtimeMessage ||
            "The bundled agent runtime is unavailable."}
        </p>
      )}
      {!!configuration.length && (
        <section aria-label="Agent configuration" className={styles.runtime}>
          <h3 className="text-body">Agent configuration</h3>
          <Rows rows={configuration} />
        </section>
      )}
      <section aria-label="Model settings" className={styles.runtime}>
        <h3 className="text-body">Model settings</h3>
        <dl>
          {(
            [
              ["Model", agent.launchModel],
              ["Provider", agent.launchProvider],
            ] as const
          ).map(([label, value]) => (
            <div key={label}>
              <dt className="text-body-sm text-subtle">{label}</dt>
              <dd className="font-mono text-mono">{value ?? "—"}</dd>
              <Button
                size="compact"
                aria-label={`Edit ${label}`}
                title={`Edit ${label}`}
                disabled={editBlocked}
                onClick={() => setEditing(true)}
              >
                Edit
              </Button>
            </div>
          ))}
        </dl>
      </section>
      {!!advanced.length && (
        <section aria-label="Advanced" className={styles.runtime}>
          <h3 className="text-body">Advanced</h3>
          <Rows rows={advanced} />
        </section>
      )}
      {editing && (
        <AgentEditor
          agent={agent}
          control={control}
          state={state}
          onClose={() => setEditing(false)}
        />
      )}
      {notice && (
        <ToastNotice
          title={notice.title}
          tone={notice.tone}
          timeout={5000}
          onDismiss={() => setNotice(null)}
        />
      )}
    </div>
  );
}

function Rows({ rows }: { rows: string[][] }) {
  return (
    <dl>
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt className="text-body-sm text-subtle">{label}</dt>
          <dd className="font-mono text-mono">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function useOwnerName(session: RelaySession, owner: string) {
  const selection = useMemo(
    () => selectProfiles(session.profiles, [owner]),
    [session.profiles, owner],
  );
  const profiles = useSyncExternalStore(
    selection.subscribe,
    selection.snapshot,
    selection.snapshot,
  );
  useEffect(() => {
    void session.profiles.ensure([owner], "background").catch(() => {});
  }, [session, owner]);
  const identityName = useIdentityNames(session.names);
  const name = profiles.get(owner)?.name;
  return name ? identityName(owner, name) : null;
}

function respondToLabel(
  respondTo: AgentView["respondTo"],
  ownerName: string | null,
) {
  if (respondTo === "owner-only")
    return ownerName ? `Only ${ownerName} (owner)` : "Only the owner";
  if (respondTo === "allowlist") return "Selected people";
  return respondTo === "anyone" ? "Anyone" : null;
}

function statusLabel(status: AgentView["status"]) {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

/** Base Buzz's itemized list: `snake_case` → "Snake case", `env.FOO` → "FOO (env)". */
function fieldLabel(field: string) {
  if (field.startsWith("env.")) return `${field.slice(4)} (env)`;
  return field.replace(/_/g, " ").replace(/\b\w/, (c) => c.toUpperCase());
}

function formatValue(value: unknown) {
  if (value === null) return "null";
  if (value === undefined) return "—";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function Change({ change }: { change: RestartChange }) {
  switch (change.kind) {
    case "value":
    case "masked": {
      const before =
        change.kind === "value"
          ? formatValue(change.before)
          : (change.before ?? "••••");
      const after =
        change.kind === "value"
          ? formatValue(change.after)
          : (change.after ?? "••••");
      return (
        <span>
          <s>{before}</s>
          {" → "}
          <span>{after}</span>
        </span>
      );
    }
    case "text":
      return (
        <span>
          {change.beforeChars ?? 0} chars → {change.afterChars ?? 0} chars
        </span>
      );
    case "added":
      return <span>added</span>;
    case "removed":
      return <span>removed</span>;
  }
}

function RestartDiffList({ restartDiff }: { restartDiff: RestartDiffEntry[] }) {
  return (
    <ul className={`${styles.restartDiff} text-body-sm`}>
      {restartDiff.map((entry) => (
        <li key={entry.field}>
          <span>{fieldLabel(entry.field)}:</span>{" "}
          <Change change={entry.change} />
        </li>
      ))}
    </ul>
  );
}
