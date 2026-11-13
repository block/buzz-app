import type { ReactNode, Ref } from "react";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuGroupLabel,
  MenuSeparator,
} from "../../shared/design-system/ui/Menu";
import {
  BellIcon,
  AtIcon,
  MessageReplyIcon,
  SmileyIcon,
  Filter2Icon,
  UsersIcon,
} from "../../shared/design-system/icons";

export type ActivityFilter =
  | "all"
  | "channels"
  | "threads"
  | "mentions"
  | "dms"
  | "reactions"
  | "direct"
  | "working"
  | "waiting";
export type SenderFilter = "everyone" | "humans" | "agents";
/** The views Activity offers: the same ones as Team's list, for now. */
export const activityViews = [
  { value: "all", label: "All", icon: <BellIcon size={20} /> },
  { value: "threads", label: "Threads", icon: <MessageReplyIcon size={20} /> },
  { value: "dms", label: "DMs", icon: <UsersIcon size={20} /> },
  { value: "mentions", label: "Mentions", icon: <AtIcon size={20} /> },
  { value: "reactions", label: "Reactions", icon: <SmileyIcon size={20} /> },
] as const;
/** Saved filters and old links may name a view that is no longer offered. */
export const offeredActivity = (view: ActivityFilter): ActivityFilter =>
  // Direct was DMs and mentions together.
  view === "direct"
    ? "dms"
    : view === "channels" || view === "working" || view === "waiting"
      ? "all"
      : view;

const senders = [
  { value: "everyone", label: "Anyone" },
  { value: "humans", label: "People" },
  { value: "agents", label: "Agents" },
] as const satisfies readonly { value: SenderFilter; label: string }[];

/** Activity's view selection stays independent of the list's sender/unread menu. */
export function InboxViewFilter({
  view,
  onViewChange,
  leadingAction,
}: {
  view: ActivityFilter;
  onViewChange(view: ActivityFilter): void;
  leadingAction?: ReactNode;
}) {
  return (
    <Tabs
      label="Activity views"
      variant="buttons"
      leadingAction={leadingAction}
      value={view}
      items={activityViews}
      onValueChange={onViewChange}
    />
  );
}

export function InboxFilters({
  sender,
  unreadOnly,
  triggerRef,
  onSenderChange,
  onUnreadChange,
}: {
  sender: SenderFilter;
  unreadOnly: boolean;
  triggerRef: Ref<HTMLButtonElement>;
  onSenderChange(sender: SenderFilter): void;
  onUnreadChange(checked: boolean): void;
}) {
  const from = senders.find((entry) => entry.value === sender) ?? senders[0];
  const fromLabel = `From ${from.label.toLowerCase()}`;
  return (
    <MenuRoot>
      <MenuTrigger
        ref={triggerRef}
        render={
          <IconButton
            size="sm"
            variant="glass"
            shape="round"
            aria-label={fromLabel}
            title={`${fromLabel}${unreadOnly ? ", unread only" : ""}`}
            icon={<Filter2Icon size={16} aria-hidden="true" />}
          />
        }
      />
      <MenuPopup aria-label="Activity filters">
        <MenuRadioGroup
          value={sender}
          onValueChange={(value) => onSenderChange(value as SenderFilter)}
          aria-label="From"
        >
          <MenuGroupLabel>From</MenuGroupLabel>
          {senders.map(({ value, label }) => (
            <MenuRadioItem key={value} value={value} closeOnClick>
              {label}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuRadioGroup
          value={unreadOnly ? "unread" : "all"}
          onValueChange={(value) => onUnreadChange(value === "unread")}
          aria-label="Show"
        >
          <MenuGroupLabel>Show</MenuGroupLabel>
          <MenuRadioItem value="all" closeOnClick>
            All activity
          </MenuRadioItem>
          <MenuRadioItem value="unread" closeOnClick>
            Unread only
          </MenuRadioItem>
        </MenuRadioGroup>
      </MenuPopup>
    </MenuRoot>
  );
}
