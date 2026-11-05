// "AI settings": Automatic (Recommended) or Manual, as one Settings row whose
// Manual rows open in place under it. Create agent and an agent's Identity
// settings share it. Automatic says only what it chose, never how.
import type { ComponentType, ReactNode } from "react";
import { MonitorIcon, SparklesIcon } from "../../shared/design-system/icons";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { Select } from "../../shared/design-system/ui/Select";
import { SettingsGroupExpand } from "../../shared/design-system/ui/SettingsGroup";
import { ValueChip } from "../../shared/design-system/ui/ValueChip";
import type { RecommendedCandidate } from "./recommended";

const effortLabel = (effort: string) =>
  effort === "xhigh"
    ? "Extra high"
    : `${effort.charAt(0).toUpperCase()}${effort.slice(1)}`;

type Mark = ComponentType<{ size?: number | string }> | undefined;

/** "Uses [mark] Model A · High": what Automatic picked, and a one-line note. */
export function UsesLine({
  icon: Icon,
  title,
  candidate,
  note,
  prefix = "Uses",
}: Readonly<{
  icon: Mark;
  /** The harness's name, read with the chip by assistive technology. */
  title: string;
  candidate: Pick<RecommendedCandidate, "label" | "effort">;
  note?: string | undefined;
  prefix?: string;
}>) {
  return (
    <span className="grid gap-1">
      <span className="inline-flex flex-wrap items-center gap-2">
        {prefix}
        <ValueChip icon={Icon ? <Icon size={14} /> : undefined} label={title}>
          {candidate.label} · {effortLabel(candidate.effort)}
        </ValueChip>
      </span>
      {note && <span>{note}</span>}
    </span>
  );
}

/** An agent's Automatic line: what it runs on, while finding it, or its
 * harness's default when none of the candidates is offered. */
export function runsOnLine(
  type: Readonly<{ title: string; icon?: Mark }>,
  resolved: RecommendedCandidate | null | undefined,
) {
  return resolved === undefined ? (
    "Checking this computer…"
  ) : resolved ? (
    <UsesLine icon={type.icon} title={type.title} candidate={resolved} />
  ) : (
    `No recommended model is offered here now, so it uses ${type.title}’s default.`
  );
}

export function AISettings({
  automatic,
  summary,
  automaticHint = "We pick a good setup and keep it current.",
  manualHint = "You choose the harness, model and thinking level.",
  short = false,
  disabled = false,
  onChange,
  children,
}: Readonly<{
  automatic: boolean;
  /** Under the title while Automatic is selected: what it uses. */
  summary: ReactNode;
  /** What Automatic means, in its menu. */
  automaticHint?: string;
  manualHint?: string;
  /** Narrow panels show "Automatic" on the trigger; its menu keeps the rest. */
  short?: boolean;
  disabled?: boolean;
  onChange(automatic: boolean): void;
  /** The manual rows, opened in place while Manual is selected. */
  children: ReactNode;
}>) {
  return (
    <>
      <PreferenceRow
        icon={<SparklesIcon size={20} aria-hidden="true" />}
        title="AI settings"
        subtitle={automatic ? summary : manualHint}
        trailing={
          <Select
            label="AI settings"
            variant="compact"
            align="end"
            value={automatic ? "automatic" : "manual"}
            {...(short && automatic ? { valueLabel: "Automatic" } : {})}
            disabled={disabled}
            groups={[
              {
                label: "",
                options: [
                  {
                    value: "automatic",
                    label: "Automatic (Recommended)",
                    description: automaticHint,
                  },
                  {
                    value: "manual",
                    label: "Manual",
                    description: manualHint.replace(/^You choose/, "Choose"),
                  },
                ],
              },
            ]}
            onValueChange={(value) => onChange(value === "automatic")}
          />
        }
      />
      <SettingsGroupExpand open={!automatic}>{children}</SettingsGroupExpand>
    </>
  );
}

/** Where an agent runs: this computer, or a hosted type's provider. */
export const runsOnIcon = (hosted: Mark) => {
  const Icon = hosted ?? MonitorIcon;
  return <Icon size={20} aria-hidden="true" />;
};

/** Read-only: where an agent runs is fixed when it is created. */
export function RunsOnRow({
  hosted,
}: Readonly<{
  /** The hosted type it runs on, or none for this computer. */
  hosted?: Readonly<{ title: string; icon?: Mark }> | undefined;
}>) {
  return (
    <PreferenceRow
      icon={runsOnIcon(hosted ? (hosted.icon ?? MonitorIcon) : undefined)}
      title="Runs on"
      subtitle="Set when the agent was created."
      trailing={
        <span className="whitespace-nowrap text-body-sm text-secondary">
          {hosted ? `${hosted.title} (hosted)` : "This computer"}
        </span>
      }
    />
  );
}
