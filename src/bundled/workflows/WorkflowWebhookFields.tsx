import { TrashIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Input } from "../../shared/design-system/ui/Input";
import { Select } from "../../shared/design-system/ui/Select";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import type { StepFormState } from "./workflowFormTypes";

export function WorkflowWebhookFields({
  step,
  disabled,
  update,
  urlError,
  headersError,
}: {
  step: StepFormState;
  disabled: boolean;
  update: (patch: Partial<StepFormState>) => void;
  urlError: string | undefined;
  headersError: string | undefined;
}) {
  const headers = step.headers ?? [];
  return (
    <>
      <Field label="Webhook URL" error={urlError}>
        <Input
          value={step.url ?? ""}
          disabled={disabled}
          placeholder="https://example.com/hook"
          onValueChange={(url) => update({ url })}
        />
      </Field>
      <Select
        label="HTTP method"
        variant="field"
        value={step.method ?? ""}
        disabled={disabled}
        groups={[
          {
            label: "",
            options: [
              { value: "", label: "Relay default" },
              ...[
                "GET",
                "POST",
                "PUT",
                "PATCH",
                "DELETE",
                "HEAD",
                "OPTIONS",
              ].map((value) => ({ value, label: value })),
            ],
          },
        ]}
        onValueChange={(method) => update({ method })}
      />
      <p className="text-body-sm text-subtle">
        The relay checks permission and destination safety. Webhook steps
        require a channel owner or admin. Configuration, including headers, is
        visible to channel members. Do not put secrets here.
      </p>
      <div className="workflow-options">
        <span className="text-label-sm">Headers</span>
        {headers.map((header, index) => (
          <div className="workflow-header-row" key={header.id}>
            <Field label={`Header ${index + 1} name`}>
              <Input
                disabled={disabled}
                value={header.name}
                onValueChange={(name) =>
                  update({
                    headers: headers.map((item, i) =>
                      i === index ? { ...item, name } : item,
                    ),
                  })
                }
              />
            </Field>
            <Field label={`Header ${index + 1} value`}>
              <Input
                disabled={disabled}
                value={header.value}
                onValueChange={(value) =>
                  update({
                    headers: headers.map((item, i) =>
                      i === index ? { ...item, value } : item,
                    ),
                  })
                }
              />
            </Field>
            <IconButton
              aria-label={`Remove header ${index + 1}`}
              icon={<TrashIcon size={16} aria-hidden="true" />}
              disabled={disabled}
              onClick={() =>
                update({ headers: headers.filter((_, i) => i !== index) })
              }
            />
          </div>
        ))}
        {headersError && (
          <p className="text-danger" role="alert">
            {headersError}
          </p>
        )}
        <Button
          size="sm"
          disabled={disabled}
          onClick={() =>
            update({
              headers: [
                ...headers,
                { id: crypto.randomUUID(), name: "", value: "" },
              ],
            })
          }
        >
          Add header
        </Button>
      </div>
      <Field label="Request body (optional)">
        <Textarea
          variant="code"
          rows={4}
          disabled={disabled}
          value={step.body ?? ""}
          onChange={(event) => update({ body: event.currentTarget.value })}
        />
      </Field>
    </>
  );
}
