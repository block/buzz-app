import { useEffect, useState, useSyncExternalStore } from "react";
import type { ExternalApps } from "./external-connection";
import type { Agents } from "./service";
import type { Communities } from "../communities/service";
import type { RelayData } from "../relay/service";
import type { RelaySession } from "../relay/session";
import { useAgentChoices } from "./use-choices";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Button } from "../../shared/design-system/ui/Button";
import { Select } from "../../shared/design-system/ui/Select";
import { ToastNotice } from "../../shared/design-system/ui/Toast";

export function ExternalAuthorizationDialog({
  connection,
  agents,
  communities,
  relay,
}: {
  connection: ExternalApps;
  agents: Agents;
  communities: Communities;
  relay: RelayData;
}) {
  const state = useSyncExternalStore(connection.subscribe, connection.snapshot);
  const client = useSyncExternalStore(
    communities.subscribe,
    communities.snapshot,
  );
  const transport = useSyncExternalStore(relay.subscribe, relay.snapshot);
  const pending = state.pending;
  useEffect(() => {
    if (pending && client.viewer !== pending.viewer)
      void connection.deny().catch(() => {});
  }, [pending, client.viewer, connection]);
  return (
    <>
      <Dialog
        open={!!pending}
        title="Authorize external app"
        description={
          pending
            ? `${pending.request.client} requests access to Buzz.`
            : undefined
        }
        size="compact"
        onOpenChange={(open) => {
          if (!open) void connection.deny().catch(() => {});
        }}
      >
        {pending && (
          <div className="grid gap-4">
            <p className="m-0 text-body-sm text-secondary">
              The requesting app supplies its name. Authorize it only if you
              started setup in that app.
            </p>
            <Select
              label="Community"
              variant="field"
              value={client.selected ?? ""}
              placeholder="Select a community"
              groups={[
                {
                  label: "Your communities",
                  options: client.memberships.map((membership) => ({
                    value: membership.id,
                    label: membership.name,
                  })),
                },
              ]}
              onValueChange={(id) => communities.select(id)}
            />
            <p className="m-0 text-body-sm text-secondary">
              Requested access:{" "}
              {pending.request.scope
                .map((scope) =>
                  scope === "read"
                    ? "read channels, messages and threads"
                    : "post text as the selected agent",
                )
                .join("; ")}
              . Keys stay in Buzz.
            </p>
            {transport.status === "ready" &&
            client.viewer === pending.viewer ? (
              <AgentApproval
                key={transport.scope}
                session={transport.session}
                agents={agents}
                connection={connection}
              />
            ) : (
              <p role="status" className="m-0 text-body-sm text-secondary">
                Select a connected community to authorize this app.
              </p>
            )}
            {!state.available && (
              <p role="alert" className="m-0 text-body-sm text-danger">
                Enable Agents in Buzz desktop to authorize external apps.
              </p>
            )}
          </div>
        )}
      </Dialog>
      {state.error && (
        <ToastNotice
          title="External app authorization failed"
          description={state.error}
        />
      )}
    </>
  );
}
function AgentApproval({
  session,
  agents,
  connection,
}: {
  session: RelaySession;
  agents: Agents;
  connection: ExternalApps;
}) {
  const choices = useAgentChoices(session, false, true);
  const inventory = useSyncExternalStore(agents.subscribe, agents.snapshot);
  const state = useSyncExternalStore(connection.subscribe, connection.snapshot);
  const [selected, setSelected] = useState("");
  const eligible = inventory.agents.filter(
    (agent) =>
      agent.place === "here" &&
      !agent.deleting &&
      !agent.protection &&
      choices.selectable.some((choice) => choice.pubkey === agent.pubkey),
  );
  const chosen =
    eligible.find((agent) => agent.key === selected) ??
    (eligible.length === 1 ? eligible[0] : undefined);
  return (
    <>
      <Select
        label="Agent"
        variant="field"
        placeholder="Select an agent"
        value={chosen?.key ?? ""}
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
          No eligible agent runs here. Start an agent in this community.
          Protected agents cannot use external connections.
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          variant="outline"
          onClick={() => void connection.deny().catch(() => {})}
        >
          Deny
        </Button>
        <Button
          disabled={!chosen || !state.available}
          onClick={() => {
            if (chosen) void connection.approve(chosen.key);
          }}
        >
          Authorize
        </Button>
      </div>
    </>
  );
}
