import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { AvatarStack } from "../../shared/design-system/ui/AvatarStack";
import type { ComposerAccessoryProps } from "../../features/conversation/contracts";
import { useChannelIdentityNames } from "../../features/identity-names/react";
import type { activityRecords } from "../../features/agents/activity-records";
import { activityTarget } from "../../features/agents/activity-target";
import { profileActivityViewTarget } from "../../features/profiles/target";
import { publicKeyLabels } from "../../shared/identity/public-key";
import { Button } from "../../shared/design-system/ui/Button";
import { TypingDots } from "../../shared/design-system/ui/TypingDots";
import {
  PopoverRoot,
  PopoverTrigger,
  PopoverPopup,
  PopoverTitle,
  PopoverDescription,
  PopoverClose,
} from "../../shared/design-system/ui/Popover";
import { currentActivity } from "./current-activity";
import { messageActivity } from "./message-activity";
import type { ActivityTurn } from "../../features/agents/activity";
import { useKnownAgentPubkeys } from "../../features/agents/use-known";
import { useTypingReplacement } from "../../features/conversation/typing-presentation";
import styles from "./ActivityAccessory.module.css";

/** Activity belongs to the exact triggering message, not the composer. */
export function ActivityAccessory(props: ComposerAccessoryProps) {
  const { session, channelId, message, canOpen } = props;
  const snapshot = useSyncExternalStore(
    session.agentActivity.subscribe,
    session.agentActivity.snapshot,
  );
  const messageId = message?.id;
  const entries = useMemo(
    () => (messageId ? messageActivity(snapshot, channelId, messageId) : []),
    [snapshot, channelId, messageId],
  );
  const profiles = useSyncExternalStore(
    session.profiles.subscribe,
    session.profiles.snapshot,
  );
  const resolveName = useChannelIdentityNames(session, channelId);
  const keys = entries.map((entry) => entry.agent);
  const identityKeys = keys.join(":");
  useEffect(() => {
    if (identityKeys)
      void session.profiles
        .ensure(identityKeys.split(":"), "background")
        .catch(() => {});
  }, [session.profiles, identityKeys]);
  const suffixes = publicKeyLabels(keys);
  const names = keys.map((key) =>
    resolveName(key, profiles.get(key)?.name ?? suffixes.get(key) ?? "Agent"),
  );
  const visible = entries.filter((entry) =>
    canOpen(activityTarget(entry.agent, channelId)),
  );
  if (!visible.length) return null;
  return (
    <section
      className={styles.root}
      data-buzz-ui=""
      aria-label="Agent activity on this message"
    >
      <ActivityBubble
        key={`${channelId}:${message?.id ?? ""}`}
        {...props}
        entries={visible.map((entry) => {
          const name = names[keys.indexOf(entry.agent)] ?? "Agent";
          return {
            agent: entry.agent,
            name:
              names.filter((value) => value === name).length > 1
                ? `${name} · ${suffixes.get(entry.agent)}`
                : name,
            picture: profiles.get(entry.agent)?.picture,
            working: entry.working,
            records: entry.selected.records,
            turns: entry.turns,
          };
        })}
      />
    </section>
  );
}

type Entry = {
  agent: string;
  name: string;
  picture: string | undefined;
  working: boolean;
  records: ReturnType<typeof activityRecords>;
  turns: readonly ActivityTurn[];
};

function ActivityBubble({
  entries,
  ...props
}: ComposerAccessoryProps & { entries: Entry[] }) {
  const [expanded, setExpanded] = useState(false);
  const working = entries.some((entry) => entry.working);
  const unknown = entries.some((entry) => !entry.working);
  return (
    <PopoverRoot open={expanded} onOpenChange={setExpanded}>
      <PopoverTrigger
        openOnHover
        render={
          <Button
            size="xs"
            variant="subtle"
            aria-label={`View agent activity: ${entries.map((entry) => `${entry.name}, ${entry.working ? "working" : "status unknown"}`).join("; ")}`}
          >
            <AvatarStack
              items={entries.map((entry) => ({
                id: entry.agent,
                name: entry.name,
                src: entry.picture
                  ? props.session.media(entry.picture)
                  : undefined,
                shape: "squircle",
              }))}
            />
            {working && <TypingDots />}
            {unknown && <span>Status unknown</span>}
          </Button>
        }
      />
      <PopoverPopup side="top" aria-label="Agent activity">
        <PopoverTitle>Agent activity</PopoverTitle>
        <PopoverDescription>
          Latest reported activity for this message.
        </PopoverDescription>
        {expanded && (
          <div className={styles.previews}>
            {entries.map((entry) => {
              const target = profileActivityViewTarget(entry.agent);
              const preview = entry.working
                ? currentActivity(entry.records, entry.turns)
                : undefined;
              return (
                <section
                  key={entry.agent}
                  aria-label={entry.name}
                  className={styles.preview}
                >
                  <div className={styles.identity}>
                    <ActivityAvatar
                      session={props.session}
                      entry={entry}
                      size="small"
                    />
                    <span className="text-label-sm">{entry.name}</span>
                  </div>
                  <p className="text-body-sm">
                    {!entry.working
                      ? "Activity interrupted or out of date"
                      : (preview?.title ?? "Waiting for activity details")}
                  </p>
                  {preview?.detail && (
                    <p className={`text-body-sm ${styles.detail}`}>
                      {preview.detail}
                    </p>
                  )}
                  {target && props.canOpen(target) && (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`View activity for ${entry.name}`}
                      onClick={() => {
                        if (props.open(target)) setExpanded(false);
                      }}
                    >
                      View activity
                    </Button>
                  )}
                </section>
              );
            })}
          </div>
        )}
        <PopoverClose
          render={
            <Button size="sm" variant="ghost">
              Close
            </Button>
          }
        />
      </PopoverPopup>
    </PopoverRoot>
  );
}

/** Nonvisual composer contribution: agent typing belongs on messages, humans
 * retain the ordinary typing indicator. Removal restores the default display. */
export function ActivityTypingReplacement(props: ComposerAccessoryProps) {
  const profiles = useSyncExternalStore(
    props.session.profiles.subscribe,
    props.session.profiles.snapshot,
  );
  const known = useKnownAgentPubkeys(props.session, profiles);
  const activity = useSyncExternalStore(
    props.session.agentActivity.subscribe,
    props.session.agentActivity.snapshot,
  );
  const agents = new Set([
    ...known,
    ...activity.records.map((record) => record.agent),
  ]);
  return (
    <>
      {[...agents].map((agent) => (
        <TypingReplacement key={agent} {...props} agent={agent} />
      ))}
    </>
  );
}
function TypingReplacement({
  session,
  channelId,
  threadRootId,
  agent,
}: ComposerAccessoryProps & { agent: string }) {
  useTypingReplacement(
    { session, channelId, threadRootId, pubkey: agent },
    true,
  );
  return null;
}

function ActivityAvatar({
  session,
  entry,
  size = "compact",
}: Pick<ComposerAccessoryProps, "session"> & {
  entry: Entry;
  size?: "compact" | "small";
}) {
  return (
    <Avatar
      src={entry.picture ? session.media(entry.picture) : null}
      alt={entry.name}
      fallback={entry.name}
      size={size}
      shape="squircle"
    />
  );
}
