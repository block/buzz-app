import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import type { ChannelSummary } from "../../features/relay/contracts";
import { matchName } from "../../features/search/match";
import { channelIcon } from "../../features/channels/channel-icon";
import { viewerMember } from "../../features/relay/membership";
import { ChoiceRow } from "../../shared/design-system/ui/ChoiceRow";
import { Combobox } from "../../shared/design-system/ui/Combobox";
import {
  readView,
  subscribeView,
  viewRevision,
  writeView,
} from "../../shared/view-state";

/** My team's channel, saved per device/viewer/community like the filters. */
const teamKey = "inbox:team";

export function useTeamChannel(scope: string) {
  const subscribe = useCallback(
    (listener: () => void) => subscribeView(scope, listener, teamKey),
    [scope],
  );
  const revision = useSyncExternalStore(subscribe, () =>
    viewRevision(scope, teamKey),
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: the revision is the saved value.
  const id = useMemo(() => {
    const saved = readView<unknown>(scope, teamKey, undefined);
    return typeof saved === "string" && saved ? saved : undefined;
  }, [scope, revision]);
  const save = useCallback(
    (next: string) => writeView(scope, teamKey, next),
    [scope],
  );
  return [id, save] as const;
}

/** A team is a channel you're in; its relay-signed roster is the team. A
 * channel still resolving its type stays, so a saved team doesn't flicker. */
export const teamChannels = (
  channels: readonly ChannelSummary[],
  viewer: string,
) =>
  channels.filter(
    (channel) =>
      (channel.metadataPending ||
        channel.channelType === "stream" ||
        channel.channelType === "forum") &&
      !channel.huddle &&
      !channel.pending &&
      !channel.archived &&
      !channel.hidden &&
      viewerMember(channel, viewer),
  );

export function TeamChannelPicker({
  channels: all,
  autoFocus,
  onSelect,
}: {
  channels: readonly ChannelSummary[];
  autoFocus: boolean;
  onSelect(id: string): void;
}) {
  const channels = all.filter((channel) => !channel.metadataPending);
  const [typed, setTyped] = useState("");
  // Ranked as the other pickers do, so Enter on the first row picks an exact name.
  const matches = useMemo(() => {
    const needle = typed.trim().toLowerCase();
    if (!needle) return channels;
    return channels
      .flatMap((channel) => {
        const rank = matchName(channel.name, needle)?.rank;
        return rank === undefined ? [] : [{ channel, rank }];
      })
      .sort((a, b) => a.rank - b.rank)
      .map(({ channel }) => channel);
  }, [channels, typed]);
  return (
    <Combobox.Root
      items={channels}
      filteredItems={matches}
      onInputValueChange={setTyped}
      itemToStringLabel={(channel: ChannelSummary) => channel.name}
      itemToStringValue={(channel: ChannelSummary) => channel.id}
      onValueChange={(channel) => {
        if (channel) onSelect(channel.id);
      }}
      autoHighlight
    >
      <Combobox.Control
        label="Team channel"
        labelVisibility="hidden"
        triggerLabel="Browse channels"
        placeholder="Search channels…"
        autoFocus={autoFocus}
      />
      <Combobox.Popup empty="No matching channels.">
        <Combobox.List>
          {(channel: ChannelSummary) => {
            const Icon = channelIcon(channel);
            return (
              <Combobox.Item key={channel.id} value={channel}>
                <ChoiceRow label={channel.name} leading={<Icon size={18} />} />
              </Combobox.Item>
            );
          }}
        </Combobox.List>
      </Combobox.Popup>
    </Combobox.Root>
  );
}
