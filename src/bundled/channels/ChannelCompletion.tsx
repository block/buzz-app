import { useLayoutEffect, useState } from "react";
import { channelIcon } from "../../features/channels/channel-icon";
import { usePublicChannelSearch } from "../../features/channels/usePublicChannelSearch";
import type {
  CompletionSuggestion,
  ComposerCompletionProps,
} from "../../features/conversation/contracts";
import type { ChannelSummary } from "../../features/relay/contracts";
import { matchName } from "../../features/search/match";

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

/** The channel name rule the other channel pickers use (`matchName`), without
 * its fuzzy ranks: Enter and Tab pick the first row while the viewer is
 * writing prose, so a scattered-letter match must not capture a `#word`. A
 * query with a space matches only from the start of a name, as person names
 * do, so ordinary prose after `#name` closes the popup. */
function rank(name: string, needle: string) {
  const found = matchName(name, needle)?.rank;
  if (found === undefined || found > 3) return undefined;
  if (/\s/u.test(needle) && found > 1) return undefined;
  return found;
}

export function ChannelCompletion({
  session,
  query,
  publish,
}: ComposerCompletionProps) {
  const needle = query.query.toLowerCase();
  const [listReady, setListReady] = useState(
    () => session.channels.list().status === "ready",
  );
  // Open channels the viewer hasn't joined. The relay has no name search, so
  // a query with a space would only scan the same page again.
  const open = usePublicChannelSearch(
    session,
    /\s/u.test(needle) ? "" : needle,
    listReady,
  );
  // Joined matches still complete when it fails: open-channel search is best
  // effort. A failed lookup finds nothing.
  const searching = open.loading;
  const discovered = open.found;
  useLayoutEffect(() => {
    let withdraw: (() => void) | false | undefined;
    const update = () => {
      // Withdraw at the data boundary, not after a later React render.
      if (withdraw) withdraw();
      const list = session.channels.list();
      setListReady(list.status === "ready");
      const names = new Map<string, number>();
      const ranked = (channel: ChannelSummary, member: boolean) => {
        const name = channel.name.toLowerCase();
        names.set(name, (names.get(name) ?? 0) + 1);
        const found = rank(channel.name, needle);
        return found === undefined ? [] : [{ channel, member, rank: found }];
      };
      const mine = list.channels.flatMap((channel) =>
        joined(channel, session.viewer) ? ranked(channel, true) : [],
      );
      const ids = new Set(mine.map(({ channel }) => channel.id));
      // A search result joined or removed since the lookup leaves this set.
      const others = discovered.flatMap((channel) => {
        const current = session.channels.get?.(channel.id);
        return current &&
          !ids.has(current.id) &&
          current.readOnly &&
          referable(current)
          ? ranked(current, false)
          : [];
      });
      // One order for joined and open channels, as in Command-K: the better
      // match first, and a joined channel wins a tie.
      const matches = [...mine, ...others].sort(
        (a, b) =>
          a.rank - b.rank ||
          Number(b.member) - Number(a.member) ||
          a.channel.name.localeCompare(b.channel.name) ||
          a.channel.id.localeCompare(b.channel.id),
      );
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
      withdraw = publish({
        items: matches
          .slice(0, LIMIT)
          .map(({ channel, member }) => item(channel, member)),
        ...(list.error
          ? { status: "Could not refresh channels." }
          : !matches.length && settling
            ? { status: "Loading channels…" }
            : matches.length > LIMIT
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
