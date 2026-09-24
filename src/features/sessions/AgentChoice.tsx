import { useIdentityNames } from "../identity-names/react";
import { Button } from "../../shared/design-system/ui/Button";
import { RobotIcon, CaretUpIcon } from "../../shared/design-system/icons/index";
import { useAgentChoices } from "../agents/use-choices";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuNote,
} from "../../shared/design-system/ui/Menu";
import { ChoiceRow } from "../../shared/design-system/ui/ChoiceRow";
import { Avatar as ChoiceAvatar } from "../../shared/design-system/ui/Avatar";
import type { RelaySession } from "../relay/session";
import { Avatar } from "../../shared/Avatar";
import { avatarSource } from "../../shared/avatar-source";
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
  const candidates = agents.identities.map((agent) => agent.pubkey);
  const identities = agents.identities.map((agent) => ({
    ...agent,
    name: resolveName(agent.pubkey, agent.name, candidates),
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
    <MenuRoot>
      <span className={styles.agentTrigger}>
        <MenuTrigger
          render={
            <Button variant="outline" size="sm" style={{ maxWidth: "100%" }}>
              {selected ? (
                <Avatar
                  name={selected.name}
                  src={picture(selected.avatar)}
                  className={styles.agentAvatar ?? ""}
                  shape="squircle"
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
      <MenuPopup
        side={side}
        sideOffset={8}
        collisionAvoidance={{
          side: "none",
          align: "shift",
          fallbackAxisSide: "none",
        }}
        aria-label="Choose an agent"
      >
        <MenuRadioGroup
          value={value}
          onValueChange={onChange}
          disabled={disabled}
        >
          <MenuRadioItem value="" closeOnClick>
            <ChoiceRow
              leading={<RobotIcon size={24} aria-hidden="true" />}
              label={emptyLabel}
            />
          </MenuRadioItem>
          {identities.map((agent) => {
            const admission = agentAdmission(
              agent.pubkey,
              allowed,
              sessionMembers,
              parentMembers,
            );
            return (
              <MenuRadioItem
                key={agent.pubkey}
                value={agent.pubkey}
                closeOnClick
              >
                <ChoiceRow
                  leading={
                    <ChoiceAvatar
                      alt=""
                      fallback={agent.name}
                      src={picture(agent.avatar)}
                      size="small"
                      shape="squircle"
                    />
                  }
                  label={agent.name}
                  description={
                    admission === "channel"
                      ? "Adds to channel"
                      : admission === "session-and-channel"
                        ? "Adds to session and channel"
                        : admission === "session"
                          ? "Adds to session"
                          : undefined
                  }
                />
              </MenuRadioItem>
            );
          })}
        </MenuRadioGroup>
        {allowed !== undefined &&
          sessionMembers === undefined &&
          agents.identities.some(
            (agent) => !allowed.includes(agent.pubkey),
          ) && (
            <MenuNote>
              Adding an agent also adds it to{" "}
              {parentName ?? "the parent channel"}, with access to its history.
            </MenuNote>
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
            <MenuNote>
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
            </MenuNote>
          )}
        {agents.status === "loading" && (
          <MenuNote role="status">Loading agents…</MenuNote>
        )}
        {agents.status === "ready" && !agents.identities.length && (
          <MenuNote role="status">
            No agents available in this community.
          </MenuNote>
        )}
        {agents.status === "unavailable" && (
          <MenuNote role="status">
            Your agent library isn’t available on this connection.
          </MenuNote>
        )}
        {(agents.status === "error" || !!agents.error) && (
          <MenuItem closeOnClick={false} onClick={() => void library.refresh()}>
            Retry agent list
          </MenuItem>
        )}
      </MenuPopup>
    </MenuRoot>
  );
}
