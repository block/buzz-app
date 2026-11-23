import { Select } from "../../shared/design-system/ui/Select";
import type { ConversationVisibility } from "../relay/transport";

const FOLLOW = "default";
const labels: Record<ConversationVisibility, string> = {
  private: "Private",
  public: "Public",
};

/** Who can read new conversations. With `inherited`, a first choice follows
 * that default instead; undefined follows. */
export function VisibilitySelect({
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
  value: ConversationVisibility | undefined;
  /** The default a follow choice uses; omit to offer no follow choice. */
  inherited?: ConversationVisibility;
  disabled?: boolean;
  error?: string | undefined;
  onChange(value: ConversationVisibility | undefined): void;
}) {
  const follows = inherited !== undefined && value === undefined;
  const followLabel = inherited && `Use my default (${labels[inherited]})`;
  const current = value ?? inherited ?? "private";
  return (
    <Select
      variant={variant}
      label={label}
      {...(description ? { description } : {})}
      disabled={disabled}
      value={follows ? FOLLOW : current}
      valueLabel={follows && followLabel ? followLabel : labels[current]}
      error={error || undefined}
      groups={[
        {
          label: "",
          options: [
            ...(followLabel
              ? [
                  {
                    value: FOLLOW,
                    label: followLabel,
                    description: "Changes when your default does.",
                  },
                ]
              : []),
            {
              value: "private",
              label: labels.private,
              description: "Only members can find and read them.",
            },
            {
              value: "public",
              label: labels.public,
              description: "Anyone in the community can find and read them.",
            },
          ],
        },
      ]}
      onValueChange={(next) =>
        onChange(next === "private" || next === "public" ? next : undefined)
      }
    />
  );
}
