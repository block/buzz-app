import { useState, useSyncExternalStore } from "react";
import type { Agents } from "../../features/agents/service";
import type { ExternalConnection } from "../../features/agents/external-connection";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { useAgentChoices } from "../../features/agents/use-choices";
import { writeClipboardText } from "../../shared/clipboard";
import { Header, InlineHeader } from "../../shared/design-system/ui/Header";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { Button } from "../../shared/design-system/ui/Button";
import { Select } from "../../shared/design-system/ui/Select";

export function ExternalConnectionSettings({
  agents,
  relay,
  connection,
}: {
  agents: Agents;
  relay: RelayData;
  connection: ExternalConnection;
}) {
  const state = useSyncExternalStore(relay.subscribe, relay.snapshot);
  return (
    <section>
      <Header
        title="Connect Nexus"
        subtitle="Let Nexus read and post as one of your agents in this community."
      />
      {state.status === "ready" ? (
        <ConnectedSettings
          agents={agents}
          session={state.session}
          connection={connection}
        />
      ) : (
        <p className="text-body-sm text-secondary">
          Connect to a community first.
        </p>
      )}
    </section>
  );
}

function ConnectedSettings({
  agents,
  session,
  connection,
}: {
  agents: Agents;
  session: RelaySession;
  connection: ExternalConnection;
}) {
  const choices = useAgentChoices(session, false, true);
  const inventory = useSyncExternalStore(agents.subscribe, agents.snapshot);
  const state = useSyncExternalStore(connection.subscribe, connection.snapshot);
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const eligible = inventory.agents.filter(
    (agent) =>
      agent.place === "here" &&
      !agent.deleting &&
      !agent.protection &&
      choices.selectable.some((choice) => choice.pubkey === agent.pubkey),
  );
  const active = ["starting", "waiting", "connected"].includes(state.phase);
  const agent = eligible.find(
    (agent) => agent.key === (active ? state.agent : selected),
  );
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    setCopied(false);
    try {
      await action();
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "The connection failed. Create it again.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grid gap-section-gap">
      <div>
        <InlineHeader title="External connection" />
        <SettingsGroup layout="form">
          <p className="m-0 text-body-sm text-secondary">
            Nexus can list channels, read messages and threads, and post text as
            the selected agent. Keys stay in Buzz. Keep Buzz open. Only one
            Nexus connection can use this grant.
          </p>
          <Select
            label="Agent"
            variant="field"
            value={agent?.key ?? ""}
            placeholder="Select an agent"
            disabled={active || busy}
            groups={[
              {
                label: "Agents on this device",
                options: eligible.map((agent) => ({
                  value: agent.key,
                  label: agent.name,
                })),
              },
            ]}
            onValueChange={setSelected}
          />
          {!eligible.length && (
            <p className="m-0 text-body-sm text-secondary">
              No eligible agent runs here. Create or start an agent in this
              community. Protected agents cannot use this connection.
            </p>
          )}
          <p role="status" className="m-0 text-body-sm text-secondary">
            {state.phase === "starting"
              ? "Creating connection…"
              : state.phase === "waiting"
                ? "Ready to pair. Copy the connection and paste it into Nexus."
                : state.phase === "connected"
                  ? "Nexus is connected. Revoke access here when you finish."
                  : state.phase === "ended"
                    ? "Connection ended. Create a new connection and pair Nexus again."
                    : "No external connection."}
          </p>
          <div className="flex flex-wrap gap-2">
            {!active && (
              <Button
                disabled={!agent || busy}
                onClick={() => {
                  if (agent) void run(() => connection.create(agent.key));
                }}
              >
                Create connection
              </Button>
            )}
            {state.phase === "waiting" && (
              <Button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await writeClipboardText(connection.descriptor());
                    setCopied(true);
                  })
                }
              >
                Copy connection
              </Button>
            )}
            {active && (
              <Button
                variant="outline"
                onClick={() => {
                  setCopied(false);
                  void connection
                    .revoke()
                    .catch(() =>
                      setError(
                        "Access could not be revoked. Close Buzz and pair again.",
                      ),
                    );
                }}
              >
                Revoke access
              </Button>
            )}
          </div>
          {state.phase === "waiting" && (
            <p className="m-0 text-body-sm text-secondary">
              The copied connection grants access. Paste it only into Nexus. Do
              not put it in a chat or file.
            </p>
          )}
          {copied && state.phase === "waiting" && (
            <p role="status" className="m-0 text-body-sm text-secondary">
              Connection copied.
            </p>
          )}
          {error && (
            <p role="alert" className="m-0 text-body-sm text-danger">
              {error}
            </p>
          )}
        </SettingsGroup>
      </div>
    </div>
  );
}
