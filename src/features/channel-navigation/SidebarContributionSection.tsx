import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type ReactElement,
  type ReactNode,
} from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { SpringLoadedNavigationItem } from "./SpringLoadedNavigationItem";
import { OwnedContribution } from "../../plugins/OwnedContribution";
import styles from "../../bundled/channels/Channels.module.css";
import type { Navigation } from "../navigation/controller";
import { targetKey, type OpenTarget } from "../navigation/targets";
import type {
  RegisteredSidebarSection,
  SidebarSections,
} from "./sidebar-sections-service";
import { DroppableSidebarSection } from "./ChannelSidebarDnd";
import { sidebarTarget } from "./routes";

/** What the sidebar knows about a row that opens a conversation: whether it is
 * unread, who is working in it, and its right-click menu. Channels supplies it,
 * so a card's rows read as the sidebar's own. */
export type ContributionConversationRow = ComponentType<{
  channelId: string;
  /** A thread row's root message. */
  rootId: string | undefined;
  /** The row's label, which a thread row's menu copies. */
  label: string;
  onOpen(): void;
  children: (
    state: Readonly<{ unread: boolean; working: ReactNode }>,
  ) => ReactElement;
}>;

const noSubscribe = () => () => {};
const noLayout = () => "";

function isSelectedDestination(destination: OpenTarget, target: OpenTarget) {
  const selectedKey = targetKey(target);
  if (targetKey(destination) === selectedKey) return true;
  // A thread row stays selected wherever in its thread the reader is.
  if (destination.kind === "conversation" && destination.threadRootId)
    return (
      target.kind === "conversation" &&
      target.scope?.viewer === destination.scope?.viewer &&
      target.scope?.communityOrigin === destination.scope?.communityOrigin &&
      target.channelId === destination.channelId &&
      (target.threadRootId ?? target.inline) === destination.threadRootId
    );
  if (
    destination.kind === "conversation" &&
    target.kind === "conversation" &&
    destination.messageId === undefined &&
    destination.panel === undefined
  ) {
    const conversationKey = (conversation: typeof destination) =>
      targetKey({
        version: 1,
        kind: "conversation",
        scope: conversation.scope,
        channelId: conversation.channelId,
      });
    return conversationKey(destination) === conversationKey(target);
  }
  if (
    destination.kind !== "page" ||
    target.kind !== "page" ||
    destination.scope !== undefined ||
    target.scope === undefined ||
    target.scope === null
  )
    return false;

  // An omitted page scope retains the current community.
  return targetKey({ ...destination, scope: target.scope }) === selectedKey;
}

export function SidebarContributionSection({
  entry,
  registry,
  navigator,
  target,
  open,
  onToggle,
  groupIndex,
  reorderable,
  move,
  onRowsCommitted,
  resizeScope,
  conversationRow,
}: {
  entry: RegisteredSidebarSection;
  registry: SidebarSections;
  navigator: Navigation;
  target: OpenTarget;
  open: boolean;
  onToggle: (open: boolean) => void;
  groupIndex: number;
  reorderable: boolean;
  move: { up?: () => void; down?: () => void } | undefined;
  onRowsCommitted?: () => void;
  /** Where its height is kept, as the sidebar's other cards keep theirs. */
  resizeScope?: string | undefined;
  conversationRow?: ContributionConversationRow | undefined;
}) {
  // A failed section stops observing its rows; Retry renders it again.
  const [attempt, setAttempt] = useState(0);
  const retry = useRef<HTMLButtonElement>(null);
  const sectionKey = `plugin:${entry.key}`;
  useLayoutEffect(() => {
    // Retry remounts the section: focus the new Retry, or the recovered header.
    if (!attempt || document.activeElement !== document.body) return;
    (
      retry.current ??
      document.querySelector<HTMLElement>(
        `[data-sidebar-section="${CSS.escape(sectionKey)}"] details > summary`,
      )
    )?.focus({ preventScroll: true });
  }, [attempt, sectionKey]);
  return (
    <OwnedContribution
      entry={entry}
      registry={registry}
      resetIdentity={attempt}
      fallback={
        <DroppableSidebarSection
          disabled={false}
          reorderable={reorderable}
          groupIndex={groupIndex}
          groupDomain="contributions"
          sectionKey={sectionKey}
          title={entry.title}
          open={open}
          onToggle={onToggle}
          move={move}
          hideMoreActions={!reorderable}
        >
          <p role="alert">
            {entry.title} is unavailable. Other sidebar sections remain
            available.
          </p>
          <Button
            ref={retry}
            size="sm"
            onClick={() => setAttempt((count) => count + 1)}
          >
            Retry
          </Button>
        </DroppableSidebarSection>
      }
    >
      {(section, active) => (
        <SectionContents
          entry={section}
          active={active}
          navigator={navigator}
          target={target}
          open={open}
          onToggle={onToggle}
          groupIndex={groupIndex}
          reorderable={reorderable}
          move={move}
          onRowsCommitted={onRowsCommitted}
          resizeScope={resizeScope}
          conversationRow={conversationRow}
        />
      )}
    </OwnedContribution>
  );
}

function SectionContents({
  entry,
  active,
  navigator,
  target,
  open,
  onToggle,
  groupIndex,
  reorderable,
  move,
  onRowsCommitted,
  resizeScope,
  conversationRow: ConversationRow,
}: {
  entry: RegisteredSidebarSection;
  active: () => boolean;
  navigator: Navigation;
  target: OpenTarget;
  open: boolean;
  onToggle: (open: boolean) => void;
  groupIndex: number;
  reorderable: boolean;
  move: { up?: () => void; down?: () => void } | undefined;
  onRowsCommitted: (() => void) | undefined;
  resizeScope: string | undefined;
  conversationRow: ContributionConversationRow | undefined;
}) {
  const subscribe = useCallback(
    (listener: () => void) => entry.rows.subscribe(listener),
    [entry.rows],
  );
  const snapshot = useCallback(() => entry.rows.snapshot(), [entry.rows]);
  const rows = useSyncExternalStore(subscribe, snapshot, snapshot);
  // The sidebar's target names only the open conversation; a row may name a
  // message or thread in it. Elsewhere, as under Settings, keep the target:
  // there a conversation's rows stay current, but a message's do not.
  const current = useSyncExternalStore(navigator.subscribe, () => {
    const open = navigator.snapshot().entry.target;
    return targetKey(sidebarTarget(open)) === targetKey(target) ? open : target;
  });
  // The external-store update rerenders this child, not the reveal owner.
  useLayoutEffect(() => {
    onRowsCommitted?.();
  });
  const [actionError, setActionError] = useState(false);
  if (!Array.isArray(rows)) throw new Error("Sidebar rows must be an array");
  const ids = new Set<string>();
  for (const row of rows) {
    if (
      !row ||
      typeof row.id !== "string" ||
      !row.id ||
      ids.has(row.id) ||
      typeof row.label !== "string" ||
      !row.label.trim() ||
      (row.detail !== undefined && typeof row.detail !== "string")
    )
      throw new Error("Sidebar rows need unique ids and non-empty labels");
    ids.add(row.id);
  }
  const select = (destination: OpenTarget) => {
    if (!active()) return;
    setActionError(false);
    try {
      void navigator.open(destination).catch(() => setActionError(true));
    } catch {
      setActionError(true);
    }
  };
  const layouts = entry.layouts;
  const layoutValue = useSyncExternalStore(
    layouts?.subscribe ?? noSubscribe,
    layouts?.snapshot ?? noLayout,
    layouts?.snapshot ?? noLayout,
  );
  const layout = layouts && {
    value: layoutValue,
    options: layouts.options,
    set: layouts.select,
  };
  const actions = (entry.actions ?? []).map((action) => (
    <IconButton
      key={action.id}
      size="compact"
      aria-label={action.label}
      title={action.label}
      icon={action.icon}
      onClick={() => {
        if (!active()) return;
        setActionError(false);
        try {
          void Promise.resolve(action.onSelect()).catch(() =>
            setActionError(true),
          );
        } catch {
          setActionError(true);
        }
      }}
    />
  ));
  return (
    <DroppableSidebarSection
      groupDomain="contributions"
      disabled={false}
      reorderable={reorderable}
      groupIndex={groupIndex}
      sectionKey={`plugin:${entry.key}`}
      title={entry.title}
      icon={entry.icon}
      open={open}
      onToggle={onToggle}
      move={move}
      hideMoreActions={!reorderable}
      headerActions={actions}
      layout={layout}
      resizeScope={resizeScope}
      headerNotice={
        actionError && (
          <p className={styles.contributionFeedback} role="alert">
            This sidebar action couldn’t finish.
          </p>
        )
      }
    >
      {entry.body ? <entry.body active={active} target={current} /> : null}
      {rows.map((row) => {
        const trailing = [
          row.badge,
          typeof row.count === "number" && Number.isFinite(row.count)
            ? new Intl.NumberFormat().format(row.count)
            : undefined,
          row.status,
        ]
          .filter((value) => typeof value === "string" && value.trim())
          .join(" · ");
        const destination = entry.select(row);
        const detail = row.detail?.trim();
        const item = (
          state?: Readonly<{ unread: boolean; working: ReactNode }>,
        ) => (
          <div
            key={row.id}
            className={styles.contributionNavigationItem}
            data-ordinary={state?.unread || undefined}
          >
            <SpringLoadedNavigationItem
              label={
                <span className={styles.contributionLabel}>
                  <span className={styles.contributionTitle}>{row.label}</span>
                  {detail && (
                    <span className={styles.contributionDetail}>{detail}</span>
                  )}
                </span>
              }
              multiline={!!detail}
              icon={row.icon}
              trailing={
                state?.working ||
                (trailing ? (
                  <span className={styles.contributionMetadata}>
                    {trailing}
                  </span>
                ) : undefined)
              }
              selected={isSelectedDestination(destination, current)}
              onClick={() => select(destination)}
              // Only a conversation has a composer for the dragged files.
              onSpring={
                destination.kind === "conversation"
                  ? () => select(destination)
                  : undefined
              }
            />
          </div>
        );
        // A plain conversation or a thread reads as the sidebar's own rows; a
        // message or panel in it is somewhere else.
        return ConversationRow &&
          destination.kind === "conversation" &&
          destination.panel === undefined &&
          (destination.messageId === undefined ||
            destination.messageId === destination.threadRootId) ? (
          <ConversationRow
            key={row.id}
            channelId={destination.channelId}
            rootId={destination.threadRootId}
            label={row.label}
            onOpen={() => select(destination)}
          >
            {item}
          </ConversationRow>
        ) : (
          item()
        );
      })}
    </DroppableSidebarSection>
  );
}
