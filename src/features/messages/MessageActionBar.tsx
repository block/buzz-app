import { useConversationPresentation } from "../conversation/ConversationPresentation";
import {
  createContext,
  useContext,
  useLayoutEffect,
  useId,
  useSyncExternalStore,
  useRef,
  useState,
  type ReactNode,
  type ReactElement,
  type Ref,
  type RefObject,
  type ComponentProps,
} from "react";
import {
  HashArrowInIcon,
  MessageReplyIcon,
  CopyIcon,
  DotsThreeIcon,
  LinkIcon,
} from "../../shared/design-system/icons";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  ContextMenuRoot,
  ContextMenuTrigger,
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuIcon,
} from "../../shared/design-system/ui/Menu";
import { ToastNotice } from "../../shared/design-system/ui/Toast";
import styles from "./Messages.module.css";
import {
  useFloatingActionBar,
  useMessageActionBarReady,
} from "./useFloatingActionBar";

// An explicit rejection keeps the popup's normal final-focus ownership.
// Ordinary void callbacks still hand focus to their destination.
type MessageMenuAction = (() => void) | (() => false);
const AfterMenuClose = createContext<
  ((action: MessageMenuAction) => void) | undefined
>(undefined);
export const useAfterMessageMenuClose = () => useContext(AfterMenuClose);

type Props = {
  /** A coordination row is the context-menu target instead of a toolbar. */
  children?: ReactElement | undefined;
  rowRef?: RefObject<HTMLDivElement | null>;
  messageId?: string;
  menuTriggerRef?: Ref<HTMLButtonElement>;
  onSendToChannel?: (() => void) | undefined;
  onReply?: (() => void) | undefined;
  replyDisabled?: boolean | undefined;
  link?: string | undefined;
  copyText(): string;
  quickControls?: ReactNode;
  /** Menu items rendered above the built-in actions. */
  leadingItems?: ReactNode;
  overflowItems?: ReactNode;
};

type Notice = { text: string; error: boolean };
type RowState = {
  selected: boolean;
  open: boolean;
  copying: boolean;
  notice?: Notice | undefined;
};
const idleRow: RowState = Object.freeze({
  selected: false,
  open: false,
  copying: false,
});
type Registration = {
  id: string;
  owner: MessageActionController;
  context?: Pick<Selection, "contextAnchor" | "contextFocus"> | undefined;
  props: Props;
  live: boolean;
  state: RowState;
  listeners: Set<() => void>;
};
type Selection = {
  row: Registration;
  kind: "menu" | "context";
  open: boolean;
  openedByPointer: boolean;
  handingOff: boolean;
  contextAnchor?: HTMLElement | undefined;
  contextFocus?: HTMLElement | null | undefined;
};

/** One open surface, with independent clipboard operations for each source row. */
class MessageActionController {
  readonly rows = new Map<string, Registration>();
  readonly listeners = new Set<() => void>();
  readonly pending = new Map<Registration, object>();
  selection: Selection | undefined;
  private closed: Selection | undefined;
  private afterClose:
    | { selection: Selection; action: MessageMenuAction }
    | undefined;
  presented = true;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  readonly snapshot = () => this.selection;

  private rowState(row: Registration, patch: Partial<RowState>) {
    row.state = { ...row.state, ...patch };
    for (const listener of row.listeners) listener();
  }
  private publish() {
    for (const listener of this.listeners) listener();
  }
  mount(row: Registration) {
    row.live = true;
    this.rows.set(row.id, row);
    return () => {
      row.live = false;
      this.rows.delete(row.id);
      this.pending.delete(row);
      if (this.closed?.row === row) this.closed = undefined;
      if (this.selection?.row === row) {
        this.afterClose = undefined;
        this.selection = undefined;
        this.publish();
      }
      row.state = idleRow;
    };
  }
  retire() {
    this.afterClose = undefined;
    this.closed = undefined;
    this.selection = undefined;
    this.pending.clear();
    for (const row of this.rows.values()) {
      if (row.state !== idleRow)
        this.rowState(row, { ...idleRow, notice: undefined });
    }
    this.publish();
  }
  change(
    row: Registration,
    kind: Selection["kind"],
    open: boolean,
    event?: Event,
    context?: Pick<Selection, "contextAnchor" | "contextFocus">,
  ) {
    if (!row.live || !this.presented) return;
    const previous = this.selection;
    if (!open) {
      if (previous?.row !== row || previous.kind !== kind || !previous.open)
        return;
      // Preserve this lifetime through Base UI's closing phase and final focus.
      previous.open = false;
      if (
        event?.type.startsWith("key") ||
        (event?.type === "click" && "detail" in event && event.detail === 0)
      )
        previous.openedByPointer = false;
      this.selection = { ...previous };
      if (this.afterClose?.selection === previous)
        this.afterClose.selection = this.selection;
      this.rowState(row, { open: false });
      this.publish();
      return;
    }
    this.closed = undefined;
    this.afterClose = undefined;
    if (previous && previous.row !== row)
      this.rowState(previous.row, { selected: false, open: false });
    this.selection = {
      row,
      kind,
      open: true,
      handingOff: false,
      openedByPointer: event instanceof MouseEvent && event.detail > 0,
      ...context,
    };
    this.rowState(row, { selected: true, open: true });
    this.publish();
  }
  complete(kind: Selection["kind"], row?: Registration) {
    const selected = this.selection;
    if (
      !selected ||
      selected.kind !== kind ||
      selected.open ||
      (row && selected.row !== row)
    )
      return;
    const handoff = this.afterClose;
    this.afterClose = undefined;
    try {
      if (
        handoff?.selection === selected &&
        selected.row.live &&
        this.presented &&
        handoff.action() === false
      )
        selected.handingOff = false;
    } finally {
      // A synchronous handoff can retire this source or open another target.
      // Settle rejection before popup teardown resolves its final-focus callback.
      if (this.selection === selected) {
        this.closed = selected;
        this.selection = undefined;
        this.rowState(selected.row, { selected: false, open: false });
        this.publish();
      }
    }
  }
  defer(row: Registration, action: MessageMenuAction) {
    const selected = this.selection;
    if (!selected || selected.row !== row || !row.live || !this.presented)
      return;
    selected.handingOff = true;
    this.afterClose = { selection: selected, action };
  }
  finalFocus(row: Registration, selected: Selection | undefined) {
    if (
      !selected ||
      selected.row !== row ||
      !row.live ||
      !this.presented ||
      selected.handingOff ||
      (this.selection !== selected && this.closed !== selected)
    )
      return false;
    return selected.kind === "context"
      ? selected.contextFocus?.isConnected
        ? selected.contextFocus
        : false
      : !selected.openedByPointer;
  }
  sendToChannel(row: Registration) {
    const send = row.props.onSendToChannel;
    if (!row.live || !this.presented || !send) return;
    try {
      send();
      this.rowState(row, {
        notice: { text: "Sending to channel", error: false },
      });
    } catch (error) {
      this.rowState(row, {
        notice: {
          text:
            error instanceof Error ? error.message : "Couldn’t send to channel",
          error: true,
        },
      });
    }
  }
  dismiss(row: Registration) {
    this.rowState(row, { notice: undefined });
  }
  async copy(row: Registration, kind: "message" | "link") {
    if (!row.live || !this.presented || this.pending.has(row)) return;
    if (kind === "link" && row.props.link === undefined) return;
    const operation = {};
    this.pending.set(row, operation);
    this.rowState(row, { copying: true, notice: undefined });
    let notice: Notice;
    try {
      await navigator.clipboard.writeText(
        kind === "message" ? row.props.copyText() : (row.props.link ?? ""),
      );
      notice = {
        text: `${kind === "message" ? "Message" : "Link"} copied`,
        error: false,
      };
    } catch {
      notice = {
        text: "Couldn’t copy. Try again from the message menu.",
        error: true,
      };
    }
    // Switching the menu never transfers a pending result to its new source.
    if (this.pending.get(row) !== operation) return;
    this.pending.delete(row);
    if (row.live && this.presented)
      this.rowState(row, { copying: false, notice });
  }
}
const ActionOwner = createContext<MessageActionController | undefined>(
  undefined,
);
type MenuActions = NonNullable<
  ComponentProps<typeof MenuRoot>["actionsRef"]
>["current"];

/** Recovery and the action lifetime share the conversation boundary, not a virtual row. */
export function MessageActionOwner({
  children,
  session,
  channelId,
}: {
  children: ReactNode;
  session?: object | undefined;
  channelId?: string | undefined;
}) {
  const presented = useConversationPresentation();
  const [lifetime, setLifetime] = useState(() => ({
    session,
    channelId,
    controller: new MessageActionController(),
  }));
  if (lifetime.session !== session || lifetime.channelId !== channelId)
    setLifetime({
      session,
      channelId,
      controller: new MessageActionController(),
    });
  const controller = lifetime.controller;
  const selected = useSyncExternalStore(
    controller.subscribe,
    controller.snapshot,
    controller.snapshot,
  );
  const menuActions = useRef<MenuActions>(null);
  useLayoutEffect(() => {
    // A removed/retired row takes its popup with it, so there is no exit
    // animation left to finish the surviving Root's closing lifetime.
    // Ordinary selected menus retain their normal animation and handoff.
    if (selected?.kind !== "menu") menuActions.current?.unmount();
  }, [selected]);
  useLayoutEffect(() => {
    controller.presented = presented;
    if (!presented) controller.retire();
    return () => {
      controller.presented = false;
      controller.retire();
    };
  }, [controller, presented]);
  return (
    <ActionOwner value={controller}>
      <MenuRoot
        actionsRef={menuActions}
        open={selected?.kind === "menu" && selected.open}
        triggerId={selected?.kind === "menu" ? selected.row.id : null}
        onOpenChange={(open, details) => {
          const row = details.trigger
            ? controller.rows.get(details.trigger.id)
            : controller.selection?.row;
          if (!row || !controller.presented) {
            details.cancel();
            return;
          }
          controller.change(row, "menu", open, details.event);
        }}
        onOpenChangeComplete={(open) => {
          if (!open) controller.complete("menu");
        }}
      >
        {children}
      </MenuRoot>
    </ActionOwner>
  );
}

export function MessageActionBar(props: Props) {
  const controller = useContext(ActionOwner);
  const active = useConversationPresentation();
  if (!controller)
    return (
      <MessageActionOwner>
        <MessageActionBar {...props} />
      </MessageActionOwner>
    );
  return active ? (
    props.children ? (
      <MessageActionBarControls {...props} />
    ) : (
      <ActiveMessageActionBar {...props} />
    )
  ) : (
    (props.children ?? null)
  );
}

function ActiveMessageActionBar(props: Props) {
  const ready = useMessageActionBarReady(props.rowRef);
  return ready ? (
    <MessageActionBarControls {...props} />
  ) : (
    <div className={styles.messageActionsSlot}>
      {/* biome-ignore lint/a11y/useSemanticElements: This groups message actions, not form fields. */}
      <div
        className={styles.messageActions}
        role="group"
        aria-label="Message actions"
      />
    </div>
  );
}

function MessageActionBarControls(props: Props) {
  const {
    children,
    onSendToChannel,
    onReply,
    replyDisabled,
    link,
    quickControls,
    leadingItems,
    overflowItems,
    messageId,
    menuTriggerRef,
    rowRef,
  } = props;
  const controller = useContext(ActionOwner);
  if (!controller)
    throw new Error("Message actions require their conversation owner");
  const id = useId();
  const [registration, setRegistration] = useState<Registration>(() => ({
    id,
    owner: controller,
    props,
    live: false,
    state: idleRow,
    listeners: new Set(),
  }));
  if (
    registration.owner !== controller ||
    registration.props.messageId !== messageId
  )
    setRegistration({
      id,
      owner: controller,
      props,
      live: false,
      state: idleRow,
      listeners: new Set(),
    });
  useLayoutEffect(
    () => controller.mount(registration),
    [controller, registration],
  );
  useLayoutEffect(() => {
    registration.props = props;
  });
  const state = useSyncExternalStore(
    (listener) => {
      registration.listeners.add(listener);
      return () => {
        registration.listeners.delete(listener);
      };
    },
    () => registration.state,
    () => idleRow,
  );
  const { open, copying, notice } = state;
  const selected = state.selected ? controller.selection : undefined;
  const barRef = useRef<HTMLDivElement>(null);
  const slotRef = useRef<HTMLDivElement>(null);
  const floating = useFloatingActionBar(
    children ? undefined : rowRef,
    barRef,
    slotRef,
    open,
  );
  const copy = (kind: "message" | "link") =>
    controller.copy(registration, kind);
  const popup = selected && (
    <MenuPopup
      align={children ? "start" : "end"}
      anchor={selected.contextAnchor}
      data-message-id={messageId}
      // The shared popup preserves moved focus; retirement also revokes
      // return-focus ownership, including a retained hidden source row.
      finalFocus={() => controller.finalFocus(registration, selected)}
    >
      <AfterMenuClose.Provider
        value={(action) => {
          controller.defer(registration, action);
        }}
      >
        {leadingItems}
        <MenuItem disabled={copying} onClick={() => void copy("message")}>
          <MenuIcon>
            <CopyIcon />
          </MenuIcon>
          Copy message
        </MenuItem>
        {onSendToChannel && (
          <MenuItem onClick={() => controller.sendToChannel(registration)}>
            <MenuIcon>
              <HashArrowInIcon />
            </MenuIcon>
            Send to channel
          </MenuItem>
        )}
        {children && onReply && (
          <MenuItem
            disabled={replyDisabled}
            onClick={() => {
              controller.defer(registration, () => {
                const reply = registration.props.onReply;
                if (registration.props.replyDisabled || !reply) return false;
                reply();
              });
            }}
          >
            <MenuIcon>
              <MessageReplyIcon />
            </MenuIcon>
            Reply
          </MenuItem>
        )}
        {children && (
          <MenuItem
            disabled={!link || copying}
            onClick={() => {
              if (link) void copy("link");
            }}
          >
            <MenuIcon>
              <LinkIcon />
            </MenuIcon>
            Copy link
          </MenuItem>
        )}
        {overflowItems}
      </AfterMenuClose.Provider>
    </MenuPopup>
  );
  return (
    <>
      {children ? (
        <ContextMenuRoot
          open={selected?.kind === "context" && open}
          onOpenChange={(next, details) =>
            controller.change(
              registration,
              "context",
              next,
              details.event,
              registration.context,
            )
          }
          onOpenChangeComplete={(next) => {
            if (!next) controller.complete("context", registration);
          }}
        >
          <ContextMenuTrigger
            render={children}
            onContextMenu={(event) => {
              if (!event.currentTarget.contains(event.target as Node)) {
                event.preventBaseUIHandler();
                return;
              }
              registration.context = {
                contextFocus: event.currentTarget.querySelector("button"),
              };
            }}
            onTouchStart={(event) => {
              if (!event.currentTarget.contains(event.target as Node)) {
                event.preventBaseUIHandler();
                return;
              }
              registration.context = {
                contextFocus: event.currentTarget.querySelector("button"),
              };
            }}
            onKeyDown={(event) => {
              if (
                event.defaultPrevented ||
                !event.currentTarget.contains(event.target as Node)
              )
                return;
              if (
                event.key === "ContextMenu" ||
                (event.shiftKey && event.key === "F10")
              ) {
                event.preventDefault();
                registration.context = {
                  contextFocus: event.target as HTMLElement,
                  contextAnchor: event.currentTarget,
                };
                controller.change(
                  registration,
                  "context",
                  true,
                  event.nativeEvent,
                  registration.context,
                );
              }
            }}
          />
          {popup}
        </ContextMenuRoot>
      ) : (
        <div ref={slotRef} className={styles.messageActionsSlot}>
          {/* biome-ignore lint/a11y/useSemanticElements: This groups message actions, not form fields. */}
          <div
            className={styles.messageActions}
            ref={barRef}
            popover={floating ? "manual" : undefined}
            role="group"
            aria-label="Message actions"
          >
            {quickControls}
            {onReply && (
              <IconButton
                hint={replyDisabled ? "helpful" : "familiar"}
                aria-label="Reply"
                title={
                  replyDisabled ? "Reply unavailable for this message" : "Reply"
                }
                size="sm"
                disabled={replyDisabled}
                icon={<MessageReplyIcon />}
                onClick={(event) => {
                  event.currentTarget.focus();
                  if (!registration.props.replyDisabled)
                    registration.props.onReply?.();
                }}
              />
            )}
            <IconButton
              hint={link ? "familiar" : "helpful"}
              aria-label="Copy link"
              title={link ? "Copy link" : "Message link unavailable"}
              size="sm"
              disabled={!link || copying}
              icon={<LinkIcon />}
              onClick={() => {
                if (link) void copy("link");
              }}
            />
            <MenuTrigger
              id={registration.id}
              render={
                <IconButton
                  hint="familiar"
                  ref={menuTriggerRef}
                  aria-label="More message actions"
                  title="More message actions"
                  size="sm"
                  icon={<DotsThreeIcon />}
                />
              }
            />
            {popup}
          </div>
        </div>
      )}
      {notice && (
        <ToastNotice
          title={notice.text}
          tone={notice.error ? "error" : "success"}
          timeout={notice.error ? 0 : 4000}
          onDismiss={() => controller.dismiss(registration)}
        />
      )}
    </>
  );
}
