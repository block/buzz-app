import { useConversationPresentation } from "../conversation/ConversationPresentation";
import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import {
  HashArrowInIcon,
  ChatCircleIcon,
  CopyIcon,
  DotsThreeIcon,
  LinkIcon,
} from "../../shared/design-system/icons";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
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

const AfterMenuClose = createContext<
  ((action: () => void) => void) | undefined
>(undefined);
export const useAfterMessageMenuClose = () => useContext(AfterMenuClose);

type Props = {
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

export function MessageActionBar(props: Props) {
  const active = useConversationPresentation();
  return active ? <ActiveMessageActionBar {...props} /> : null;
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

function MessageActionBarControls({
  onSendToChannel,
  onReply,
  replyDisabled,
  link,
  copyText,
  quickControls,
  leadingItems,
  overflowItems,
  messageId,
  menuTriggerRef,
  rowRef,
}: Props) {
  const [open, setOpen] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);
  const slotRef = useRef<HTMLDivElement>(null);
  const floating = useFloatingActionBar(rowRef, barRef, slotRef, open);
  const [copying, setCopying] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean }>();
  const busy = useRef(false);
  const afterClose = useRef<(() => void) | undefined>(undefined);
  const live = useRef(true);
  useLayoutEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      afterClose.current = undefined;
    };
  }, []);
  const [handingOffFocus, setHandingOffFocus] = useState(false);
  const [openedByPointer, setOpenedByPointer] = useState(false);
  const copy = async (text: () => string, label: string) => {
    if (busy.current) return;
    busy.current = true;
    setCopying(true);
    setNotice(undefined);
    try {
      await navigator.clipboard.writeText(text());
      setNotice({ text: `${label} copied`, error: false });
    } catch {
      setNotice({
        text: "Couldn’t copy. Try again from the message menu.",
        error: true,
      });
    } finally {
      busy.current = false;
      setCopying(false);
    }
  };
  return (
    <>
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
              aria-label="Reply"
              title={
                replyDisabled ? "Reply unavailable for this message" : "Reply"
              }
              size="sm"
              disabled={replyDisabled}
              icon={<ChatCircleIcon />}
              onClick={(event) => {
                event.currentTarget.focus();
                onReply();
              }}
            />
          )}
          <IconButton
            aria-label="Copy link"
            title={link ? "Copy link" : "Message link unavailable"}
            size="sm"
            disabled={!link || copying}
            icon={<LinkIcon />}
            onClick={() => {
              if (link) void copy(() => link, "Link");
            }}
          />
          <MenuRoot
            open={open}
            onOpenChange={(next, details) => {
              if (next) {
                setHandingOffFocus(false);
                // Base UI opens on mousedown, so a real pointer press carries a
                // click count; keyboard and assistive presses arrive as a click
                // with 0.
                setOpenedByPointer(
                  details.event instanceof MouseEvent &&
                    details.event.detail > 0,
                );
              } else if (
                details.event.type.startsWith("key") ||
                (details.event.type === "click" &&
                  "detail" in details.event &&
                  details.event.detail === 0)
              ) {
                setOpenedByPointer(false);
              }
              setOpen(next);
            }}
            onOpenChangeComplete={(opened) => {
              if (!opened) {
                const action = afterClose.current;
                afterClose.current = undefined;
                action?.();
              }
            }}
          >
            <MenuTrigger
              render={
                <IconButton
                  ref={menuTriggerRef}
                  aria-label="More message actions"
                  title="More message actions"
                  size="sm"
                  icon={<DotsThreeIcon />}
                />
              }
            />
            <MenuPopup
              align="end"
              data-message-id={messageId}
              // The shared popup preserves moved focus; retirement also revokes
              // return-focus ownership, including a retained hidden source row.
              finalFocus={() =>
                live.current && !handingOffFocus && !openedByPointer
              }
            >
              <AfterMenuClose.Provider
                value={(action) => {
                  setHandingOffFocus(true);
                  afterClose.current = action;
                }}
              >
                {leadingItems}
                <MenuItem
                  disabled={copying}
                  onClick={() => void copy(copyText, "Message")}
                >
                  <MenuIcon>
                    <CopyIcon />
                  </MenuIcon>
                  Copy message
                </MenuItem>
                {onSendToChannel && (
                  <MenuItem
                    onClick={() => {
                      try {
                        onSendToChannel();
                        setNotice({ text: "Sending to channel", error: false });
                      } catch (error) {
                        setNotice({
                          text:
                            error instanceof Error
                              ? error.message
                              : "Couldn’t send to channel",
                          error: true,
                        });
                      }
                    }}
                  >
                    <MenuIcon>
                      <HashArrowInIcon />
                    </MenuIcon>
                    Send to channel
                  </MenuItem>
                )}
                {overflowItems}
              </AfterMenuClose.Provider>
            </MenuPopup>
          </MenuRoot>
        </div>
      </div>
      {notice && (
        <ToastNotice
          title={notice.text}
          tone={notice.error ? "error" : "success"}
          timeout={notice.error ? 0 : 4000}
          onDismiss={() => setNotice(undefined)}
        />
      )}
    </>
  );
}
