import { useState } from "react";
import { TrashIcon } from "../../shared/design-system/icons";
import { Field } from "../../shared/design-system/ui/Field";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Input } from "../../shared/design-system/ui/Input";
import { Select } from "../../shared/design-system/ui/Select";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import { ConfirmAction } from "./ConfirmAction";
import {
  buildConditionExpressions,
  conditionFieldsForTrigger,
  conditionOperatorsForField,
  conditionOperatorNeedsValue,
  conditionRowError,
  defaultConditionOperatorForField,
  parseConditionExpressions,
  type ConditionOperator,
  type ParsedConditionExpression,
} from "./workflowConditionExpression";
import type { TriggerConfig } from "./workflowFormTypes";

const LABELS: Record<ConditionOperator, string> = {
  contains: "Contains",
  not_contains: "Does not contain",
  starts_with: "Starts with",
  ends_with: "Ends with",
  equals: "Equals",
  not_equals: "Does not equal",
  is_not_empty: "Is not empty",
  is_empty: "Is empty",
};

/** Incomplete Basic rows stay local; only an explicit edit may replace an expression. */
export function WorkflowConditions({
  trigger,
  disabled,
  onChange,
}: {
  trigger: TriggerConfig;
  disabled: boolean;
  onChange: (patch: Partial<TriggerConfig>) => void;
}) {
  const expression = trigger.filter ?? "";
  const parsed = parseConditionExpressions(expression, trigger.on);
  const [mode, setMode] = useState<"basic" | "advanced">(() =>
    parsed ? "basic" : "advanced",
  );
  const [replace, setReplace] = useState(false);
  const [modeError, setModeError] = useState(false);
  const rows = trigger.conditionRows ?? parsed ?? [];
  const fields = conditionFieldsForTrigger(trigger.on);
  const update = (next: ParsedConditionExpression[]) => {
    if (disabled) return;
    const filter = buildConditionExpressions(next);
    onChange({ filter, conditionRows: next });
  };
  return (
    <div className="workflow-options">
      <Tabs
        variant="panel"
        label="Condition mode"
        value={mode}
        items={[
          { value: "basic", label: "Basic" },
          { value: "advanced", label: "Advanced" },
        ]}
        onValueChange={(next) => {
          if (next === "advanced" && rows.some(conditionRowError)) {
            setModeError(true);
            return;
          }
          setModeError(false);
          if (next === "basic" && parsed === null) setReplace(true);
          else setMode(next);
        }}
      />
      {modeError && rows.some(conditionRowError) && (
        <p role="alert" className="text-danger">
          Complete or remove the invalid condition before switching to Advanced.
        </p>
      )}
      {mode === "advanced" ? (
        <Field
          label="Trigger condition (optional)"
          description="An evalexpr expression; leave empty to match every event of this type."
        >
          <Textarea
            variant="code"
            rows={4}
            disabled={disabled}
            value={expression}
            onChange={(event) => {
              onChange({
                filter: event.currentTarget.value,
                conditionRows: undefined,
              });
            }}
          />
        </Field>
      ) : (
        <>
          <p className="text-body-sm text-subtle">
            {rows.length
              ? "All conditions must match."
              : "Runs for every matching event. Add a condition to narrow it down."}
          </p>
          {rows.map((row, index) => (
            <div className="workflow-condition" key={row.field}>
              <div className="workflow-condition-heading">
                <span className="text-label-sm">
                  {fields.find((field) => field.value === row.field)?.label}
                </span>
                <IconButton
                  aria-label={`Remove ${fields.find((field) => field.value === row.field)?.label} condition`}
                  icon={<TrashIcon size={16} aria-hidden="true" />}
                  disabled={disabled}
                  onClick={() => update(rows.filter((_, i) => i !== index))}
                />
              </div>
              <Select
                label={`${fields.find((field) => field.value === row.field)?.label} comparison`}
                variant="field"
                disabled={disabled}
                value={row.operator}
                groups={[
                  {
                    label: "",
                    options: conditionOperatorsForField(row.field).map(
                      (value) => ({ value, label: LABELS[value] }),
                    ),
                  },
                ]}
                onValueChange={(operator) =>
                  update(
                    rows.map((item, i) =>
                      i === index
                        ? { ...item, operator: operator as ConditionOperator }
                        : item,
                    ),
                  )
                }
              />
              {conditionOperatorNeedsValue(row.operator) && (
                <Field
                  label="Value"
                  error={conditionRowError(row) ?? undefined}
                >
                  <Input
                    value={row.value}
                    disabled={disabled}
                    onValueChange={(value) =>
                      update(
                        rows.map((item, i) =>
                          i === index ? { ...item, value } : item,
                        ),
                      )
                    }
                  />
                </Field>
              )}
            </div>
          ))}
          {fields.some(
            (field) => !rows.some((row) => row.field === field.value),
          ) && (
            <Select
              label="Add condition"
              variant="field"
              disabled={disabled}
              value=""
              groups={[
                {
                  label: "",
                  options: fields.filter(
                    (field) => !rows.some((row) => row.field === field.value),
                  ),
                },
              ]}
              onValueChange={(field) =>
                update([
                  ...rows,
                  {
                    field,
                    operator: defaultConditionOperatorForField(field),
                    value: "",
                    webhookField: "",
                  },
                ])
              }
            />
          )}
        </>
      )}
      {replace && (
        <ConfirmAction
          title="Replace with basic filters?"
          description="This expression cannot be represented by Basic conditions. Replacing it clears the expression; cancel to keep it unchanged."
          action="Replace with basic filters"
          onCancel={() => setReplace(false)}
          onConfirm={() => {
            update([]);
            setMode("basic");
            setReplace(false);
          }}
        />
      )}
    </div>
  );
}
