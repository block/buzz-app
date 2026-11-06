import type { CompanionAction, CompanionRow } from "./row";
import { useMessageEditScope } from "../messages/MessageEditScope";
import {
  MenuIcon,
  MenuItem,
  MenuSeparator,
} from "../../shared/design-system/ui/Menu";
import {
  ArrowSquareOutIcon,
  BellIcon,
  BellSlashIcon,
  EnvelopeIcon,
  EnvelopeOpenIcon,
  FlagIcon,
  HashArrowInIcon,
  PencilSimpleIcon,
  TrashIcon,
} from "../../shared/design-system/icons";

/** What a companion window can ask main to do with a message. Each entry
 * appears only when main's projected policy allows it; the operation itself
 * is admitted again in main. */
export type CompanionManagementActions = {
  following: boolean;
  isDm: boolean;
  /** An operation on this message is pending or failed. */
  busy(messageId: string): boolean;
  deleteMessage(row: CompanionRow): void;
  sendToChannel(row: CompanionRow): void;
  markRead(row: CompanionRow, unread: boolean): void;
  follow(following: boolean): void;
  report(row: CompanionRow): void;
  /** Hand a plugin action for this message to the main window. */
  handoff(row: CompanionRow, action: CompanionAction): void;
};

/** The same items, labels and icons as the main window's message menu, for
 * the actions main lets this window take on `row`. */
export function CompanionManagementItems({
  row,
  actions,
}: {
  row: CompanionRow;
  actions: CompanionManagementActions;
}) {
  const editor = useMessageEditScope();
  const management = row.management;
  if (!management) return null;
  const busy = actions.busy(row.id);
  return (
    <>
      <MenuItem onClick={() => actions.markRead(row, !management.unread)}>
        <MenuIcon>
          {management.unread ? <EnvelopeOpenIcon /> : <EnvelopeIcon />}
        </MenuIcon>
        {management.unread ? "Mark read" : "Mark unread"}
      </MenuItem>
      {management.canEdit && (
        <MenuItem
          disabled={busy}
          onClick={() => editor?.current?.(toMessage(row))}
        >
          <MenuIcon>
            <PencilSimpleIcon size={14} />
          </MenuIcon>
          Edit message
        </MenuItem>
      )}
      {management.canDelete && (
        <MenuItem disabled={busy} onClick={() => actions.deleteMessage(row)}>
          <MenuIcon>
            <TrashIcon size={14} />
          </MenuIcon>
          Delete message
        </MenuItem>
      )}
      {management.canSendToChannel && (
        <MenuItem disabled={busy} onClick={() => actions.sendToChannel(row)}>
          <MenuIcon>
            <HashArrowInIcon />
          </MenuIcon>
          Send to channel
        </MenuItem>
      )}
      {!actions.isDm && (
        <MenuItem onClick={() => actions.follow(!actions.following)}>
          <MenuIcon>
            {actions.following ? <BellSlashIcon /> : <BellIcon />}
          </MenuIcon>
          {actions.following ? "Unfollow thread" : "Follow thread"}
        </MenuItem>
      )}
      {row.actions?.map((action) => (
        <MenuItem
          key={`${action.key}@${action.revision}`}
          onClick={() => actions.handoff(row, action)}
        >
          <MenuIcon>
            <ArrowSquareOutIcon size={14} />
          </MenuIcon>
          {action.title} in main window
        </MenuItem>
      ))}
      {management.canReport && (
        <>
          <MenuSeparator />
          <MenuItem onClick={() => actions.report(row)}>
            <MenuIcon>
              <FlagIcon />
            </MenuIcon>
            Report
          </MenuItem>
        </>
      )}
    </>
  );
}

/** The `ChannelMessage` shape the shared composer edits: full source text and
 * the attachment source main expects, from the row's projected baseline. */
export function toMessage(row: CompanionRow) {
  return {
    id: row.id,
    channelId: row.channelId,
    authorId: row.authorId,
    createdAt: row.time,
    content: row.text,
    ...(row.editable
      ? {
          sourceContent: row.editable.sourceContent,
          attachmentSourceId: row.editable.attachmentSourceId,
        }
      : {}),
    attachments: row.attachments,
    mentions: row.mentions ?? [],
    ...(row.edited ? { edited: true as const } : {}),
    attachmentSeams: row.attachmentSeams ?? [],
    mentionReferences: row.mentionReferences ?? [],
    reactions: row.reactions ?? [],
    replyCount: 0,
    participants: [],
    ...(row.delivery !== "seen" ? { delivery: row.delivery } : {}),
    ...(row.authorIsAgent ? { agentEnvelope: true as const } : {}),
  };
}
