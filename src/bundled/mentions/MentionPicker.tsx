import {
  PopoverRoot,
  PopoverTrigger,
  PopoverPopup,
} from "../../shared/design-system/ui/Popover";
import { mentionChoices } from "./mention-choices";
import { useIdentityNames } from "../../features/identity-names/react";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { SearchField } from "../../shared/design-system/ui/SearchField";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { useMentionAgents } from "../../features/agents/mention-context";
import { useAgentChoices } from "./use-agent-choices";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { useKnownAgentPubkeys } from "../../features/agents/use-known";
import { AtIcon } from "../../shared/design-system/icons/index";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { RelaySession } from "../../features/relay/session";
import styles from "./Mentions.module.css";

import type { ComposerToolProps } from "../../features/conversation/contracts";

/** Select identities from the shared relay roster, never from display-name matching. */
export function MentionPicker({
  session,
  scope,
  channelId,
  disabled,
  inviteAgents,
  select,
}: {
  session: RelaySession;
  scope: string;
  channelId: string;
  disabled: boolean;
  inviteAgents?: boolean | undefined;
  select: ComposerToolProps["insertMention"];
}) {
  const resolveName = useIdentityNames(session.names);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string>();
  const trigger = useRef<HTMLButtonElement>(null);
  const accepted = useRef(false);
  const list = useSyncExternalStore(
    session.channels.subscribeList,
    session.channels.list,
    session.channels.list,
  );
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
    session.profiles.snapshot,
  );
  const agents = useAgentChoices(session, inviteAgents && open);
  const agentPubkeys = useKnownAgentPubkeys(session, profiles);
  const channel = list.channels.find((item) => item.id === channelId);
  const { agents: localAgents } = useMentionAgents(scope);
  const available = useMemo(
    () =>
      !inviteAgents &&
      channel?.members &&
      !channel.archived &&
      (channel.channelType === "stream" || channel.channelType === "forum") &&
      session.outbox?.supports(9000)
        ? localAgents
            .filter((agent) => !channel.members?.includes(agent.pubkey))
            .map(({ pubkey, name }) => ({ pubkey, name }))
        : [],
    [channel, localAgents, session.outbox, inviteAgents],
  );
  const parentAdmission =
    !!channel &&
    (channel.channelType !== "session" || !!channel.parentChannelId);
  const memberKey = channel?.members?.join(":") ?? "";
  useEffect(() => {
    if (!open || !memberKey) return;
    let current = true;
    void session.profiles
      .ensure(memberKey.split(":"), "background")
      .catch(() => {
        if (current)
          setError(
            "Names unavailable. Exact public keys still identify recipients.",
          );
      });
    return () => {
      current = false;
    };
  }, [session, open, memberKey]);
  const candidates = mentionChoices(
    [...agents.identities, ...available],
    channel?.members ?? [],
    profiles,
    resolveName,
  ).filter(({ recipient, label }) =>
    `${label} ${recipient.pubkey}`
      .toLowerCase()
      .includes(search.trim().toLowerCase()),
  );
  return (
    <PopoverRoot
      open={open && !disabled}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          accepted.current = false;
          session.channels.ensureList();
        }
      }}
    >
      <fieldset
        disabled={disabled}
        className={styles.pickerControls}
        aria-label="Mention controls"
      >
        <PopoverTrigger
          disabled={disabled}
          render={
            <IconButton
              disabled={disabled}
              size="toolbar"
              ref={trigger}
              type="button"
              aria-label="Mention a member"
              title="Mention a member"
              icon={<AtIcon size={20} aria-hidden="true" />}
            />
          }
        />
        <PopoverPopup
          side="top"
          size="wide"
          aria-label="Mention a member or agent"
          finalFocus={() => (accepted.current ? false : trigger.current)}
        >
          <div className={styles.mentionContent}>
            <SearchField
              label={
                inviteAgents
                  ? "Search members and agents"
                  : "Search members and your agents"
              }
              value={search}
              onValueChange={setSearch}
              disabled={disabled}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.preventDefault();
              }}
            />
            <p>
              {inviteAgents
                ? parentAdmission
                  ? "Agents you mention join this session and its parent channel when you send, with access to their history."
                  : "Agents you mention join this session when you send, with access to its history."
                : "Your agents are added to this channel when you send."}
            </p>
            {agents.status === "loading" && (
              <p role="status">Loading agents…</p>
            )}
            {agents.status === "error" && (
              <Button
                type="button"
                onClick={() => void session.agentLibrary.refresh()}
              >
                Retry agent list
              </Button>
            )}
            {error && <p role="status">{error}</p>}
            {list.error && (
              <p role="alert">Could not refresh channel membership.</p>
            )}
            {(!inviteAgents || !!channel) && !channel?.members && (
              <p role="status">Channel membership unavailable.</p>
            )}
            <Button
              disabled={disabled}
              type="button"
              onClick={() => session.channels.refreshList?.()}
            >
              Refresh members
            </Button>
            <div className={styles.mentionChoices}>
              {candidates.slice(0, 100).map(({ recipient, label }) => (
                <NavigationItem
                  type="button"
                  key={recipient.pubkey}
                  aria-label={`${label} ${recipient.pubkey}`}
                  disabled={disabled || !!channel?.archived}
                  onClick={() => {
                    if (select(recipient)) {
                      accepted.current = true;
                      setOpen(false);
                    }
                  }}
                  label={
                    <span className="flex flex-col whitespace-normal">
                      <span>{label}</span>
                      {!channel?.members?.includes(recipient.pubkey) && (
                        <small className="text-caption text-subtle">
                          {inviteAgents
                            ? parentAdmission
                              ? "Adds to session and parent channel when you send"
                              : "Adds to session when you send"
                            : "Adds to channel when you send"}
                        </small>
                      )}
                    </span>
                  }
                  title={recipient.pubkey}
                  trailing={<code>{recipient.pubkey.slice(0, 12)}</code>}
                  icon={
                    <Avatar
                      alt=""
                      fallback={label}
                      src={session.media(
                        profiles.get(recipient.pubkey)?.picture ?? "",
                        "small",
                      )}
                      size="default"
                      shape={
                        agentPubkeys.has(recipient.pubkey) ||
                        !channel?.members?.includes(recipient.pubkey)
                          ? "squircle"
                          : "circle"
                      }
                    />
                  }
                />
              ))}
              {candidates.length > 100 && (
                <p>Narrow your search to see more members.</p>
              )}
              {channel?.members && !candidates.length && (
                <p>No matching channel members.</p>
              )}
            </div>
          </div>
        </PopoverPopup>
      </fieldset>
    </PopoverRoot>
  );
}
