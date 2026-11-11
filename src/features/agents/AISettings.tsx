// "AI settings": Automatic (Recommended) or Manual, as one Settings row whose
// Manual rows open in place under it. Create agent and an agent's Identity
// settings share it. Automatic says only what it chose, never how.
import { type ComponentType, type ReactNode, useEffect, useState } from "react";
import { InfoIcon, SparklesIcon } from "../../shared/design-system/icons";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { Select } from "../../shared/design-system/ui/Select";
import { SettingsGroupExpand } from "../../shared/design-system/ui/SettingsGroup";
import { Tooltip } from "../../shared/design-system/ui/Tooltip";
import { ValueChip } from "../../shared/design-system/ui/ValueChip";
import type { RecommendedCandidate } from "./recommended";

const effortLabel = (effort: string) =>
  effort === "xhigh"
    ? "Extra high"
    : `${effort.charAt(0).toUpperCase()}${effort.slice(1)}`;

type Mark = ComponentType<{ size?: number | string }> | undefined;

/** The (i) after the chip when Automatic skipped Buzz's usual pick. Its
 * hint opens on hover, focus and click; it never lists the order. */
function FallbackInfo({ text }: Readonly<{ text: string }>) {
  const [open, setOpen] = useState(false);
  return (
    <Tooltip
      content={text}
      open={open}
      onOpenChange={setOpen}
      closeOnClick={false}
    >
      <button
        type="button"
        className="buzz-uses-info"
        aria-label="Why this model"
        onClick={() => setOpen((shown) => !shown)}
      >
        <InfoIcon size={14} aria-hidden="true" />
      </button>
    </Tooltip>
  );
}

/** "Uses [mark] Model A · High": what Automatic picked, with an (i) when it
 * had to skip the harness it would usually use. */
export function UsesLine({
  icon: Icon,
  title,
  candidate,
  skipped,
}: Readonly<{
  icon: Mark;
  /** The harness's name, read with the chip by assistive technology. */
  title: string;
  candidate: Pick<RecommendedCandidate, "label" | "effort">;
  /** The usual pick's harness, when it isn't set up here. */
  skipped?: string | undefined;
}>) {
  const value = `${candidate.label} · ${effortLabel(candidate.effort)}`;
  return (
    <span className="buzz-uses-line inline-flex flex-wrap items-center">
      {/* The space keeps "Uses" and the chip apart when read aloud. */}
      Uses{" "}
      <ValueChip
        icon={Icon ? <Icon size={12} /> : undefined}
        label={title}
        title={value}
      >
        {value}
      </ValueChip>
      {skipped && (
        <FallbackInfo
          text={`Buzz’s usual pick, ${skipped}, isn’t set up on this computer, so this agent uses ${candidate.label}.`}
        />
      )}
    </span>
  );
}

/** "Checking this computer…", held back a second so a quick check doesn't
 * flash it; until then a blank line as tall as the result. */
export function Checking() {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShown(true), 1000);
    return () => clearTimeout(timer);
  }, []);
  return (
    <span className="buzz-uses-line inline-flex items-center">
      {shown ? "Checking this computer…" : "\u00a0"}
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
    <Checking />
  ) : resolved ? (
    <UsesLine icon={type.icon} title={type.title} candidate={resolved} />
  ) : (
    `No recommended model is available, so this uses ${type.title}’s default.`
  );
}

export function AISettings({
  automatic,
  summary,
  action,
  automaticHint = "We choose a general-purpose harness and model that balance intelligence and cost, and keep it up to date for you.",
  manualHint = "You choose the harness, model and thinking level.",
  disabled = false,
  onChange,
  children,
}: Readonly<{
  automatic: boolean;
  /** Under the title while Automatic is selected: what it uses. */
  summary: ReactNode;
  /** A next step after the summary, such as a link, outside its live region. */
  action?: ReactNode;
  /** What Automatic means, in its menu. */
  automaticHint?: string;
  manualHint?: string;
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
        // One lasting live region, announced as it changes (from checking to
        // what it uses); a link or button in `action` stays outside it.
        subtitle={
          !automatic ? (
            manualHint
          ) : summary || action ? (
            <span className="grid gap-1">
              <span role="status">{summary}</span>
              {action && <span>{action}</span>}
            </span>
          ) : undefined
        }
        trailing={(control) => (
          <Select
            describedBy={control["aria-describedby"]}
            label="AI settings"
            variant="compact"
            align="end"
            value={automatic ? "automatic" : "manual"}
            // "(Recommended)" is said in the menu, not on the trigger.
            {...(automatic ? { valueLabel: "Automatic" } : {})}
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
        )}
      />
      <SettingsGroupExpand open={!automatic}>{children}</SettingsGroupExpand>
    </>
  );
}
