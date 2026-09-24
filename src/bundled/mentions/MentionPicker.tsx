import { DraftMentionRoster } from "../../features/messages/draft-mention-roster";
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
import { useAgentChoices } from "../../features/agents/use-choices";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { useKnownAgentPubkeys } from "../../features/agents/use-known";
import { AtIcon } from "../../shared/design-system/icons/index";
import {
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { RelaySession } from "../../features/relay/session";
import "../../shared/design-system/styles/scrollbars.css";
import styles from "./Mentions.module.css";

import type { ComposerToolProps } from "../../features/conversation/contracts";
import { peopleOrder } from "../../features/profiles/people-order";

/** Select identities from the shared relay roster, never from display-name matching. */
export function MentionPicker({
  session,
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
  const draftRoster = useContext(DraftMentionRoster);
  const resolveName = useIdentityNames(session.names);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string>();
  const trigger = useRef<HTMLButtonElement>(null);
  const accepted = useRef(false);
  const searchInput = useRef<HTMLElement>(null);
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
  const agents = useAgentChoices(session, !!inviteAgents && open);
  const agentPubkeys = useKnownAgentPubkeys(session, profiles);
  const channel = list.channels.find((item) => item.id === channelId);
  const available = useMemo(
    () =>
      !inviteAgents &&
      channel?.members &&
      !channel.archived &&
      (channel.channelType === "stream" || channel.channelType === "forum") &&
      session.outbox?.supports(9000)
        ? agents.identities
            .filter((agent) => agent.managed)
            .filter((agent) => !channel.members?.includes(agent.pubkey))
            .map(({ pubkey, name }) => ({ pubkey, name }))
        : [],
    [channel, agents, session.outbox, inviteAgents],
  );
  const parentAdmission =
    !!channel &&
    (channel.channelType !== "session" || !!channel.parentChannelId);
  const members =
    draftRoster?.map((person) => person.pubkey) ?? channel?.members;
  const memberKey = members?.join(":") ?? "";
  useEffect(() => {
    if (draftRoster || !open || !memberKey) return;
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
  }, [session, open, memberKey, draftRoster]);
  const order = peopleOrder(search);
  const candidates = mentionChoices(
    draftRoster ?? [...(inviteAgents ? agents.identities : []), ...available],
    members ?? [],
    profiles,
    resolveName,
  )
    .filter(({ recipient, label }) =>
      `${label} ${recipient.pubkey}`
        .toLowerCase()
        .includes(search.trim().toLowerCase()),
    )
    .sort((a, b) =>
      order(
        { name: a.label, pubkey: a.recipient.pubkey },
        { name: b.label, pubkey: b.recipient.pubkey },
      ),
    );
  return (
    <PopoverRoot
      open={open && !disabled}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          accepted.current = false;
          if (!draftRoster) session.channels.ensureList();
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
          padding="none"
          initialFocus={searchInput}
          style={{
            width: 380,
            maxHeight: "min(360px, var(--available-height))",
            overflow: "hidden",
            display: "flex",
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            const fromSearch = event.target === searchInput.current;
            if (event.key === "Enter" && fromSearch) event.preventDefault();
            if (
              event.altKey ||
              event.ctrlKey ||
              event.metaKey ||
              event.shiftKey
            )
              return;
            if (!["ArrowDown", "ArrowUp", "Enter"].includes(event.key)) return;
            const rows = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>(
                "[data-mention-choice]:not(:disabled)",
              ),
            );
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              if (
                !fromSearch &&
                !rows.includes(event.target as HTMLButtonElement)
              )
                return;
              event.preventDefault();
              event.stopPropagation();
              const current = rows.indexOf(
                document.activeElement as HTMLButtonElement,
              );
              const next =
                current < 0
                  ? event.key === "ArrowDown"
                    ? 0
                    : rows.length - 1
                  : (current +
                      (event.key === "ArrowDown" ? 1 : -1) +
                      rows.length) %
                    rows.length;
              rows[next]?.focus();
            } else if (event.key === "Enter" && fromSearch) {
              event.stopPropagation();
              rows[0]?.click();
            }
          }}
          aria-label="Mention a member or agent"
          finalFocus={() => (accepted.current ? false : trigger.current)}
        >
          <div className={styles.mentionContent}>
            <SearchField
              variant="capsule"
              inputRef={searchInput}
              label={
                draftRoster
                  ? "Search recipients"
                  : inviteAgents
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
            {agents.status === "loading" && (
              <p role="status">Loading agents…</p>
            )}
            {(agents.status === "error" || !!agents.error) && (
              <Button
                type="button"
                onClick={() => void session.agentChoices.refresh()}
              >
                Retry agent list
              </Button>
            )}
            {error && <p role="status">{error}</p>}
            {!draftRoster && list.error && (
              <p role="alert">Could not refresh channel membership.</p>
            )}
            {!draftRoster && (!inviteAgents || !!channel) && !members && (
              <p role="status">Channel membership unavailable.</p>
            )}
            {!draftRoster && (
              <Button
                disabled={disabled}
                type="button"
                onClick={() => session.channels.refreshList?.()}
              >
                Refresh members
              </Button>
            )}
            <div className={`${styles.mentionChoices} buzz-thin-scrollbar`}>
              {candidates.slice(0, 100).map(({ recipient, label }) => (
                <NavigationItem
                  variant="option"
                  data-mention-choice=""
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
                      {!members?.includes(recipient.pubkey) && (
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
                      size="large"
                      shape={
                        agentPubkeys.has(recipient.pubkey) ||
                        !members?.includes(recipient.pubkey)
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
              {members && !candidates.length && (
                <p>No matching channel members.</p>
              )}
            </div>
          </div>
        </PopoverPopup>
      </fieldset>
    </PopoverRoot>
  );
}
