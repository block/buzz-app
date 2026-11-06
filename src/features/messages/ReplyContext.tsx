import type { ChannelMessage } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import { useRowProfiles } from "../relay/react";
import { useChannelIdentityNames } from "../identity-names/react";
import { formatPublicKey } from "../../shared/identity/public-key";
import { workflowLabel } from "../relay/workflow-attribution";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { XIcon } from "../../shared/design-system/icons";
import { avatarMedia } from "../../shared/avatar-source";
import styles from "./Messages.module.css";

/** The same cancelable reply preview in channel and thread composers. */
export function ReplyContext({
  row,
  session,
  onCancel,
}: {
  row: ChannelMessage;
  session: RelaySession;
  onCancel(): void;
}) {
  const profiles = useRowProfiles(session.profiles, [row]);
  const resolveName = useChannelIdentityNames(session, row.channelId);
  const id = row.workflowOwnerId ?? row.authorId;
  const author = resolveName(
    id,
    profiles.get(id)?.name ?? formatPublicKey(id) ?? "Unknown author",
  );
  const name = row.workflowOwnerId ? workflowLabel(author) : author;
  return (
    <div className={styles.replyContext}>
      <Avatar
        src={avatarMedia(profiles.get(row.authorId)?.picture, session.media)}
        alt=""
        fallback={name}
        size="default"
      />
      <div>
        <span>Replying to {name}</span>
        <p>{row.content}</p>
      </div>
      <IconButton
        size="sm"
        aria-label="Cancel reply target"
        onClick={onCancel}
        icon={<XIcon size={16} aria-hidden="true" />}
      />
    </div>
  );
}
