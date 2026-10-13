import { useState, type ReactNode } from "react";
import { Accordion } from "../../shared/design-system/ui/Accordion";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import type { AgentSettingsHost } from "./service";

export function AgentSettingsDisclosure({
  host,
  byline,
  problem,
  dirty = false,
  children,
}: {
  host: AgentSettingsHost;
  byline?: string;
  problem?: string;
  dirty?: boolean;
  children?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const Icon = host.icon;
  const typeControl = host.typeControl?.(dirty);
  const hasDetails = typeControl != null || children != null;
  const summary = (
    <PreferenceRow
      icon={Icon ? <Icon size={20} /> : undefined}
      title={host.title}
      subtitle={
        byline || problem ? (
          <span className="grid gap-0.5">
            {byline && <span>{byline}</span>}
            {problem && (
              <span role="alert" className="text-danger">
                {problem}
              </span>
            )}
          </span>
        ) : undefined
      }
    />
  );

  if (!hasDetails) return <SettingsGroup>{summary}</SettingsGroup>;

  return (
    <div className="[container-type:inline-size]">
      <Accordion
        variant="settings"
        keepMounted
        value={expanded ? ["customize"] : []}
        onValueChange={(value) => setExpanded(value.includes("customize"))}
        items={[
          {
            value: "customize",
            summary,
            title: expanded ? "Close" : "Customize",
            content: (
              <div className="grid gap-4">
                {typeControl}
                {children}
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}
