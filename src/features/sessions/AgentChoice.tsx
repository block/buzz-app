import { useIdentityNames } from "../identity-names/react";
import { Button } from "../../shared/design-system/ui/Button";
import {
  RobotIcon,
  CheckIcon,
  CaretUpIcon,
} from "../../shared/design-system/icons/index";
import { useAgentChoices } from "../agents/use-choices";
import { Menu } from "@base-ui/react/menu";
import type { RelaySession } from "../relay/session";
import { Avatar } from "../../shared/Avatar";
import { avatarSource } from "../../shared/avatar-source";
import { usePresenceStatus } from "../presence/react";
import completion from "../conversation/Completions.module.css";
import styles from "./Sessions.module.css";

export function agentAdmission(
  pubkey: string,
  allowed?: readonly string[] | undefined,
  sessionMembers?: readonly string[] | undefined,
  parentMembers?: readonly string[] | undefined,
) {
  if (sessionMembers === undefined)
    return allowed !== undefined && !allowed.includes(pubkey)
      ? ("channel" as const)
      : undefined;
  if (sessionMembers.includes(pubkey)) return undefined;
  return parentMembers !== undefined && !parentMembers.includes(pubkey)
    ? ("session-and-channel" as const)
    : ("session" as const);
}

function AgentStatusAvatar({
  session,
  pubkey,
  name,
  src,
}: {
  session: RelaySession;
  pubkey: string;
  name: string;
  src: string | undefined;
}) {
  const presence = usePresenceStatus(session.presence, pubkey);
  return (
    <Avatar
      name={name}
      src={src}
      className={styles.agentAvatar ?? ""}
      shape="squircle"
      statusBadge={presence === "unknown" ? undefined : presence}
    />
  );
}

export function AgentChoice({
  session,
  value,
  onChange,
  disabled = false,
  allowed,
  sessionMembers,
  parentMembers,
  parentName,
  emptyLabel = "No agent selected",
  side = "top",
}: {
  session: RelaySession;
  value: string;
  onChange: (key: string) => void;
  disabled?: boolean;
  allowed?: readonly string[] | undefined;
  sessionMembers?: readonly string[] | undefined;
  parentMembers?: readonly string[] | undefined;
  parentName?: string | undefined;
  emptyLabel?: string;
  side?: "top" | "bottom";
}) {
  const resolveName = useIdentityNames(session.names);
  const library = session.agentChoices;
  const agents = useAgentChoices(session);
  const identities = agents.identities.map((agent) => ({
    ...agent,
    name: resolveName(agent.pubkey, agent.name),
  }));
  const selected = identities.find((agent) => agent.pubkey === value);
  function picture(avatar?: string) {
    const source = avatarSource(avatar);
    return source?.startsWith("data:")
      ? source
      : source
        ? session.media(source, "small")
        : undefined;
  }
  const label = selected
    ? `Change agent: ${selected.name}`
    : value
      ? "Change selected agent"
      : "Choose an agent";
  return (
    <Menu.Root>
      <span className={styles.agentTrigger}>
        <Menu.Trigger
          render={
            <Button variant="outline" size="sm" style={{ maxWidth: "100%" }}>
              {selected ? (
                <AgentStatusAvatar
                  session={session}
                  pubkey={selected.pubkey}
                  name={selected.name}
                  src={picture(selected.avatar)}
                />
              ) : (
                <RobotIcon size={20} aria-hidden="true" />
              )}
              <span className={styles.agentName}>
                {selected?.name ?? "Choose agent"}
              </span>
              <CaretUpIcon size={12} aria-hidden="true" />
            </Button>
          }
          aria-label={label}
          title={label}
          disabled={disabled}
        />
      </span>
      <Menu.Portal>
        <Menu.Positioner
          side={side}
          align="start"
          sideOffset={8}
          collisionAvoidance={{
            side: "none",
            align: "shift",
            fallbackAxisSide: "none",
          }}
          className={styles.agentPositioner}
        >
          <Menu.Popup
            className={`${completion.popup} ${styles.agentMenu}`}
            data-compact=""
            aria-label="Choose an agent"
          >
            <Menu.RadioGroup
              value={value}
              onValueChange={onChange}
              disabled={disabled}
            >
              <Menu.RadioItem
                value=""
                closeOnClick
                className={`${completion.option} ${styles.agentOption}`}
              >
                <RobotIcon size={24} aria-hidden="true" />
                <span>{emptyLabel}</span>
                <Menu.RadioItemIndicator className={styles.agentCheck}>
                  <CheckIcon size={14} />
                </Menu.RadioItemIndicator>
              </Menu.RadioItem>
              {identities.map((agent) => {
                const admission = agentAdmission(
                  agent.pubkey,
                  allowed,
                  sessionMembers,
                  parentMembers,
                );
                const duplicateName = agents.identities.some(
                  (other) =>
                    other.pubkey !== agent.pubkey && other.name === agent.name,
                );
                return (
                  <Menu.RadioItem
                    key={agent.pubkey}
                    value={agent.pubkey}
                    closeOnClick
                    className={`${completion.option} ${styles.agentOption}`}
                  >
                    <AgentStatusAvatar
                      session={session}
                      pubkey={agent.pubkey}
                      name={agent.name}
                      src={picture(agent.avatar)}
                    />
                    <span>
                      {agent.name}
                      {duplicateName ? ` · ${agent.pubkey.slice(0, 8)}` : ""}
                      {admission === "channel"
                        ? " — adds to channel"
                        : admission === "session-and-channel"
                          ? " — adds to session and channel"
                          : admission === "session"
                            ? " — adds to session"
                            : ""}
                    </span>
                    <Menu.RadioItemIndicator className={styles.agentCheck}>
                      <CheckIcon size={14} />
                    </Menu.RadioItemIndicator>
                  </Menu.RadioItem>
                );
              })}
            </Menu.RadioGroup>
            {allowed !== undefined &&
              sessionMembers === undefined &&
              agents.identities.some(
                (agent) => !allowed.includes(agent.pubkey),
              ) && (
                <p>
                  Adding an agent also adds it to{" "}
                  {parentName ?? "the parent channel"}, with access to its
                  history.
                </p>
              )}
            {sessionMembers !== undefined &&
              agents.identities.some(
                (agent) =>
                  agentAdmission(
                    agent.pubkey,
                    allowed,
                    sessionMembers,
                    parentMembers,
                  ) !== undefined,
              ) && (
                <p>
                  Adding an agent gives it access to this session’s history
                  {parentMembers !== undefined &&
                  agents.identities.some(
                    (agent) =>
                      agentAdmission(
                        agent.pubkey,
                        allowed,
                        sessionMembers,
                        parentMembers,
                      ) === "session-and-channel",
                  )
                    ? ` and may add it to ${parentName ?? "the parent channel"}, with access to that channel’s history`
                    : ""}
                  .
                </p>
              )}
            {agents.status === "loading" && (
              <p role="status">Loading agents…</p>
            )}
            {agents.status === "ready" && !agents.identities.length && (
              <p role="status">No agents available in this community.</p>
            )}
            {agents.status === "unavailable" && (
              <p role="status">
                Your agent library isn’t available on this connection.
              </p>
            )}
            {(agents.status === "error" || !!agents.error) && (
              <Menu.Item
                className={`${completion.option} ${styles.agentOption}`}
                closeOnClick={false}
                onClick={() => void library.refresh()}
              >
                Retry agent list
              </Menu.Item>
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
