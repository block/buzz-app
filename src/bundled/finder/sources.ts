// Built-in lists other plugins can open: `buzz.finder/conversations` and
// `buzz.finder/people`.
import { directMessageWith } from "../../features/direct-messages/message-person";
import { profileTarget } from "../../features/profiles/target";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import { avatarMedia } from "../../shared/avatar-source";
import { HashIcon, UserIcon } from "../../shared/design-system/icons/index";
import type { FinderItem, FinderSource } from "./service";

/** As ⌘K counts it: a saved row or a guest's read-only one counts; a public
 * channel read after leaving does not. */
const joined = (channel: ChannelSummary) =>
  (!channel.readOnly || !!channel.cached || channel.viewerRole === "guest") &&
  !channel.archived &&
  !channel.huddle;

type Opener = {
  session: () => RelaySession | undefined;
  /** The conversation on screen, if any. */
  current: () => string | undefined;
  open: (channelId: string, detail?: string) => void;
};

export function builtinSources({
  session,
  current,
  open,
}: Opener): FinderSource[] {
  const nameOf = (live: RelaySession, pubkey: string) =>
    live.profiles.snapshot().get(pubkey)?.name ?? pubkey.slice(0, 10);
  const conversations = (live: RelaySession) =>
    live.channels.list().channels.filter(joined);
  return [
    {
      id: "conversations",
      title: "Conversations",
      items: () => {
        const live = session();
        if (!live) return [];
        return conversations(live).map(
          (channel): FinderItem => ({
            id: channel.id,
            label:
              channel.channelType === "dm"
                ? (channel.participants ?? [])
                    .map((id) => nameOf(live, id))
                    .join(", ") || "Notes to self"
                : channel.channelType === "stream" ||
                    channel.channelType === "forum"
                  ? `#${channel.name}`
                  : channel.name || "Conversation",
            ...(channel.channelType === "dm" && { detail: "Direct message" }),
            icon: channel.channelType === "dm" ? UserIcon : HashIcon,
            preview: { kind: "channel", channelId: channel.id },
            run: () => open(channel.id),
          }),
        );
      },
    },
    {
      id: "people",
      title: "People",
      items: () => {
        const live = session();
        if (!live) return [];
        const profiles = live.profiles.snapshot();
        const channels = conversations(live);
        // Everyone in a conversation you're in, with one you share.
        const shared = new Map<string, string>();
        for (const channel of channels)
          for (const pubkey of channel.participants ?? channel.members ?? [])
            if (pubkey !== live.viewer && !shared.has(pubkey))
              shared.set(pubkey, channel.id);
        return [...shared].map(([pubkey, channelId]): FinderItem => {
          const profile = profiles.get(pubkey);
          const keywords = [profile?.username, profile?.nip05]
            .filter(Boolean)
            .join(" ");
          return {
            id: pubkey,
            label: nameOf(live, pubkey),
            ...(profile?.nip05 && { detail: profile.nip05 }),
            ...(keywords && { keywords }),
            icon: UserIcon,
            avatar: {
              shape: "circle",
              name: nameOf(live, pubkey),
              ...(profile?.picture && {
                src: avatarMedia(profile.picture, live.media),
              }),
            },
            preview: { kind: "person", pubkey },
            run: () => {
              // Your DM with them, as ⌘K opens; else their profile beside
              // this conversation, or one you share.
              const dm = directMessageWith(channels, pubkey);
              if (dm) return open(dm.id);
              const target = profileTarget(pubkey);
              open(current() ?? channelId, target);
            },
          };
        });
      },
    },
  ];
}
