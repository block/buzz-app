import type { PluginManifest } from "../plugins/api";
import { Checkbox } from "../shared/design-system/ui/Checkbox";

type DeclaredAgents = NonNullable<PluginManifest["agents"]>;

/** The ids checked by default: every agent the plugin declares. */
export const allDeclaredAgentIds = (manifest: PluginManifest) =>
  new Set((manifest.agents ?? []).map((agent) => agent.id));

/** The declared agents whose ids are in `selected`, in manifest order. */
export const selectedDeclaredAgents = (
  manifest: PluginManifest,
  selected: ReadonlySet<string>,
): DeclaredAgents =>
  (manifest.agents ?? []).filter((agent) => selected.has(agent.id));

const INSTRUCTIONS_PREVIEW_CHARACTERS = 140;

function previewOfInstructions(instructions: string | undefined) {
  const firstLines = instructions?.trim().replace(/\s+/g, " ") ?? "";
  if (firstLines.length <= INSTRUCTIONS_PREVIEW_CHARACTERS) return firstLines;
  return `${firstLines.slice(0, INSTRUCTIONS_PREVIEW_CHARACTERS).trimEnd()}…`;
}

/** Lists a plugin's declared agents with a checkbox each. Checked agents get
 * a creation review after install; this list creates nothing itself. */
export function DeclaredAgentsReview({
  manifest,
  selected,
  onSelectedChange,
  disabled,
}: {
  manifest: PluginManifest;
  selected: ReadonlySet<string>;
  onSelectedChange: (selected: ReadonlySet<string>) => void;
  disabled?: boolean;
}) {
  const declared = manifest.agents ?? [];
  if (declared.length === 0) return null;
  const toggle = (id: string, checked: boolean) => {
    const next = new Set(selected);
    if (checked) next.add(id);
    else next.delete(id);
    onSelectedChange(next);
  };
  return (
    <section aria-label="Agents in this plugin" className="text-body-sm">
      <p className="mt-0 mb-2 text-label">Agents</p>
      <div className="flex flex-col gap-3">
        {declared.map((agent) => {
          const instructionsPreview = previewOfInstructions(agent.instructions);
          return (
            <Checkbox
              key={agent.id}
              checked={selected.has(agent.id)}
              disabled={disabled}
              onCheckedChange={(checked) => toggle(agent.id, checked)}
              label={
                <span className="block min-w-0 break-words">
                  <span className="block font-medium">{agent.name}</span>
                  {instructionsPreview && (
                    <span className="block text-muted">
                      {instructionsPreview}
                    </span>
                  )}
                </span>
              }
            />
          );
        })}
      </div>
      <p className="mb-0 mt-3" role="note">
        <strong>These instructions control what the agent does.</strong> An
        agent can use everything its harness allows, which can include running
        commands, reading and changing your files, and using your credentials on
        this computer. Only add agents from plugins you trust. You review each
        checked agent, and its full instructions, before it’s created.
      </p>
    </section>
  );
}
