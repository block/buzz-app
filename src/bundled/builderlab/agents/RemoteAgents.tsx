import {
  useEffect,
  useEffectEvent,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ArrowsClockwiseIcon,
  RobotIcon,
} from "../../../shared/design-system/icons";
import { Button } from "../../../shared/design-system/ui/Button";
import { IconButton } from "../../../shared/design-system/ui/IconButton";
import { EmptyState } from "../../../shared/design-system/ui/EmptyState";
import { InlineHeader } from "../../../shared/design-system/ui/Header";
import styles from "../Settings.module.css";
import type { BuilderlabSession } from "../session";
import type { AgentClient, RemoteAgent } from "./client";

export function RemoteAgents({
  client,
  session,
  active,
  openAgents,
}: {
  client: AgentClient;
  session: BuilderlabSession;
  active(): boolean;
  openAgents?: (() => void) | undefined;
}) {
  const login = useSyncExternalStore(session.subscribe, session.snapshot);
  const [revision, setRevision] = useState(0);
  if (login.status === "signed-in" && !login.account?.canUseRemoteAgents)
    return (
      <section className="mt-section-gap" aria-label="Remote agents">
        <InlineHeader title="Remote agents" />
        <EmptyState
          icon={<RobotIcon />}
          title="Coming soon"
          description="Builderlab remote agents are not available for your account yet."
        />
      </section>
    );
  return login.status === "signed-in" ? (
    <AgentList
      key={`${login.account?.subject}:${revision}`}
      client={client}
      active={active}
      openAgents={openAgents}
      refresh={() => {
        if (active()) setRevision((value) => value + 1);
      }}
    />
  ) : null;
}

function AgentList({
  client,
  active,
  refresh,
  openAgents,
}: {
  client: AgentClient;
  active(): boolean;
  refresh(): void;
  openAgents?: (() => void) | undefined;
}) {
  const [agents, setAgents] = useState<readonly RemoteAgent[]>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const isActive = useEffectEvent(active);
  useEffect(() => {
    const controller = new AbortController();
    const current = () => !controller.signal.aborted && isActive();
    setLoading(true);
    setAgents(undefined);
    setError(undefined);
    void client.list(controller.signal).then(
      (rows) => {
        if (current()) {
          setAgents(rows);
          setLoading(false);
        }
      },
      (reason) => {
        if (current()) {
          setError(
            reason instanceof Error ? reason.message : "Could not load agents.",
          );
          setLoading(false);
        }
      },
    );
    return () => controller.abort();
  }, [client]);
  return (
    <section
      data-buzz-ui=""
      className="mt-section-gap flex flex-col gap-3"
      aria-label="Remote agents"
    >
      <InlineHeader
        title="Remote agents"
        subtitle={
          <>
            Manage hosted agents and their settings in Agents.
            {agents && agents.length > 0 && (
              <>
                {" "}
                ·{" "}
                <span>
                  {agents.length} hosted{" "}
                  {agents.length === 1 ? "agent" : "agents"}
                </span>
              </>
            )}
          </>
        }
        actions={
          <IconButton
            aria-label={error ? "Retry" : "Refresh agents"}
            loading={loading}
            onClick={refresh}
            icon={<ArrowsClockwiseIcon aria-hidden="true" />}
          />
        }
      />
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
        <EmptyState
          icon={<RobotIcon />}
          title="No remote agents yet."
          description={
            openAgents
              ? "Create your first hosted agent in Agents."
              : "Enable the Agents plugin to create and manage hosted agents."
          }
          level={4}
          action={
            openAgents ? (
              <Button
                size="sm"
                onClick={() => {
                  if (active()) openAgents();
                }}
              >
                Open Agents
              </Button>
            ) : undefined
          }
        />
      )}
      {agents && agents.length > 0 && (
        <div className={styles.content}>
          <ul className={styles.collection} aria-label="Hosted agents">
            {agents.map((agent) => (
              <li key={agent.id} className={styles.community}>
                <div className={styles.communityIdentity}>
                  <span className={styles.communityIcon} aria-hidden="true">
                    <RobotIcon size={20} />
                  </span>
                  <div className="grid min-w-0 gap-1">
                    <p className="m-0 text-label">{agent.name}</p>
                    <p className="m-0 text-caption text-muted">
                      {agent.status === "Unattested"
                        ? "Setup incomplete"
                        : agent.status}
                    </p>
                  </div>
                </div>
              </li>
            ))}
          </ul>
          <div className={styles.sectionAction}>
            {openAgents ? (
              <Button
                size="sm"
                onClick={() => {
                  if (active()) openAgents();
                }}
              >
                Open Agents
              </Button>
            ) : (
              <p className="text-body-sm text-secondary">
                Enable the Agents plugin to manage hosted agents.
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
