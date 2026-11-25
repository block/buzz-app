import {
  CHANNEL_DURATIONS,
  channelDurationLabel,
} from "../../bundled/channels/ChannelDurationField";
import { Select } from "../../shared/design-system/ui/Select";

const FOLLOW = "default";
const ONGOING = "ongoing";
const lifetimeLabel = (ttlSeconds: number | undefined) =>
  ttlSeconds === undefined
    ? "Ongoing"
    : `Temporary, ${channelDurationLabel(ttlSeconds)}`;

/** Lifetime choices for new conversations: ongoing or a temporary duration.
 * With `inherited`, a first choice follows that default instead. Undefined
 * follows, null is ongoing, else seconds. */
export function LifetimeSelect({
  label,
  description,
  variant,
  value,
  inherited,
  disabled = false,
  error,
  onChange,
}: {
  label: string;
  description?: string;
  variant: "preference" | "field";
  value: number | null | undefined;
  /** The default a follow choice uses; omit to offer no follow choice. */
  inherited?: { ttlSeconds: number | undefined };
  disabled?: boolean;
  error?: string | undefined;
  onChange(value: number | null | undefined): void;
}) {
  const follows = inherited !== undefined && value === undefined;
  const selected = follows ? FOLLOW : value == null ? ONGOING : String(value);
  return (
    <Select
      variant={variant}
      label={label}
      {...(description ? { description } : {})}
      disabled={disabled}
      value={selected}
      valueLabel={
        follows
          ? `Use my default (${lifetimeLabel(inherited.ttlSeconds)})`
          : lifetimeLabel(value ?? undefined)
      }
      error={error || undefined}
      groups={[
        {
          label: "",
          options: [
            ...(inherited
              ? [
                  {
                    value: FOLLOW,
                    label: `Use my default (${lifetimeLabel(inherited.ttlSeconds)})`,
                    description: "Changes when your default does.",
                  },
                ]
              : []),
            {
              value: ONGOING,
              label: "Ongoing",
              description: "No automatic archive.",
            },
            ...CHANNEL_DURATIONS.map((seconds) => ({
              value: String(seconds),
              label: lifetimeLabel(seconds),
              description: `Archives after ${channelDurationLabel(seconds)} without activity.`,
            })),
          ],
        },
      ]}
      onValueChange={(next) =>
        onChange(
          next === FOLLOW ? undefined : next === ONGOING ? null : Number(next),
        )
      }
    />
  );
}
