import { useEffect, useLayoutEffect, useState } from "react";
import { channelIcon } from "../../features/channels/channel-icon";
import type {
  CompletionSuggestion,
  ComposerCompletionProps,
} from "../../features/conversation/contracts";
import type { ChannelSummary } from "../../features/relay/contracts";

const LIMIT = 20;

function referable(channel: ChannelSummary) {
  return (
    !!channel.name.trim() &&
    !/[\r\n]/.test(channel.name) &&
    !channel.archived &&
    !channel.hidden &&
    channel.channelType !== "dm" &&
    channel.channelType !== "session"
  );
}

/** Joined channels, including ones restored from cache while the relay
 * reconfirms them: a reference names a channel, it grants nothing. */
function joined(channel: ChannelSummary, viewer: string | undefined) {
  return (
    !!viewer &&
    referable(channel) &&
    !channel.readOnly &&
    !!channel.members?.includes(viewer)
  );
}

/** A multi-word query is prose unless a channel name continues it. */
function matches(name: string, needle: string) {
  return needle.includes(" ") ? name.startsWith(needle) : name.includes(needle);
}

const rank = (name: string, needle: string) =>
  name === needle ? 0 : name.startsWith(needle) ? 1 : 2;

type PublicResult = Readonly<{
  query: string;
  channels: readonly ChannelSummary[];
}>;

export function ChannelCompletion({
  session,
  query,
  publish,
}: ComposerCompletionProps) {
  const needle = query.query.toLowerCase();
  const [listReady, setListReady] = useState(
    () => session.channels.list().status === "ready",
  );
  const [found, setFound] = useState<PublicResult>();
  const search = session.channels.searchPublic;
  // Open channels the viewer hasn't joined, after a brief typing pause.
  const searchable = !!search && listReady && !!needle && !/\s/.test(needle);
  useEffect(() => {
    if (!searchable) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      search(needle, {
        signal: controller.signal,
        priority: "foreground",
      }).then(
        ({ channels }) => {
          if (!controller.signal.aborted) setFound({ query: needle, channels });
        },
        () => {
          // Joined matches still complete; open-channel search is best effort.
          if (!controller.signal.aborted)
            setFound({ query: needle, channels: [] });
        },
      );
    }, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [search, searchable, needle]);
  const discovered = found?.query === needle ? found.channels : undefined;
  const searching = searchable && !discovered;
  useLayoutEffect(() => {
    let withdraw: (() => void) | false | undefined;
    const update = () => {
      // Withdraw at the data boundary, not after a later React render.
      if (withdraw) withdraw();
      const list = session.channels.list();
      setListReady(list.status === "ready");
      const names = new Map<string, number>();
      const count = (channel: ChannelSummary) => {
        const name = channel.name.toLowerCase();
        names.set(name, (names.get(name) ?? 0) + 1);
        return matches(name, needle);
      };
      const byRank = (a: ChannelSummary, b: ChannelSummary) =>
        rank(a.name.toLowerCase(), needle) -
          rank(b.name.toLowerCase(), needle) ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id);
      const mine = list.channels
        .filter((channel) => joined(channel, session.viewer) && count(channel))
        .sort(byRank);
      const ids = new Set(mine.map((channel) => channel.id));
      // A search result joined or removed since the lookup leaves this set.
      const open = (discovered ?? [])
        .filter((channel) => {
          const current = session.channels.get?.(channel.id);
          return (
            !ids.has(channel.id) &&
            !!current?.readOnly &&
            referable(current) &&
            count(current)
          );
        })
        .sort(byRank);
      const total = mine.length + open.length;
      const settling =
        list.status === "loading" ||
        list.status === "idle" ||
        list.channels.some((channel) => channel.cached);
      const item = (
        channel: ChannelSummary,
        member: boolean,
      ): CompletionSuggestion => {
        const Icon = channelIcon(channel);
        const duplicate = (names.get(channel.name.toLowerCase()) ?? 0) > 1;
        const label = `#${channel.name}`.replace(/[\\`*_[\]()#<>~&]/g, "\\$&");
        const id = encodeURIComponent(channel.id).replace(
          /[!'()*]/g,
          (char) => `%${char.charCodeAt(0).toString(16)}`,
        );
        const detail = [
          channel.private ? "Private channel" : "",
          member ? "" : "Not joined",
          duplicate ? channel.id : "",
        ]
          .filter(Boolean)
          .join(" · ");
        return {
          id: channel.id,
          label: channel.name,
          ...(detail ? { detail } : {}),
          preview: <Icon size={22} />,
          edit: { text: `[${label}](buzz://channel/${id})` },
          canSelect: () => {
            const current = member
              ? session.channels
                  .list()
                  .channels.find((entry) => entry.id === channel.id)
              : session.channels.get?.(channel.id);
            return (
              !!current &&
              current.name === channel.name &&
              (member
                ? joined(current, session.viewer)
                : !!current.readOnly && referable(current))
            );
          },
        };
      };
      const items = [
        ...mine.map((channel) => item(channel, true)),
        ...open.map((channel) => item(channel, false)),
      ].slice(0, LIMIT);
      withdraw = publish({
        items,
        ...(list.error
          ? { status: "Could not refresh channels." }
          : !total && settling
            ? { status: "Loading channels…" }
            : total > LIMIT
              ? { status: "Keep typing to narrow the list." }
              : searching
                ? { status: "Searching open channels…" }
                : {}),
        ...(list.error && session.channels.refreshList
          ? { retry: () => session.channels.refreshList?.() }
          : {}),
      });
    };
    const unsubscribe = session.channels.subscribeList(update);
    update();
    return () => {
      unsubscribe();
      if (withdraw) withdraw();
    };
  }, [session, needle, publish, discovered, searching]);
  return null;
}
