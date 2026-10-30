import { useMemo, type ReactNode } from "react";
import { useDroppable } from "@dnd-kit/core";
import type { RelaySession } from "../relay/session";
import { useChannelList } from "../relay/react";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { SidebarItems } from "./SidebarItems";
import { SidebarRowInset } from "./sidebar-presentation";
import styles from "./SidebarConversationList.module.css";

/** Inventories retain row actions, access policy, and saved filing. */
export type UnfiledConversation = {
  id: string;
  scope: "solo" | "team";
  content: ReactNode;
  selected?: boolean | undefined;
};

export function SidebarConversationList({
  session,
  rows,
  scope,
  draft,
  revealId,
  selectedId,
  children,
}: {
  session: RelaySession;
  rows: readonly UnfiledConversation[];
  scope: "solo" | "team";
  draft?: ReactNode;
  revealId?: string | undefined;
  selectedId?: string | undefined;
  children?: ReactNode;
}) {
  const list = useChannelList(session.channels);
  const sorted = useMemo(() => {
    const activity = new Map(
      list.channels.map((channel) => [
        channel.id,
        channel.lastActivityAt ?? channel.updatedAt ?? 0,
      ]),
    );
    return [...rows].sort(
      (a, b) =>
        (activity.get(b.id) ?? 0) - (activity.get(a.id) ?? 0) ||
        a.id.localeCompare(b.id),
    );
  }, [rows, list.channels]);
  const title = scope === "solo" ? "Sessions" : "Team messages";
  const drop = useDroppable({
    id: scope === "solo" ? "project:" : "channels",
    data: { groupDomain: scope === "solo" ? "solo" : "channels" },
    disabled: !(scope === "solo"
      ? session.soloPreferences.writable
      : session.sidebarPreferences.writable),
  });
  return (
    <section className={styles.section} aria-label={title}>
      <div ref={drop.setNodeRef}>
        <div className={styles.heading}>
          <InlineHeader title={title} />
        </div>
        <SidebarRowInset value={false}>
          {draft}
          <SidebarItems
            items={sorted}
            label={title}
            revealId={revealId}
            selectedId={selectedId}
            expandAll
          >
            {(row) => row.content}
          </SidebarItems>
        </SidebarRowInset>
        {!rows.length && !draft && (
          <p className={styles.empty}>
            {scope === "solo" ? "No sessions yet." : "No messages yet."}
          </p>
        )}
      </div>
      {children}
    </section>
  );
}
