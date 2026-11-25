import type { ComponentProps, ReactNode, Ref } from "react";
import styles from "./Inbox.module.css";
import { AvatarStack } from "../../shared/design-system/ui/AvatarStack";
import { Switch } from "../../shared/design-system/ui/Switch";
import {
  Tabs,
  type TabAction,
  type TabItem,
} from "../../shared/design-system/ui/Tabs";
import {
  AtIcon,
  CheckIcon,
  SmileyIcon,
  ThreadIcon,
} from "../../shared/design-system/icons";

/** What happened: a link or shortcut can open any of these. */
export type ActivityKind = "all" | "threads" | "mentions" | "reactions";
/** Whose activity: Others is everyone outside My team and your agents. */
export type ActivityGroup = "all" | "agents" | "team" | "others";
// All in words, then each kind as an icon named by its tooltip.
const kinds: TabItem<ActivityKind>[] = [
  { value: "all", label: "All" },
  {
    value: "threads",
    label: "Threads",
    icon: <ThreadIcon size="1rem" />,
    labelHidden: true,
  },
  {
    value: "mentions",
    label: "Mentions",
    icon: <AtIcon size="1rem" />,
    labelHidden: true,
  },
  {
    value: "reactions",
    label: "Reactions",
    icon: <SmileyIcon size="1rem" />,
    labelHidden: true,
  },
];

/** A group's unread authors, newest first; undefined while still loading. */
export type GroupSummary =
  | {
      avatars: ComponentProps<typeof AvatarStack>["items"];
      unread: number;
    }
  | undefined;

const unreadText = (unread: number) =>
  unread ? `${unread} unread` : "All read";

/**
 * Who-tabs, each over a summary of what is unread in it, then one-click
 * controls at the end: what happened, and Unread. All counts what is unread;
 * the other tabs show whose it is.
 */
export function InboxFilters({
  group,
  all,
  agents,
  team,
  others,
  myTeam,
  onReselect,
  kind,
  unreadOnly,
  unreadRef,
  onGroupChange,
  onKindChange,
  onUnreadChange,
  status,
}: {
  group: ActivityGroup;
  all: GroupSummary;
  /** Absent hides My agents: it shows only for someone with agents. */
  agents: GroupSummary | null;
  /** Null until a team channel is chosen. */
  team: GroupSummary | null;
  others: GroupSummary;
  myTeam: readonly TabAction[];
  /** Choosing the current tab again, as when leaving My team's setup. */
  onReselect(): void;
  kind: ActivityKind;
  unreadOnly: boolean;
  /** Unread, where focus goes when the control it was on goes away. */
  unreadRef: Ref<HTMLElement>;
  onGroupChange(group: ActivityGroup): void;
  onKindChange(kind: ActivityKind): void;
  onUnreadChange(checked: boolean): void;
  /** Refresh status, between the tabs and the controls so it never adds a line. */
  status?: ReactNode;
}) {
  const summary = (
    value: Exclude<ActivityGroup, "all">,
    label: string,
    shown: GroupSummary | null,
    actions?: readonly TabAction[],
  ): TabItem<ActivityGroup> => ({
    value,
    label,
    ...(actions ? { actions } : {}),
    ...(shown === null
      ? { detail: "Set up", description: "No team yet" }
      : shown === undefined
        ? { detail: null }
        : {
            detail: shown.unread ? (
              <AvatarStack size="small" items={shown.avatars} />
            ) : (
              <>
                <CheckIcon size="0.875rem" />
                All read
              </>
            ),
            description: unreadText(shown.unread),
          }),
  });
  const groups: TabItem<ActivityGroup>[] = [
    {
      value: "all",
      label: "All",
      ...(all
        ? {
            detail: unreadText(all.unread),
            description: unreadText(all.unread),
          }
        : { detail: null }),
    },
    ...(agents === null ? [] : [summary("agents", "My agents", agents)]),
    summary("team", "My team", team, myTeam),
    summary("others", "Others", others),
  ];
  return (
    <div className={styles.filters}>
      <div className={styles.typeTabs}>
        <Tabs
          label="Activity groups"
          variant="panel"
          size="sm"
          value={group}
          items={groups}
          onValueChange={onGroupChange}
          onReselect={onReselect}
        />
      </div>
      {status}
      <div className={styles.quickFilters}>
        <Tabs
          label="Show"
          variant="segmented"
          size="sm"
          value={kind}
          items={kinds}
          onValueChange={onKindChange}
        />
        {/* Reactions have no unread state, so the choice doesn't apply. */}
        <Switch
          ref={unreadRef}
          label="Unread"
          checked={unreadOnly}
          disabled={kind === "reactions"}
          onCheckedChange={onUnreadChange}
        />
      </div>
    </div>
  );
}
