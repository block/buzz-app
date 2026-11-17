import { useRef, useState } from "react";
import type { Agents } from "./service";
import {
  repairedSettings,
  settingsRecovery,
  type SettingsRecovery,
} from "./settings-recovery";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Select } from "../../shared/design-system/ui/Select";

export function AgentSettingsRecovery({
  agents,
  agentKey,
}: {
  agents: Pick<Agents, "configHistory">;
  agentKey: string;
}) {
  const history = agents.configHistory(agentKey);
  const recovery = settingsRecovery(history);
  const [opened, setOpened] = useState<SettingsRecovery>();
  const [values, setValues] = useState<Record<string, string | undefined>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const cancel = useRef<HTMLButtonElement>(null);
  const [writer, setWriter] = useState(() => history?.revise);
  const save = async () => {
    if (!opened || !writer || saving) return;
    setSaving(true);
    setError("");
    try {
      const outcome = await writer(
        "settings",
        repairedSettings(opened, values),
      );
      if (outcome.status !== "accepted") setError(outcome.message);
      else setOpened(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      {recovery && (
        <div>
          <Button
            size="sm"
            onClick={() => {
              setOpened(recovery);
              setWriter(() => history?.revise);
              setValues(
                Object.fromEntries(
                  recovery.fields.map(({ name, rule }) => [
                    name,
                    rule === "string" ? "" : undefined,
                  ]),
                ),
              );
              setError("");
            }}
          >
            Repair settings
          </Button>
        </div>
      )}
      <Dialog
        open={!!opened}
        onOpenChange={(open) => {
          if (!open) setOpened(undefined);
        }}
        title="Repair settings"
        size="compact"
        initialFocus={cancel}
        preventClose={saving}
        description="This build cannot use these saved settings. Choose replacements or remove them to use this build’s defaults. Saving changes the shared settings on every device; previous values remain in History."
        actions={
          <>
            <Button
              ref={cancel}
              disabled={saving}
              onClick={() => setOpened(undefined)}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={saving}
              onClick={() => void save()}
            >
              Save repaired settings
            </Button>
          </>
        }
      >
        <div className="grid gap-4">
          {opened?.fields.map(({ name, value, rule }) => (
            <div key={name} className="grid min-w-0 gap-2">
              <p className="m-0 break-words text-body-sm text-secondary">
                Saved {name}: {JSON.stringify(value)}
              </p>
              {!rule ? (
                <p className="m-0 text-body-sm">
                  Remove unsupported field “{name}”.
                </p>
              ) : rule === "string" ? (
                <Field
                  label={name}
                  description="Replace the invalid value with text."
                >
                  <Input
                    disabled={saving}
                    value={values[name] ?? ""}
                    onValueChange={(value) =>
                      setValues({ ...values, [name]: value })
                    }
                  />
                </Field>
              ) : (
                <Select
                  label={name}
                  disabled={saving}
                  value={
                    values[name] === undefined
                      ? "remove"
                      : `value:${values[name]}`
                  }
                  groups={[
                    {
                      label: "",
                      options: [
                        {
                          value: "remove",
                          label: "Remove setting (use default)",
                        },
                        ...rule.map((value) => ({
                          value: `value:${value}`,
                          label: value || "(empty)",
                        })),
                      ],
                    },
                  ]}
                  onValueChange={(value) =>
                    setValues({
                      ...values,
                      [name]: value === "remove" ? undefined : value.slice(6),
                    })
                  }
                />
              )}
            </div>
          ))}
          {error && (
            <p role="alert" className="buzz-field-error">
              {error} Close this dialog and reopen Repair settings to use the
              latest saved version.
            </p>
          )}
        </div>
      </Dialog>
    </>
  );
}
