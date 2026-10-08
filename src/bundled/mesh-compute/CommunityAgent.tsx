import { useId, useState, useSyncExternalStore, type ReactNode } from "react";
import type { AgentControl } from "../../features/agents/control";
import { AgentCreateDialog } from "../agents/AgentCreateDialog";
import { Button } from "../../shared/design-system/ui/Button";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { PencilSimpleIcon } from "../../shared/design-system/icons";
import {
  COMMUNITY_AGENT_PRESETS,
  type CommunityAgentPreset,
} from "./communityAgentPresets";
import styles from "./Compute.module.css";

/** Reuse the normal owner-reviewed create/start/profile flow; never create on mount. */
export function CommunityAgent({
  control,
  destination,
  owner,
}: {
  control: AgentControl;
  destination: string;
  owner: string;
}) {
  const state = useSyncExternalStore(control.subscribe, control.snapshot);
  const titleId = useId();
  // undefined: closed; null: custom (blank) agent; otherwise the chosen preset.
  const [open, setOpen] = useState<CommunityAgentPreset | null>();
  const start = (preset: CommunityAgentPreset | null) => {
    setOpen(preset);
    void control.refresh();
  };
  return (
    <section aria-labelledby={titleId} className={styles.sharing}>
      <InlineHeader id={titleId} level={2} title="Tools" />
      <ul aria-label="Community agent examples" className={styles.presets}>
        {COMMUNITY_AGENT_PRESETS.map((preset) => (
          <PresetRow
            key={preset.id}
            icon={<preset.icon size={20} />}
            name={preset.name}
            summary={
              preset.requires
                ? `${preset.summary} Needs ${preset.requires}.`
                : preset.summary
            }
            onSelect={() => start(preset)}
          />
        ))}
        <PresetRow
          icon={<PencilSimpleIcon size={20} />}
          name="Custom agent"
          summary="Start blank: name it and write its instructions yourself."
          action="Create"
          onSelect={() => start(null)}
        />
      </ul>
      {open !== undefined && (
        <AgentCreateDialog
          control={control}
          state={state}
          destination={destination}
          owner={owner}
          sharedCompute
          preset={open ?? undefined}
          onClose={() => setOpen(undefined)}
        />
      )}
    </section>
  );
}

function PresetRow({
  icon,
  name,
  summary,
  action = "Set up",
  onSelect,
}: {
  icon: ReactNode;
  name: string;
  summary: string;
  action?: string;
  onSelect(): void;
}) {
  return (
    <li className={styles.preset}>
      <span className={styles.presetIcon} aria-hidden="true">
        {icon}
      </span>
      <div className={styles.presetBody}>
        <p className="m-0 text-body">{name}</p>
        <p className="m-0 text-body-sm text-secondary">{summary}</p>
      </div>
      {/* Visible verb starts the accessible name, so speech and labels agree. */}
      <Button size="sm" aria-label={`${action} ${name}`} onClick={onSelect}>
        {action}
      </Button>
    </li>
  );
}
