import { useRef, useState, useSyncExternalStore } from "react";
import type { ChannelMessage } from "../../features/relay/contracts";
import { useChannelList } from "../../features/relay/react";
import type { RelaySession } from "../../features/relay/session";
import type { RelayData } from "../../features/relay/service";
import { ownSolo } from "../../features/solo/labels";
import { LinkIcon, LinkBreakIcon } from "../../shared/design-system/icons";
import { MenuItem, MenuIcon } from "../../shared/design-system/ui/Menu";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import { parseGitHubReference } from "./references";
import { useSoloPull } from "./SoloPull";
import { writeLink, type SoloPulls } from "./solo-pull";

function messagePulls(message: ChannelMessage): string[] {
  return [
    ...new Set(
      (message.content.match(/https?:\/\/[^\s<>\])]+/g) ?? []).flatMap(
        (url) => {
          const ref = parseGitHubReference(url, { pullSubtargets: true });
          return ref?.kind === "pull" ? [ref.url] : [];
        },
      ),
    ),
  ];
}

export function hasChatPullAction(
  message: ChannelMessage,
  session: RelaySession,
) {
  const channel = session.channels
    .list()
    .channels.find((item) => item.id === message.channelId);
  return (
    ownSolo(channel, session.viewer) &&
    !channel?.archived &&
    !channel?.readOnly &&
    !!session.configArtifactWriter &&
    !!session.snapshotRead &&
    messagePulls(message).length > 0
  );
}

export function ChatPullMessageAction({
  message,
  session,
  relay,
  pulls,
}: {
  message: ChannelMessage;
  session: RelaySession;
  relay: RelayData;
  pulls: SoloPulls;
}) {
  const connection = useSyncExternalStore(relay.subscribe, relay.snapshot);
  useChannelList(session.channels);
  const linked = useSoloPull(pulls, message.channelId)?.url;
  const pending = useRef(false);
  const [saving, setSaving] = useState(false);
  const notify = useToastNotification();
  if (!hasChatPullAction(message, session)) return null;
  const unavailable =
    connection.status !== "ready" ||
    !!connection.cached ||
    connection.session !== session;
  const urls = messagePulls(message);
  return urls.map((url) => {
    const remove = linked === url;
    const Icon = remove ? LinkBreakIcon : LinkIcon;
    const ref = parseGitHubReference(url);
    const label =
      urls.length === 1
        ? "PR"
        : ref?.kind === "pull"
          ? `${ref.repository.split("/").at(-1)}${ref.label}`
          : "PR";
    return (
      <MenuItem
        key={url}
        title={url}
        disabled={saving || unavailable}
        onClick={() => {
          const current = relay.snapshot();
          if (
            pending.current ||
            current.status !== "ready" ||
            current.cached ||
            current.session !== session ||
            !hasChatPullAction(message, session)
          )
            return;
          pending.current = true;
          setSaving(true);
          void (async () => {
            try {
              const next = remove ? null : url;
              await writeLink(session, message.channelId, next);
              pulls.linked(message.channelId, next);
            } catch (error) {
              notify(
                error instanceof Error ? error.message : String(error),
                "error",
              );
            } finally {
              pending.current = false;
              setSaving(false);
            }
          })();
        }}
      >
        <MenuIcon>
          <Icon size={16} aria-hidden="true" />
        </MenuIcon>
        {remove ? `Unlink ${label} from chat` : `Link ${label} to chat`}
      </MenuItem>
    );
  });
}
