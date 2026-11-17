import type { Contribution } from "../../plugins/contributions";
import { effectiveRegionLabel, REGION_PREFIX } from "../solo/region-labels";
import { eligibleSolo } from "../solo/labels";
import type { ChannelSummary } from "../relay/contracts";
import type {
  SoloRegionSnapshot,
  SoloRegionSource,
} from "./solo-navigation-contract";

export type RegisteredSoloSource = Contribution<
  SoloRegionSource & { identity: object }
>;
export type SoloRegion = Readonly<{
  key: string;
  label: string;
  title: string;
  source?: RegisteredSoloSource;
  snapshot?: SoloRegionSnapshot;
  reason?:
    | "not-installed"
    | "off"
    | "disabled"
    | "loading"
    | "unavailable"
    | "failed";
  channels: readonly ChannelSummary[];
  live: ReadonlySet<string>;
  /** A ready source keeps it out of the sidebar; its chats stay excluded. */
  hidden?: true;
}>;
export type SoloPlacement = Readonly<{
  regions: readonly SoloRegion[];
  excluded: ReadonlySet<string>;
  managed: ReadonlySet<string>;
}>;

/** One projection of the authorized roster, also consumed by every filing guard. */
export function projectSoloRegions(
  channels: readonly ChannelSummary[],
  viewer: string,
  sources: readonly Readonly<{
    source: RegisteredSoloSource;
    snapshot?: SoloRegionSnapshot;
    failed: boolean;
  }>[],
  title: (label: string, value?: string) => string,
  isPluginDisabled: (label: string) => boolean = () => false,
): SoloPlacement {
  const groups = new Map<string, ChannelSummary[]>();
  for (const source of sources)
    groups.set(soloRegionLabelOf(source.source), []);
  for (const channel of channels) {
    if (!eligibleSolo(channel, viewer)) continue;
    const label = effectiveRegionLabel(channel.labels);
    if (!label) continue;
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)?.push(channel);
  }
  const excluded = new Set<string>();
  const managed = new Set<string>();
  const regions = [...groups]
    .map(([label, rows]): SoloRegion => {
      const current = sources.find(
        (item) => soloRegionLabelOf(item.source) === label,
      );
      const disabled = isPluginDisabled(label);
      const reason = disabled
        ? "disabled"
        : !current
          ? "off"
          : current.failed
            ? "failed"
            : current.snapshot?.status === "ready"
              ? undefined
              : (current.snapshot?.status ?? "loading");
      for (const row of rows) {
        managed.add(row.id);
        if (!disabled) excluded.add(row.id);
      }
      return {
        key:
          current?.source.key ??
          label.slice(REGION_PREFIX.length).replace(/:([^:]*)$/, "/$1"),
        label,
        title: title(label, current?.source.title),
        channels: rows,
        live: new Set(reason ? [] : rows.map((row) => row.id)),
        ...(current ? { source: current.source } : {}),
        ...(current?.snapshot ? { snapshot: current.snapshot } : {}),
        ...(reason ? { reason } : {}),
        ...(!reason && current?.snapshot?.hidden
          ? { hidden: true as const }
          : {}),
      };
    })
    .sort(
      (a, b) =>
        (a.source?.order ?? 0) - (b.source?.order ?? 0) ||
        a.key.localeCompare(b.key),
    );
  return { regions, excluded, managed };
}

/** Equal placements keep one identity, so a roster publish that moves no chat
 * between regions does not re-render every consumer. */
export function sameSoloPlacement(a: SoloPlacement, b: SoloPlacement) {
  return (
    sameSet(a.excluded, b.excluded) &&
    sameSet(a.managed, b.managed) &&
    a.regions.length === b.regions.length &&
    a.regions.every((region, index) => {
      const other = b.regions[index];
      return (
        !!other &&
        region.key === other.key &&
        region.label === other.label &&
        region.title === other.title &&
        region.source === other.source &&
        region.snapshot === other.snapshot &&
        region.reason === other.reason &&
        region.hidden === other.hidden &&
        sameSet(region.live, other.live) &&
        region.channels.length === other.channels.length &&
        region.channels.every((channel, i) => channel === other.channels[i])
      );
    })
  );
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>) {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

function soloRegionLabelOf(source: RegisteredSoloSource) {
  return `${REGION_PREFIX}${source.pluginId}:${source.id}`;
}
