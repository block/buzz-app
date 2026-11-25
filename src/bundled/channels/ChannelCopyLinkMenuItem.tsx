import { LinkIcon } from "../../shared/design-system/icons";
import { MenuIcon, MenuItem } from "../../shared/design-system/ui/Menu";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import { writeClipboardText } from "../../shared/clipboard";
import { communityShareLink } from "../../features/navigation/buzz-links";
import { splitPartition } from "../../features/relay/partition";

/** The channel's https link on community `scope`'s relay, which opens it in
 * Buzz. */
export function ChannelCopyLinkMenuItem({
  channelId,
  scope,
}: {
  channelId: string;
  scope: string;
}) {
  const notify = useToastNotification();
  return (
    <MenuItem
      onClick={() => {
        const link = `buzz://channel/${encodeURIComponent(channelId)}`;
        writeClipboardText(
          communityShareLink(link, splitPartition(scope)?.communityOrigin) ??
            link,
        ).then(
          () => notify("Link copied.", "success"),
          () => notify("Couldn’t copy the link.", "error"),
        );
      }}
    >
      <MenuIcon>
        <LinkIcon size={14} />
      </MenuIcon>
      Copy link
    </MenuItem>
  );
}
