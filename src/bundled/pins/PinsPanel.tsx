import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { ChannelPanelContext } from "../../features/panels/service";
import type { RelaySession } from "../../features/relay/session";
import type { EventData } from "../../features/relay/events";
import { canUnpin, type Pin } from "../../features/pins/protocol";
import { selectProfiles } from "../../features/relay/profile-selection";
import { useProfileGeneration } from "../../features/relay/react";
import { useIdentityNames } from "../../features/identity-names/react";
import { messagePreview } from "../../features/notifications/content";
import { formatPublicKey } from "../../shared/identity/public-key";
import { relativeTimestamp } from "../../shared/relative-timestamp";
import { avatarMedia } from "../../shared/avatar-source";
import {
  PinIcon,
  PinnedOffIcon,
  XIcon,
} from "../../shared/design-system/icons/index";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  PanelHeader,
  PanelHeaderLabel,
} from "../../shared/design-system/ui/PanelHeader";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import { channelPins } from "./store";
import styles from "./Pins.module.css";

const noIds: readonly string[] = [];

export function PinsPanel({
  session,
  context,
  close,
  openMessage,
}: {
  session: RelaySession;
  context: ChannelPanelContext;
  close(): void;
  /** False when the message could not be opened. */
  openMessage(messageId: string): Promise<boolean>;
}) {
  const store = channelPins(session, context.channelId);
  const state = useSyncExternalStore(
    store.subscribe,
    store.snapshot,
    store.snapshot,
  );
  const messages = usePinnedMessages(session, state.pins);
  const authors = useMemo(
    () => [
      ...new Set(
        state.pins.flatMap((pin) => [
          pin.pinnedBy,
          ...(messages.get(pin.messageId)?.pubkey ?? []),
        ]),
      ),
    ],
    [state.pins, messages],
  );
  const profiles = useProfiles(session, authors.length ? authors : noIds);
  const name = useIdentityNames(session.names);
  const notify = useToastNotification();
  const role = session.channels.get?.(context.channelId)?.viewerRole;
  const channel = session.channels.get?.(context.channelId);
  return (
    <div data-buzz-ui="" className={styles.panel}>
      <PanelHeader
        title={
          <PanelHeaderLabel title="Pinned" icon={<PinIcon size="1rem" />}>
            <span
              className={`${styles.channel} text-caption text-secondary`}
              title={context.channelName}
            >
              {context.channelName}
            </span>
          </PanelHeaderLabel>
        }
        actions={
          <IconButton
            hint="familiar"
            size="sm"
            variant="ghost"
            icon={<XIcon size="1rem" aria-hidden="true" />}
            aria-label="Hide pinned messages"
            title="Hide pinned messages"
            onClick={close}
          />
        }
      />
      <div className={styles.scroll}>
        <div className={styles.content}>
          {state.status === "failed" && !state.pins.length ? (
            <p role="alert" className="text-secondary">
              Couldn’t load pinned messages.{" "}
              <button
                type="button"
                className={styles.link}
                onClick={store.retry}
              >
                Try again
              </button>
            </p>
          ) : state.status === "loading" && !state.pins.length ? (
            <p role="status" className="text-secondary">
              Loading pinned messages…
            </p>
          ) : !state.pins.length ? (
            <EmptyState
              icon={<PinIcon />}
              title="No pinned messages"
              description="Pin a message from its More menu to keep it here for everyone in this channel."
            />
          ) : (
            <ul className={styles.list} aria-label="Pinned messages">
              {state.pins.map((pin) => {
                const message = messages.get(pin.messageId);
                const author = message?.pubkey;
                const profile = author ? profiles.get(author) : undefined;
                const sender = author
                  ? name(
                      author,
                      profile?.name ?? formatPublicKey(author) ?? "Unknown",
                      channel?.members,
                    )
                  : "Message";
                const pinner = name(
                  pin.pinnedBy,
                  profiles.get(pin.pinnedBy)?.name ??
                    formatPublicKey(pin.pinnedBy) ??
                    "Someone",
                  channel?.members,
                );
                const preview =
                  message === undefined
                    ? "Loading message…"
                    : message === null
                      ? "This message is no longer available."
                      : messagePreview(message.content);
                return (
                  <li key={pin.id} className={styles.row}>
                    <button
                      type="button"
                      className={styles.open}
                      aria-label={`Open message from ${sender}: ${preview}`}
                      disabled={!message}
                      onClick={() =>
                        void openMessage(pin.messageId).then((opened) => {
                          if (!opened)
                            notify(
                              "This message could not be opened.",
                              "error",
                            );
                        })
                      }
                    >
                      <Avatar
                        size="small"
                        alt=""
                        fallback={sender}
                        src={avatarMedia(profile?.picture, session.media)}
                        shape={profile?.isAgent ? "squircle" : "circle"}
                      />
                      <span className={styles.body}>
                        <span className={styles.meta}>
                          <span className="text-body-strong">{sender}</span>
                          {message && (
                            <span className="text-caption text-secondary">
                              {relativeTimestamp(message.created_at)}
                            </span>
                          )}
                        </span>
                        <span className={styles.preview}>{preview}</span>
                        <span className="text-caption text-secondary">
                          Pinned by {pinner}
                        </span>
                      </span>
                    </button>
                    {canUnpin(pin, session.viewer, role) && (
                      <IconButton
                        size="sm"
                        variant="ghost"
                        icon={<PinnedOffIcon size="1rem" aria-hidden="true" />}
                        aria-label={`Unpin message from ${sender}`}
                        title="Unpin"
                        onClick={() => {
                          try {
                            store.unpin(pin);
                          } catch (error) {
                            notify(
                              error instanceof Error
                                ? error.message
                                : "The message could not be unpinned.",
                              "error",
                            );
                          }
                        }}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

/** Message id → its event, `null` once a read finds it gone, absent while loading. */
function usePinnedMessages(session: RelaySession, pins: readonly Pin[]) {
  const ids = useMemo(() => pins.map((pin) => pin.messageId).sort(), [pins]);
  const key = ids.join(",");
  const [found, setFound] = useState<ReadonlyMap<string, EventData | null>>(
    () => new Map(),
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: `found` only filters what to fetch; refetching when it changes would loop.
  useEffect(() => {
    const missing = key ? key.split(",").filter((id) => !found.has(id)) : [];
    if (!missing.length) return;
    const controller = new AbortController();
    session
      .read([{ ids: missing, limit: missing.length }], {
        signal: controller.signal,
      })
      .then(
        (events) => {
          const byId = new Map(events.map((event) => [event.id, event]));
          setFound((prior) => {
            const next = new Map(prior);
            for (const id of missing) next.set(id, byId.get(id) ?? null);
            return next;
          });
        },
        () => {},
      );
    return () => controller.abort();
  }, [session, key]);
  return found;
}

function useProfiles(session: RelaySession, ids: readonly string[]) {
  const selection = useMemo(
    () => selectProfiles(session.profiles, ids),
    [session, ids],
  );
  const profiles = useSyncExternalStore(
    selection.subscribe,
    selection.snapshot,
    selection.snapshot,
  );
  const generation = useProfileGeneration(session.profiles);
  useEffect(() => {
    void generation;
    if (ids.length)
      void session.profiles.ensure(ids, "background").catch(() => {});
  }, [session, ids, generation]);
  return profiles;
}
