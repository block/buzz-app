import type { ChannelSummary } from "../relay/contracts";
import {
  ChatCircleIcon,
  HashIcon,
  LockIcon,
} from "../../shared/design-system/icons/index";

/** What names a channel and chooses how it is shown. */
export type ChannelLabel = Pick<
  ChannelSummary,
  "name" | "private" | "channelType"
>;

const channelSurfaces = [
  "categorical-purple",
  "categorical-blue",
  "categorical-green",
  "categorical-orange",
] as const;

/** Feed and rail artwork keep the same identity for a channel name. */
export function channelAvatarSurface(name: string) {
  const initial = name.trim().replace(/^#+/, "").trim().toUpperCase();
  return (
    channelSurfaces[(initial.codePointAt(0) ?? 0) % channelSurfaces.length] ??
    "categorical-purple"
  );
}

/** Ordinary channel visibility chooses its icon, as the sidebar shows it;
 * callers retain non-channel type icons. */
export function channelIcon(
  channel:
    | {
        readonly private?: true | undefined;
        readonly channelType?: string | undefined;
      }
    | undefined,
) {
  if (channel?.channelType === "solo" || channel?.channelType === "dm")
    return ChatCircleIcon;
  return channel?.private ? LockIcon : HashIcon;
}

/** What `channelIcon` shows, in words, for readers who can't see it. */
export function channelIconLabel(channel: Parameters<typeof channelIcon>[0]) {
  if (channel?.channelType === "solo") return "Chat";
  if (channel?.channelType === "dm") return "Direct message";
  return channel?.private ? "Private channel" : "Public channel";
}

/** The channel's name as plain text, `#`-prefixed only where its icon is a hash. */
export function channelText(channel: ChannelLabel) {
  return channelIcon(channel) === HashIcon ? `#${channel.name}` : channel.name;
}
