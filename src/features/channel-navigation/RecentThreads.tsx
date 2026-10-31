import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  DotsThreeIcon,
  MessageReplyIcon,
  PinIcon,
} from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  NavigationCard,
  NavigationItem,
} from "../../shared/design-system/ui/NavigationItem";
import { NavigationSection } from "../../shared/design-system/ui/NavigationSection";
import {
  ContextMenuRoot,
  ContextMenuTrigger,
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuItem,
} from "../../shared/design-system/ui/Menu";
import type { ChannelSummary } from "../relay/contracts";
import type { Navigation } from "../navigation/controller";
import type { OpenTarget } from "../navigation/targets";
import { conversationTarget } from "./routes";
import type { RecentThread, ThreadNavigation } from "./recent-threads";
import styles from "./RecentThreads.module.css";

export function RecentThreads({
  scope,
  navigator,
  target,
  channels,
  filter,
  store,
}: {
  scope: string;
  navigator: Navigation;
  target: OpenTarget;
  channels: readonly ChannelSummary[];
  filter: "all" | "solo" | "team";
  store: ThreadNavigation;
}) {
  const snapshot = useSyncExternalStore(store.subscribe, store.snapshot);
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== "hidden") void store.refresh();
    };
    refresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [store]);
  const [extra, setExtra] = useState(0);
  const section = useRef<HTMLDivElement>(null);
  const unpinningRow = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const row = unpinningRow.current;
    unpinningRow.current = null;
    if (row && !row.isConnected && document.activeElement === document.body)
      section.current
        ?.querySelector<HTMLButtonElement>("[data-recent-thread]")
        ?.focus();
  });
  const available = new Map(
    channels
      .filter(
        (channel) =>
          !channel.archived && !channel.metadataPending && !channel.cached,
      )
      .map((channel) => [channel.id, channel]),
  );
  const entries = snapshot.entries.filter((item) => {
    const channel = available.get(item.channelId);
    return (
      channel &&
      (filter === "all" ||
        (filter === "solo") === (channel.channelType === "solo"))
    );
  });
  const pins = entries
    .filter((item) => item.pinned)
    .sort((a, b) => (a.pinned ?? 0) - (b.pinned ?? 0));
  const recent = entries.filter((item) => !item.pinned);
  const count = (pins.length >= 8 ? 3 : 8 - pins.length) + extra;
  if (!entries.length && !snapshot.error && !snapshot.writeError) return null;
  return (
    <div ref={section} className={styles.section}>
      <NavigationSection label="Recent">
        {[...pins, ...recent.slice(0, count)].map((item) => (
          <RecentThreadRow
            key={`${item.channelId}:${item.rootId}`}
            item={item}
            channelName={available.get(item.channelId)?.name ?? ""}
            selected={
              target.kind === "conversation" &&
              target.channelId === item.channelId &&
              target.threadRootId === item.rootId
            }
            pending={snapshot.pending.includes(
              `${item.channelId}:${item.rootId}`,
            )}
            toggle={() => {
              if (item.pinned)
                unpinningRow.current =
                  [
                    ...(section.current?.querySelectorAll<HTMLButtonElement>(
                      "[data-recent-thread]",
                    ) ?? []),
                  ].find(
                    (button) =>
                      button.dataset.recentThread ===
                      `${item.channelId}:${item.rootId}`,
                  ) ?? null;
              store.pin(item, !item.pinned);
            }}
            finalFocus={() => {
              const rows = [
                ...(section.current?.querySelectorAll<HTMLButtonElement>(
                  "[data-recent-thread]",
                ) ?? []),
              ];
              return (
                rows.find(
                  (button) =>
                    button.dataset.recentThread ===
                    `${item.channelId}:${item.rootId}`,
                ) ??
                rows[0] ??
                false
              );
            }}
            open={() => {
              const destination = conversationTarget(scope, item.channelId);
              if (destination.kind === "conversation")
                void navigator.open({
                  ...destination,
                  messageId: item.rootId,
                  threadRootId: item.rootId,
                });
            }}
          />
        ))}
        {(recent.length > count || extra > 0) && (
          <div className={styles.actions}>
            {recent.length > count && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setExtra((value) => value + 8)}
              >
                Show more
              </Button>
            )}
            {extra > 0 && (
              <Button
                size="sm"
                variant="ghost"
                onClick={(event) => {
                  event.currentTarget
                    .closest("section")
                    ?.querySelector<HTMLButtonElement>("button")
                    ?.focus();
                  setExtra(0);
                }}
              >
                Show less
              </Button>
            )}
          </div>
        )}
        {(snapshot.error || snapshot.writeError) && (
          <p role="alert" className="text-body-sm text-subtle">
            {snapshot.writeError ?? snapshot.error}{" "}
            <Button size="sm" variant="link" onClick={store.retry}>
              Try again
            </Button>
          </p>
        )}
      </NavigationSection>
    </div>
  );
}

function RecentThreadRow({
  item,
  channelName,
  selected,
  pending,
  toggle,
  finalFocus,
  open,
}: {
  item: RecentThread;
  channelName: string;
  selected: boolean;
  pending: boolean;
  toggle(): void;
  finalFocus(): HTMLElement | false;
  open(): void;
}) {
  const [contextOpen, setContextOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const action = (
    <MenuItem
      disabled={pending}
      onClick={() => {
        setContextOpen(false);
        setMenuOpen(false);
        toggle();
      }}
    >
      {item.pinned ? "Unpin thread" : "Pin thread"}
    </MenuItem>
  );
  return (
    <ContextMenuRoot open={contextOpen} onOpenChange={setContextOpen}>
      <NavigationCard>
        <ContextMenuTrigger
          render={<div />}
          onKeyDown={(event) => {
            if (
              event.key === "ContextMenu" ||
              (event.shiftKey && event.key === "F10")
            ) {
              event.preventDefault();
              setContextOpen(true);
            }
          }}
        >
          <NavigationItem
            data-recent-thread={`${item.channelId}:${item.rootId}`}
            label={
              <span className={styles.label}>
                <span className={styles.title}>{item.title}</span>
                <span className={`text-caption text-subtle ${styles.title}`}>
                  {channelName}
                </span>
              </span>
            }
            multiline
            icon={<MessageReplyIcon size={18} aria-hidden="true" />}
            trailing={
              item.pinned ? (
                <PinIcon
                  size={14}
                  role="img"
                  aria-hidden={false}
                  aria-label="Pinned"
                />
              ) : undefined
            }
            selected={selected}
            onClick={open}
          />
        </ContextMenuTrigger>
        <MenuRoot open={menuOpen} onOpenChange={setMenuOpen}>
          <MenuTrigger
            render={
              <IconButton
                size="compact"
                aria-label={`Actions for ${item.title}`}
                title="Thread actions"
                icon={<DotsThreeIcon size={16} aria-hidden="true" />}
              />
            }
          />
          <MenuPopup size="compact" finalFocus={finalFocus}>
            {action}
          </MenuPopup>
        </MenuRoot>
      </NavigationCard>
      <MenuPopup size="compact" finalFocus={finalFocus}>
        {action}
      </MenuPopup>
    </ContextMenuRoot>
  );
}
