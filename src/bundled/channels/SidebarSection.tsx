import { useId, type ReactNode } from "react";
import { Menu } from "@base-ui/react/menu";
import {
  CaretDownIcon,
  DotsThreeIcon,
  PlusIcon,
} from "../../shared/design-system/icons";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import type { RelaySession } from "../../features/relay/session";
import completion from "../../features/conversation/Completions.module.css";
import { SidebarSectionIcon } from "./SidebarSectionIcon";
import row from "./ChannelSidebarRow.module.css";
import styles from "./Channels.module.css";

export function SidebarSection({
  title,
  icon,
  session,
  open,
  onToggle,
  createChannel,
  newMessage,
  children,
}: {
  title: string;
  icon?: string | undefined;
  session?: RelaySession | undefined;
  open: boolean;
  onToggle: (open: boolean) => void;
  createChannel?:
    | { available: boolean; open: (trigger: HTMLButtonElement) => void }
    | undefined;
  newMessage?: (() => void) | undefined;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <div className={styles.channelSection}>
      <details open={open}>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: summary has native keyboard activation. */}
        <summary
          aria-label={title}
          aria-controls={id}
          onClick={(event) => {
            event.preventDefault();
            onToggle(!open);
          }}
        >
          <span className={styles.sectionLabel}>
            {icon && session && (
              <SidebarSectionIcon icon={icon} session={session} />
            )}
            {title}
          </span>
          <span className={`${styles.sidebarIcon} ${styles.sectionChevron}`}>
            <CaretDownIcon weight="bold" size={15} />
          </span>
        </summary>
        <div id={id} className={styles.sectionContent} inert={!open}>
          <div>{children}</div>
        </div>
      </details>
      <div className={styles.sectionActions}>
        <Menu.Root>
          <Menu.Trigger
            render={
              <IconButton
                size="compact"
                aria-label={`More options for ${title}`}
                icon={<DotsThreeIcon weight="bold" size={15} />}
              />
            }
          />
          <Menu.Portal>
            <Menu.Positioner
              side="bottom"
              align="end"
              sideOffset={4}
              className={row.positioner}
            >
              <Menu.Popup
                className={`${completion.popup} ${row.menu}`}
                data-compact=""
                aria-label={`${title} options`}
              >
                <Menu.Item
                  className={`${completion.option} ${row.menuItem}`}
                  onClick={() => onToggle(!open)}
                >
                  {open ? "Collapse section" : "Expand section"}
                </Menu.Item>
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
        {newMessage && (
          <IconButton
            size="compact"
            aria-label="New message"
            title="New message"
            onClick={newMessage}
            icon={<PlusIcon weight="bold" size={15} />}
          />
        )}
        {createChannel && (
          <IconButton
            size="compact"
            aria-label="Create channel"
            title={
              createChannel.available
                ? "Create channel"
                : "Channel creation unavailable"
            }
            disabled={!createChannel.available}
            onClick={(event) => createChannel.open(event.currentTarget)}
            icon={<PlusIcon weight="bold" size={15} />}
          />
        )}
      </div>
    </div>
  );
}
