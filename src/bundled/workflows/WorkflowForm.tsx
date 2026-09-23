import { Field } from "../../shared/design-system/ui/Field";
import { useId } from "react";
import { Input } from "../../shared/design-system/ui/Input";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import { Button } from "../../shared/design-system/ui/Button";
import { Select } from "../../shared/design-system/ui/Select";
import { Switch } from "../../shared/design-system/ui/Switch";
import { formWithStep } from "./editor-model";
import {
  ACTION_LABELS,
  nextStepId,
  type WorkflowFormState,
} from "./workflowFormTypes";

export function WorkflowForm({
  state,
  onChange,
  disabled,
}: {
  state: WorkflowFormState;
  onChange: (next: WorkflowFormState) => void;
  disabled: boolean;
}) {
  const id = useId();
  return (
    <fieldset className="workflow-form" disabled={disabled}>
      <Field label="Description">
        <Input
          id={`${id}-1`}
          value={state.description}
          onValueChange={(description) => onChange({ ...state, description })}
        />
      </Field>
      <Select
        label="Trigger"
        variant="field"
        disabled={disabled}
        value={state.trigger.on}
        groups={[
          {
            label: "Channel events",
            options: [
              { value: "message_posted", label: "Message posted" },
              { value: "reaction_added", label: "Reaction added" },
            ],
          },
        ]}
        onValueChange={(value) => {
          if (
            !disabled &&
            (value === "message_posted" || value === "reaction_added")
          )
            onChange({ ...state, trigger: { on: value } });
        }}
      />
      {state.trigger.on === "reaction_added" && (
        <Field label="Emoji (optional)">
          <Input
            id={`${id}-2`}
            value={state.trigger.emoji ?? ""}
            onValueChange={(emoji) =>
              onChange({ ...state, trigger: { ...state.trigger, emoji } })
            }
          />
        </Field>
      )}
      <details>
        <summary>Trigger options</summary>
        <div className="workflow-options">
          <Field
            label="Trigger condition (optional)"
            description="An evalexpr expression; leave empty to match every event of this type."
          >
            <Input
              id={`${id}-3`}
              value={state.trigger.filter ?? ""}
              onValueChange={(filter) =>
                onChange({ ...state, trigger: { ...state.trigger, filter } })
              }
            />
          </Field>
        </div>
      </details>
      <ol className="workflow-steps">
        {state.steps.map((step, index) => (
          <li key={step.id} className="workflow-step">
            <div className="workflow-toolbar">
              <h3 className="text-heading">
                Step {index + 1}: {ACTION_LABELS[step.action]}
              </h3>
              <Button
                size="compact"
                disabled={disabled}
                onClick={() =>
                  onChange({
                    ...state,
                    steps: state.steps.filter((item) => item.id !== step.id),
                  })
                }
              >
                Remove step {index + 1}
              </Button>
            </div>
            {step.action === "send_message" ? (
              <>
                <Field label="Message text">
                  <Textarea
                    id={`${id}-text-${step.id}`}
                    value={step.text ?? ""}
                    rows={3}
                    autoCapitalize="off"
                    onChange={(event) =>
                      onChange(
                        formWithStep(state, step.id, {
                          text: event.currentTarget.value,
                        }),
                      )
                    }
                  />
                </Field>
                <Switch
                  label="Reply in the triggering thread"
                  checked={step.replyInThread === true}
                  disabled={disabled}
                  onCheckedChange={(replyInThread) =>
                    onChange(formWithStep(state, step.id, { replyInThread }))
                  }
                />
              </>
            ) : (
              <Field label="Delay duration">
                <Input
                  id={`${id}-6${step.id}`}
                  value={step.duration ?? ""}
                  placeholder="5m"
                  onValueChange={(duration) =>
                    onChange(formWithStep(state, step.id, { duration }))
                  }
                />
              </Field>
            )}
            <details>
              <summary>Step options</summary>
              <div className="workflow-options">
                <p className="text-mono-sm text-secondary">{step.id}</p>
                <Field label="Step name (optional)">
                  <Input
                    id={`${id}-4${step.id}`}
                    value={step.name ?? ""}
                    onValueChange={(name) =>
                      onChange(formWithStep(state, step.id, { name }))
                    }
                  />
                </Field>
                {step.action === "send_message" && (
                  <Field
                    label="Destination channel UUID (optional)"
                    description="Blank uses this workflow’s channel. The relay checks destination access."
                  >
                    <Input
                      id={`${id}-5${step.id}`}
                      value={step.channel ?? ""}
                      onValueChange={(channel) =>
                        onChange(formWithStep(state, step.id, { channel }))
                      }
                    />
                  </Field>
                )}
                <Field label="Step timeout (optional)">
                  <Input
                    id={`${id}-7${step.id}`}
                    value={step.timeoutSecs ?? ""}
                    placeholder="30s"
                    onValueChange={(timeoutSecs) =>
                      onChange(formWithStep(state, step.id, { timeoutSecs }))
                    }
                  />
                </Field>
              </div>
            </details>
          </li>
        ))}
      </ol>
      <div className="workflow-toolbar">
        <Button
          disabled={disabled}
          onClick={() =>
            onChange({
              ...state,
              steps: [
                ...state.steps,
                {
                  id: nextStepId(state.steps),
                  action: "send_message",
                  text: "",
                },
              ],
            })
          }
        >
          Add Send Message
        </Button>
        <Button
          disabled={disabled}
          onClick={() =>
            onChange({
              ...state,
              steps: [
                ...state.steps,
                {
                  id: nextStepId(state.steps),
                  action: "delay",
                  duration: "5m",
                },
              ],
            })
          }
        >
          Add Delay
        </Button>
      </div>
    </fieldset>
  );
}
