import { useEffect, useId, useRef, useState } from "react";
import { Input } from "../../shared/design-system/ui/Input";
import {
  CRON_FIELD_DEFINITIONS,
  type CronFields,
  cronExpressionFromFields,
  cronFieldsFromExpression,
  cronFieldsFromPaste,
  normalizeCronExpression,
  validateCronFields,
} from "./cronExpression";

const LAST_FIELD = CRON_FIELD_DEFINITIONS.length - 1;

/**
 * Five boxes for one five-field cron expression. Space, Backspace on an empty
 * box and the arrow keys at either edge hop between boxes; pasting a whole
 * expression into any box fills all five.
 */
export function CronExpressionInput({
  disabled = false,
  onChange,
  value,
}: {
  disabled?: boolean;
  onChange: (value: string) => void;
  value: string;
}) {
  const id = useId();
  const [fields, setFields] = useState<CronFields>(() =>
    cronFieldsFromExpression(value),
  );
  const [pasteError, setPasteError] = useState<string | null>(null);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);
  const localValue = useRef(normalizeCronExpression(value));
  const validationErrors = validateCronFields(fields);
  const firstError = pasteError ?? validationErrors.find(Boolean) ?? null;
  const messageId = `${id}-message`;

  // An outside change (the YAML tab, a preset seed) replaces the boxes. Our
  // own commits do not, so an emptied box stays empty instead of collapsing.
  useEffect(() => {
    const nextValue = normalizeCronExpression(value);
    if (nextValue !== localValue.current) {
      setFields(cronFieldsFromExpression(value));
      localValue.current = nextValue;
      setPasteError(null);
    }
  }, [value]);

  const commitFields = (nextFields: CronFields) => {
    const expression = cronExpressionFromFields(nextFields);
    setFields(nextFields);
    setPasteError(null);
    localValue.current = normalizeCronExpression(expression);
    onChange(expression);
  };

  const focusField = (index: number) => {
    const input = inputRefs.current[index];
    input?.focus();
    input?.select();
  };

  return (
    <fieldset className="workflow-cron">
      <legend className="buzz-field-label">Cron expression</legend>
      <div className="workflow-cron-fields">
        {CRON_FIELD_DEFINITIONS.map((definition, index) => {
          const fieldId = `${id}-${definition.label.toLowerCase()}`;
          const error = validationErrors[index] ?? null;
          return (
            <div key={definition.label} className="workflow-cron-field">
              <label
                htmlFor={fieldId}
                className={
                  error
                    ? "text-body-sm text-danger"
                    : "text-body-sm text-secondary"
                }
              >
                {definition.label}
              </label>
              <Input
                id={fieldId}
                aria-describedby={messageId}
                aria-invalid={Boolean(error)}
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                placeholder="*"
                disabled={disabled}
                value={fields[index] ?? ""}
                ref={(element) => {
                  inputRefs.current[index] =
                    element instanceof HTMLInputElement ? element : null;
                }}
                onValueChange={(next) => {
                  const nextFields = [...fields] as CronFields;
                  nextFields[index] = next.replace(/\s/g, "");
                  commitFields(nextFields);
                }}
                onKeyDown={(event) => {
                  const input = event.currentTarget;
                  if (event.key === " " && index < LAST_FIELD) {
                    event.preventDefault();
                    focusField(index + 1);
                  } else if (
                    event.key === "Backspace" &&
                    !input.value &&
                    index > 0
                  ) {
                    event.preventDefault();
                    focusField(index - 1);
                  } else if (
                    event.key === "ArrowLeft" &&
                    input.selectionStart === 0 &&
                    index > 0
                  ) {
                    event.preventDefault();
                    focusField(index - 1);
                  } else if (
                    event.key === "ArrowRight" &&
                    input.selectionStart === input.value.length &&
                    index < LAST_FIELD
                  ) {
                    event.preventDefault();
                    focusField(index + 1);
                  }
                }}
                onPaste={(event) => {
                  const pastedValue =
                    event.clipboardData.getData("text/plain") ||
                    event.clipboardData.getData("text");
                  // A single token pastes into this box like ordinary text.
                  if (!/\s/.test(pastedValue.trim())) return;

                  event.preventDefault();
                  const result = cronFieldsFromPaste(pastedValue);
                  if (!result.ok) {
                    setPasteError(result.error);
                    return;
                  }
                  commitFields(result.fields);
                }}
              />
            </div>
          );
        })}
      </div>
      <p
        id={messageId}
        role={firstError ? "alert" : undefined}
        className={
          firstError
            ? "text-body-sm text-danger"
            : "text-body-sm text-secondary"
        }
      >
        {firstError ??
          "UTC · Paste all 5 fields, or use wildcards, lists, ranges, and steps."}
      </p>
    </fieldset>
  );
}
