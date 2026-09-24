import { useRef, useState, type ReactNode, type Ref } from "react";
import {
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
  MenuSeparator,
} from "../../shared/design-system/ui/Menu";
import styles from "./Messages.module.css";

export function MessageActionBar({
  onReply,
  replyDisabled,
  link,
  copyText,
  quickControls,
  overflowItems,
  messageId,
  menuTriggerRef,
}: {
  messageId?: string;
  menuTriggerRef?: Ref<HTMLButtonElement>;
  onReply?: (() => void) | undefined;
  replyDisabled?: boolean | undefined;
  link?: string | undefined;
  copyText(): string;
  quickControls?: ReactNode;
  overflowItems?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [copying, setCopying] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean }>();
  const busy = useRef(false);
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
      {/* biome-ignore lint/a11y/useSemanticElements: This groups message actions, not form fields. */}
      <div
        className={styles.messageActions}
        data-open={open || undefined}
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
        <MenuRoot open={open} onOpenChange={setOpen}>
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
          <MenuPopup align="end" data-message-id={messageId}>
            <MenuItem
              disabled={copying}
              onClick={() => void copy(copyText, "Message")}
            >
              <MenuIcon>
                <CopyIcon />
              </MenuIcon>
              Copy message
            </MenuItem>
            <MenuItem
              disabled={!link || copying}
              onClick={() => {
                if (link) void copy(() => link, "Link");
              }}
            >
              <MenuIcon>
                <LinkIcon />
              </MenuIcon>
              Copy link
            </MenuItem>
            {overflowItems && (
              <>
                <MenuSeparator />
                {overflowItems}
              </>
            )}
          </MenuPopup>
        </MenuRoot>
      </div>
      {notice && (
        <p
          className={styles.messageActionNotice}
          role={notice.error ? "alert" : "status"}
        >
          {notice.text}
        </p>
      )}
    </>
  );
}
