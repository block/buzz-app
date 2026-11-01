import type { Agent } from "../../features/agents/service";
import { WarningCircleIcon } from "../../shared/design-system/icons";
import { Checkbox } from "../../shared/design-system/ui/Checkbox";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Textarea } from "../../shared/design-system/ui/Textarea";

export type TeamDraft = Readonly<{
  name: string;
  instructions: string;
  members: readonly string[];
}>;

const names = (agents: readonly Agent[]) =>
  new Intl.ListFormat(undefined, { type: "conjunction" }).format(
    agents.map((agent) => agent.name),
  );

/** What a team is made of, shared by the Teams editor and the review of an
 * agent's team request. */
export function TeamFields({
  value,
  agents,
  disabled,
  autoFocus,
  away = 0,
  onChange,
  onPick,
}: {
  value: TeamDraft;
  /** The agents that can be members. */
  agents: readonly Agent[];
  disabled: boolean;
  autoFocus?: boolean;
  /** Members in the owner's other communities, which `agents` leaves out. */
  away?: number;
  onChange(next: TeamDraft): void;
  /** Each agent checked or unchecked, before `onChange`. */
  onPick?(agent: Agent): void;
}) {
  // Their provider runs them, so they may not get the team's instructions.
  const remote = agents.filter(
    (agent) => agent.place === "hosted" && value.members.includes(agent.pubkey),
  );
  return (
    <>
      <Field label="Name">
        <Input
          autoFocus={autoFocus}
          value={value.name}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, name: event.target.value })}
        />
      </Field>
      <Field
        label="Instructions"
        description={
          <>
            {remote.length > 0
              ? "Agents on your devices follow these after their own instructions."
              : "Every member follows these after its own instructions."}
            {remote.length > 0 && (
              <>
                {" "}
                <span className="mt-1 flex items-start gap-1 text-warning">
                  <WarningCircleIcon className="mt-0.5 shrink-0" aria-hidden />
                  {`Agents run by their provider (${names(remote)}) will not get these team instructions.`}
                </span>
              </>
            )}
          </>
        }
      >
        <Textarea
          rows={5}
          value={value.instructions}
          disabled={disabled}
          onChange={(event) =>
            onChange({ ...value, instructions: event.target.value })
          }
        />
      </Field>
      <section className="grid gap-2" aria-label="Members">
        <h4 className="m-0 text-caption text-secondary">Members</h4>
        {agents.length ? (
          <div className="grid gap-2">
            {agents.map((agent) => (
              <Checkbox
                key={agent.pubkey}
                label={agent.name}
                checked={value.members.includes(agent.pubkey)}
                disabled={disabled}
                onCheckedChange={(checked) => {
                  onPick?.(agent);
                  onChange({
                    ...value,
                    members: checked
                      ? [...value.members, agent.pubkey]
                      : value.members.filter(
                          (pubkey) => pubkey !== agent.pubkey,
                        ),
                  });
                }}
              />
            ))}
          </div>
        ) : (
          <p className="m-0 text-body-sm text-secondary">No agents yet.</p>
        )}
        {away > 0 && (
          <p className="m-0 text-body-sm text-secondary">
            {`+${away} in your other communities, who stay on the team.`}
          </p>
        )}
      </section>
    </>
  );
}
