import type { AgentDraft } from "./agent-edit";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Button } from "../../shared/design-system/ui/Button";

/** Databricks owns workspace/filter and app-cache recovery, independent of model entry. */
export function DatabricksModelSettings({
  host,
  filter,
  disabled,
  busy,
  onChange,
  run,
}: {
  host: string;
  filter: string;
  disabled: boolean;
  busy: boolean;
  onChange(patch: Partial<AgentDraft>): void;
  run(action: "disconnect"): Promise<void>;
}) {
  return (
    <div className="space-y-3">
      <Field label="Databricks workspace (HTTPS origin)">
        <Input
          disabled={disabled}
          value={host}
          placeholder="https://workspace.example.com"
          spellCheck={false}
          onChange={(event) =>
            onChange({
              databricks: { host: event.target.value, filter },
            })
          }
        />
      </Field>
      <Field label="Model filter (optional)">
        <Input
          disabled={disabled}
          value={filter}
          spellCheck={false}
          onChange={(event) =>
            onChange({
              databricks: { host, filter: event.target.value },
            })
          }
        />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={disabled || busy}
          onClick={() => void run("disconnect")}
        >
          Disconnect
        </Button>
      </div>
      <p className="text-body-sm text-secondary">
        Credentials are shared within Foundation for this workspace, not with
        old Buzz. Disconnect removes this app’s cache, not your browser session.
        Save does not restart an agent.
      </p>
    </div>
  );
}
