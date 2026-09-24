import { useEffect, useState, type ReactNode } from "react";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import type { WorkflowDefinition } from "../../features/workflows/types";
import { useChannelList, useRelayConnection } from "../../features/relay/react";
import {
  ArrowLeftIcon,
  ArrowsClockwiseIcon,
} from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Panel } from "../../shared/design-system/ui/Panel";
import { Select } from "../../shared/design-system/ui/Select";
import { WorkflowChannel } from "./WorkflowChannel";
import { ConfirmAction } from "./ConfirmAction";
import { WorkflowLanding } from "./WorkflowLanding";
import "./workflows.css";

export function WorkflowsPage({ relay }: { relay: RelayData }) {
  const connection = useRelayConnection(relay);
  return (
    <Panel aria-label="Workflows">
      <div className="workflows-page text-body">
        {connection.status === "ready" ? (
          <WorkflowCommunity
            key={`${connection.scope}:${connection.generation}`}
            session={connection.session}
            viewer={connection.viewer ?? ""}
          />
        ) : (
          <>
            <header className="workflow-page-header">
              <div>
                <h1 className="text-title">Workflows</h1>
                <p className="text-secondary">
                  Automations that keep your community moving.
                </p>
              </div>
            </header>
            <div className="workflow-page-state">
              <p>
                {connection.status === "connecting"
                  ? "Connecting to your community…"
                  : "Connect to a community to browse workflows."}
              </p>
              {connection.status === "error" && (
                <>
                  <p role="alert">{connection.error}</p>
                  <Button onClick={() => relay.retry()}>
                    Retry connection
                  </Button>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </Panel>
  );
}
export function WorkflowCommunity({
  session,
  viewer,
}: {
  session: RelaySession;
  viewer: string;
}) {
  const capability = session.workflows;
  const channels = useChannelList(session.channels);
  const [selected, setSelected] = useState("");
  const [selectedDefinition, setSelectedDefinition] = useState<
    WorkflowDefinition | "new" | undefined
  >();
  const [draftAtRisk, setDraftAtRisk] = useState(false);
  const [pendingChannel, setPendingChannel] = useState<string | null>(null);
  const [refreshRequest, setRefreshRequest] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [createChannel, setCreateChannel] = useState("");
  const channel = channels.channels.find((item) => item.id === selected);
  const createTarget = channels.channels.find(
    (item) => item.id === createChannel,
  );
  useEffect(() => {
    if (
      !selected ||
      channel ||
      channels.status !== "ready" ||
      channels.coverage === "partial"
    )
      return;
    setSelected("");
    setSelectedDefinition(undefined);
    setDraftAtRisk(false);
    setPendingChannel(null);
  }, [channel, channels.coverage, channels.status, selected]);
  if (!capability) {
    return (
      <>
        <WorkflowPageHeader />
        <p role="status">Workflow operations are unavailable from this host.</p>
      </>
    );
  }

  const openChannel = (
    next: string,
    definition?: WorkflowDefinition | "new",
  ) => {
    setSelectedDefinition(definition);
    setSelected(next);
  };
  const changeChannel = (next: string) => {
    if (next === selected) return;
    if (draftAtRisk) setPendingChannel(next);
    else openChannel(next);
  };
  const beginCreate = () => {
    const first = channels.channels[0];
    if (!first) return;
    if (channels.channels.length === 1) openChannel(first.id, "new");
    else {
      setCreateChannel(first.id);
      setCreateOpen(true);
    }
  };

  return (
    <>
      <WorkflowPageHeader
        action={
          channel ? (
            <Button onClick={() => changeChannel("")} variant="ghost">
              <ArrowLeftIcon size={16} aria-hidden="true" />
              All workflows
            </Button>
          ) : (
            <IconButton
              aria-label="Refresh workflows"
              icon={<ArrowsClockwiseIcon size={18} aria-hidden="true" />}
              onClick={() => setRefreshRequest((request) => request + 1)}
            />
          )
        }
      />
      {channels.status === "loading" && <p role="status">Reading channels…</p>}
      {channels.status === "error" && (
        <div className="workflow-page-state">
          <p role="alert" className="text-danger">
            {channels.error ?? "Channels could not be read."}
          </p>
          <Button onClick={() => session.channels.refreshList?.()}>
            Retry channels
          </Button>
        </div>
      )}
      {channels.channels.length > 0 && (
        <div className="workflow-page-filter">
          <Select
            label="Channel"
            value={channel?.id ?? ""}
            groups={[
              {
                label: "Community channels",
                options: [
                  { value: "", label: "All workflows" },
                  ...channels.channels.map((item) => ({
                    value: item.id,
                    label: item.name,
                  })),
                ],
              },
            ]}
            onValueChange={changeChannel}
          />
        </div>
      )}
      {channels.status === "ready" && !channels.channels.length && (
        <div className="workflow-page-state">
          <p>No channels are available in this community.</p>
        </div>
      )}
      {channels.coverage === "partial" && (
        <p className="text-secondary">The channel list is partial.</p>
      )}
      {pendingChannel !== null && (
        <ConfirmAction
          title="Change channel?"
          description="Unsaved draft changes will be discarded. Submitted operations remain with their original channel; switching does not cancel or repeat them."
          action="Change channel"
          onCancel={() => setPendingChannel(null)}
          onConfirm={() => {
            openChannel(pendingChannel);
            setPendingChannel(null);
          }}
        />
      )}
      {channel ? (
        <WorkflowChannel
          key={`${channel.id}:${
            typeof selectedDefinition === "object"
              ? selectedDefinition.revision
              : (selectedDefinition ?? "browse")
          }`}
          capability={capability}
          channelId={channel.id}
          channelName={channel.name}
          initialSelection={selectedDefinition}
          viewer={viewer}
          onDraftRiskChange={setDraftAtRisk}
          {...(selectedDefinition === undefined
            ? {}
            : { onClose: () => openChannel("") })}
        />
      ) : channels.channels.length > 0 ? (
        <WorkflowLanding
          capability={capability}
          channels={channels.channels}
          onCreate={beginCreate}
          onOpen={(definition, nextChannel) =>
            openChannel(nextChannel.id, definition)
          }
          refreshRequest={refreshRequest}
          viewer={viewer}
        />
      ) : null}
      <Dialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="Create workflow"
        description="Choose the channel where this workflow will run."
        actions={
          <>
            <Button onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button
              disabled={!createTarget}
              onClick={() => {
                if (!createTarget) return;
                setCreateOpen(false);
                openChannel(createTarget.id, "new");
              }}
              variant="prominent"
            >
              Continue
            </Button>
          </>
        }
      >
        <Select
          label="Channel"
          value={createChannel}
          variant="field"
          groups={[
            {
              label: "Community channels",
              options: channels.channels.map((item) => ({
                value: item.id,
                label: item.name,
              })),
            },
          ]}
          onValueChange={setCreateChannel}
        />
      </Dialog>
    </>
  );
}

function WorkflowPageHeader({ action }: { action?: ReactNode }) {
  return (
    <header className="workflow-page-header">
      <div>
        <h1 className="text-title">Workflows</h1>
        <p className="text-secondary">
          Automations that keep your community moving.
        </p>
      </div>
      {action && <div className="workflow-page-action">{action}</div>}
    </header>
  );
}
