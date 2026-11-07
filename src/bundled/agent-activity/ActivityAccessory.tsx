import { activityTranscript } from "../../features/agents/activity-transcript";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import { useProfileGeneration } from "../../features/relay/react";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { AvatarStack } from "../../shared/design-system/ui/AvatarStack";
import type { ComposerAccessoryProps } from "../../features/conversation/contracts";
import { useChannelIdentityNames } from "../../features/identity-names/react";
import {
  openProfileTranscript,
  profileActivityViewTarget,
} from "../../features/profiles/target";
import { publicKeyLabels } from "../../shared/identity/public-key";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { WarningCircleIcon, XIcon } from "../../shared/design-system/icons";
import {
  NavigationCard,
  NavigationItem,
} from "../../shared/design-system/ui/NavigationItem";
import {
  PopoverRoot,
  PopoverTrigger,
  PopoverPopup,
} from "../../shared/design-system/ui/Popover";
import { messageWork } from "./message-activity";
import type { RequestWork } from "../../features/agents/request-work";
import { localWorkLabel } from "../../features/agents/local-activity";
import styles from "./ActivityAccessory.module.css";
import messageStyles from "../../features/messages/Messages.module.css";
import { avatarMedia } from "../../shared/avatar-source";
import { remoteWorkDetail } from "../../features/agents/execution-location";

const noSubscribe = () => () => {};
type ActivityProps = ComposerAccessoryProps;
const noWork: RequestWork[] = [];
const isOutcome = (entry: Pick<RequestWork, "state">) =>
  entry.state === "error" || entry.state === "unknown";
/** What happened to the exact triggering message: a failure, an unconfirmed
 * result or a stop. Live work is never shown here; the conversation's end
 * indicator is its only place. Once an agent has publicly replied, its outcome
 * follows that reply instead. */
export function ActivityAccessory(props: ActivityProps) {
  if (
    props.message?.notice === "execution-failure" &&
    !props.message.edited &&
    !props.message.attachments.length
  )
    return null;
  const request = props.stoppedRequest;
  const author = props.message?.authorId;
  return (
    <>
      <MessageOutcome {...props} />
      {request && author && (
        <MessageOutcome
          {...props}
          message={request}
          threadRootId={request.threadRootId}
          representedAgents={undefined}
          repliedAgents={undefined}
          stoppedRequest={undefined}
          stoppedAgent={author}
          // Visibility follows the request's scope, not the reply row's layout.
          threadScoped={
            props.messageLayout === "thread" || !!props.message?.threadRootId
          }
        />
      )}
    </>
  );
}
/** With `stoppedAgent`, only that agent's outcome for `message`. */
function MessageOutcome(
  props: ActivityProps & { stoppedAgent?: string; threadScoped?: boolean },
) {
  const { session, channelId, message, canOpen, stoppedAgent } = props;
  const messageId = message?.id;
  // Every row mounts this; only rows with an outcome subscribe to each
  // activity, profile and choice change. Others read once and wait.
  const hasOutcome = useSyncExternalStore(
    session.agentActivity.subscribe,
    () => {
      if (!messageId) return false;
      const work = messageWork(
        session.agentActivity.snapshot(),
        channelId,
        messageId,
      );
      return work.live.some(isOutcome) || work.stopped.length > 0;
    },
  );
  const snapshot = useSyncExternalStore(
    hasOutcome ? session.agentActivity.subscribe : noSubscribe,
    session.agentActivity.snapshot,
  );
  const work = useMemo(
    () =>
      messageId && hasOutcome
        ? messageWork(snapshot, channelId, messageId)
        : { live: noWork, stopped: noWork },
    [snapshot, channelId, messageId, hasOutcome],
  );
  const entries = work.live.filter(
    (entry) =>
      isOutcome(entry) &&
      (stoppedAgent
        ? entry.agent === stoppedAgent
        : !props.repliedAgents?.includes(entry.agent)),
  );
  const stopped = stoppedAgent
    ? work.stopped.filter((entry) => entry.agent === stoppedAgent)
    : work.stopped.filter(
        (entry) => !props.repliedAgents?.includes(entry.agent),
      );
  const profiles = useSyncExternalStore(
    hasOutcome ? session.profiles.subscribe : noSubscribe,
    session.profiles.snapshot,
  );
  const choices = useSyncExternalStore(
    hasOutcome ? session.agentChoices.subscribe : noSubscribe,
    session.agentChoices.snapshot,
  );
  const resolveName = useChannelIdentityNames(session, channelId);
  const keys = [...entries, ...stopped].map((entry) => entry.agent);
  const identityKeys = keys.join(":");
  const profileGeneration = useProfileGeneration(session.profiles);
  useEffect(() => {
    void profileGeneration;
    if (identityKeys)
      void session.profiles
        .ensure(identityKeys.split(":"), "background")
        .catch(() => {});
  }, [session.profiles, identityKeys, profileGeneration]);
  const suffixes = publicKeyLabels(keys);
  const names = keys.map((key) =>
    resolveName(
      key,
      profiles.get(key)?.name ??
        choices.identities.find((row) => row.pubkey === key)?.name ??
        suffixes.get(key) ??
        "Agent",
    ),
  );
  const named = (agent: string) => {
    const name = names[keys.indexOf(agent)] ?? "Agent";
    return names.filter((value) => value === name).length > 1
      ? `${name} · ${suffixes.get(agent)}`
      : name;
  };
  // An outcome belongs to the conversation its work ran in: thread work is
  // reported in that thread, not on the channel's copy of its first message.
  const visible = (entry: RequestWork) => {
    if (!canOpen(profileActivityViewTarget(entry.agent) ?? "")) return false;
    const threadScoped =
      props.threadScoped ??
      (props.messageLayout === "thread" || !!message?.threadRootId);
    if (threadScoped) return true;
    const local = (snapshot.local ?? []).filter(
      (work) =>
        work.agent === entry.agent &&
        work.channelId === channelId &&
        work.messageId === messageId,
    );
    if (local.length)
      return local.some(
        (work) =>
          !work.thread &&
          !(
            message &&
            message.replyCount > 0 &&
            work.threadRootId === message.id
          ),
      );
    // A top-level request is its own root until replies make it a thread.
    const inThread = (root: string | null | undefined) =>
      !!root && (root !== messageId || (message?.replyCount ?? 0) > 0);
    const turns = activityTranscript(entry.selected.records, {
      agent: entry.agent,
      channelId,
    }).turns;
    return !(entry.turns.length
      ? entry.turns.every(
          (turn) =>
            inThread(turn.threadRootId) ||
            turns.some(
              (raw) => raw.turnId === turn.turnId && inThread(raw.threadRootId),
            ),
        )
      : turns.length && turns.every((turn) => inThread(turn.threadRootId)));
  };
  const shown: Entry[] = entries.filter(visible).map((entry) => {
    const choice = choices.identities.find((row) => row.pubkey === entry.agent);
    return {
      agent: entry.agent,
      name: named(entry.agent),
      picture: profiles.get(entry.agent)?.picture,
      remoteStatus: session.viewer
        ? remoteWorkDetail(choice?.execution, choice?.runtime)
        : undefined,
      state: entry.state,
      reason: entry.reason,
      ...(entry.retryable ? { retryable: true } : {}),
      lifecycle: entry.lifecycle,
    };
  });
  // A stopped request stays noted here. It sits in the incoming message frame
  // without a gutter, so it starts at the reply avatars' edge.
  const noted = stopped.filter(
    (entry) =>
      visible(entry) && !shown.some((row) => row.agent === entry.agent),
  );
  const note = noted.length ? (
    <div
      className={`${messageStyles.message} ${styles.outcome}`}
      data-layout={props.messageLayout ?? "timeline"}
    >
      {stoppedAgent && <div className={messageStyles.messageGutter} />}
      <div
        className={`${styles.root} ${styles.stopped} text-caption text-subtle buzz-arrive`}
        data-activity-stopped=""
        data-buzz-ui=""
      >
        {!stoppedAgent && (
          <AvatarStack
            size="mini"
            items={noted.map(({ agent }) => ({
              id: agent,
              name: named(agent),
              src: avatarMedia(profiles.get(agent)?.picture, session.media),
              shape: "squircle",
            }))}
          />
        )}
        <span>
          {!stoppedAgent &&
            `${noted.map(({ agent }) => named(agent)).join(", ")} · `}
          Stopped
        </span>
      </div>
    </div>
  ) : null;
  if (!shown.length) return note;
  return (
    <>
      <section
        className={`${messageStyles.message} ${styles.outcome}`}
        data-layout={props.messageLayout ?? "timeline"}
        data-activity-outcome=""
        aria-label="Agent activity on this message"
      >
        {stoppedAgent && <div className={messageStyles.messageGutter} />}
        <div
          className={`${styles.root} ${styles.caption} text-caption text-subtle`}
          aria-live="polite"
        >
          {!stoppedAgent && (
            <>
              <AvatarStack
                size="mini"
                items={shown.map((entry) => ({
                  id: entry.agent,
                  name: entry.name,
                  src: avatarMedia(entry.picture, session.media),
                  shape: "squircle",
                }))}
              />
              <span>{shown.map((entry) => entry.name).join(", ")} ·</span>
            </>
          )}
          <OutcomeDetails {...props} entries={shown} />
        </div>
      </section>
      {note}
    </>
  );
}

type Entry = {
  agent: string;
  name: string;
  picture: string | undefined;
  /** Shown for a known remote agent. */
  remoteStatus: string | undefined;
  state: RequestWork["state"];
  reason: string | undefined;
  retryable?: boolean;
  lifecycle: boolean;
};

function OutcomeDetails({
  entries,
  ...props
}: ActivityProps & { entries: Entry[] }) {
  const [expanded, setExpanded] = useState(false);
  const message = props.message;
  const notify = useToastNotification();
  // A retried request begins again: its live work shows at the conversation's
  // end, and this outcome retires (the unmount below hands focus back).
  const retry = (entry: Entry) => {
    if (!message) return;
    try {
      props.session.agentActivity.retry(
        entry.agent,
        props.channelId,
        message.id,
      );
      setExpanded(false);
    } catch (error) {
      notify(
        `Couldn’t retry ${entry.name}. ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
  };
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const onFocusedRemoval = useRef(props.onFocusedRemoval);
  useLayoutEffect(() => {
    onFocusedRemoval.current = props.onFocusedRemoval;
  });
  useLayoutEffect(() => {
    const button = trigger.current;
    return () => {
      // Dismiss or retry removes this outcome. Unless focus has moved on by
      // then, return it to the host once the removal has committed.
      const document = button?.ownerDocument;
      const focused = document?.activeElement;
      if (
        !focused ||
        !(button?.contains(focused) || popup.current?.contains(focused))
      )
        return;
      queueMicrotask(() => {
        const current = document?.activeElement;
        if (!current || current === document?.body)
          onFocusedRemoval.current?.();
      });
    };
  }, []);
  const unknown = entries.some((entry) => entry.state === "unknown");
  const failedCount = entries.filter((entry) => entry.state === "error").length;
  // Local requests have no unknown state: their outcome is a failure.
  const label = (entry: Entry) =>
    entry.lifecycle
      ? localWorkLabel({
          state: "error",
          ...(entry.reason ? { error: entry.reason } : {}),
        })
      : entry.state === "error"
        ? "failed"
        : "status unknown";
  const failedEntries = entries.filter((entry) => entry.state === "error");
  const avatars = (group: Entry[]) => (
    <AvatarStack
      size="mini"
      items={group.map((entry) => ({
        id: entry.agent,
        name: entry.name,
        src: avatarMedia(entry.picture, props.session.media),
        shape: "squircle",
      }))}
    />
  );
  return (
    <PopoverRoot open={expanded} onOpenChange={setExpanded}>
      <span className={styles.summaryGroups}>
        {unknown && (
          <span className={styles.summaryActivity}>
            <span>Status unavailable</span>
          </span>
        )}
        {failedCount > 0 && (
          <span
            className={`${styles.summaryActivity} ${styles.failure}`}
            data-activity-failure=""
          >
            {avatars(
              failedEntries.filter(
                (entry) => entry.agent !== entries[0]?.agent,
              ),
            )}
            <WarningCircleIcon size={12} aria-hidden="true" />
            <span>
              {entries.length === 1
                ? "Couldn’t finish"
                : `${failedCount} failed`}
            </span>
          </span>
        )}
      </span>
      <PopoverTrigger
        openOnHover="preview"
        render={
          <Button
            ref={trigger}
            variant="link"
            size="inline"
            aria-label={`View agent activity: ${entries.map((entry) => `${entry.name}, ${entry.remoteStatus ? "remote, " : ""}${label(entry)}`).join("; ")} · Details`}
          >
            Details
          </Button>
        }
      />
      <PopoverPopup
        ref={popup}
        side="top"
        padding="list"
        aria-label="Agent activity"
      >
        {expanded && (
          <div className={styles.previews}>
            {entries.map((entry) => {
              // Opens the agent's Activity on this message's transcript.
              const target = profileActivityViewTarget(entry.agent);
              return (
                <NavigationCard key={entry.agent}>
                  {!entry.lifecycle ? (
                    <div className={`${styles.outcomeDetail} text-body-sm`}>
                      <span className="text-subtle">{entry.name}</span>
                      <span>
                        {entry.state === "error"
                          ? "This request ended before it could finish. Try again in a new thread, or choose a different model."
                          : "Buzz couldn’t confirm whether this request finished. Check the conversation before trying again."}
                      </span>
                    </div>
                  ) : (
                    <NavigationItem
                      variant="option"
                      aria-label={`View activity for ${entry.name}`}
                      disabled={!target || !props.canOpen(target)}
                      onClick={() => {
                        if (
                          target &&
                          props.canOpen(target) &&
                          openProfileTranscript(target, props.open)
                        )
                          setExpanded(false);
                      }}
                      icon={
                        <Avatar
                          src={avatarMedia(entry.picture, props.session.media)}
                          alt={entry.name}
                          fallback={entry.name}
                          size="small"
                          shape="squircle"
                        />
                      }
                      label={
                        <span
                          className={`text-body-sm ${styles.preview}`}
                          data-error=""
                        >
                          <span>{label(entry)}</span>
                        </span>
                      }
                    />
                  )}
                  {entry.lifecycle && (
                    <span className={styles.action}>
                      {entry.retryable && (
                        <Button
                          size="sm"
                          variant="subtle"
                          aria-label={`Retry ${entry.name}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            retry(entry);
                          }}
                        >
                          Retry
                        </Button>
                      )}
                      <IconButton
                        size="sm"
                        variant="ghost"
                        aria-label={`Dismiss error from ${entry.name}`}
                        icon={<XIcon />}
                        onClick={(event) => {
                          event.stopPropagation();
                          if (message)
                            props.session.agentActivity.dismissError?.(
                              entry.agent,
                              props.channelId,
                              message.id,
                            );
                        }}
                      />
                    </span>
                  )}
                </NavigationCard>
              );
            })}
          </div>
        )}
      </PopoverPopup>
    </PopoverRoot>
  );
}
