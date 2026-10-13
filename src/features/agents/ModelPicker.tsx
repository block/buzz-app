// A type's model choice, shared by agent types for the New agent dialog and
// their settings. Each type decides whether its catalog accepts custom IDs.
import { useId, useRef, useState } from "react";
import {
  ClaudeLogoIcon,
  OpenAILogoIcon,
  RobotIcon,
} from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { Select } from "../../shared/design-system/ui/Select";
import styles from "./AgentControls.module.css";

export type ModelChoice = Readonly<{
  /** The model ID saved in the type's config. */
  id: string;
  label: string;
  description?: string | undefined;
}>;

const CUSTOM_MODEL_ACTION: ModelChoice = {
  id: "\0custom-model",
  label: "Custom model",
  description: "Enter a model ID",
};

/** Recognizes the vendor from a model's ID or name. */
export function ModelIcon({ model }: { model: string }) {
  const name = model.toLowerCase();
  const Icon = /claude|anthropic|opus|sonnet|haiku/.test(name)
    ? ClaudeLogoIcon
    : /(?:^|[\s/._-])(?:gpt|codex|o[134](?:[\s/._-]|$))|openai/.test(name)
      ? OpenAILogoIcon
      : RobotIcon;
  return <Icon size={18} aria-hidden="true" />;
}

/** `value` is a model ID, or "" for the type's default, `defaultLabel`.
 * `compact` sizes it to its text, for the New agent dialog's corner. */
export function ModelPicker({
  models,
  allowCustomModel,
  value,
  defaultLabel,
  defaultDescription,
  onChange,
  loading = false,
  disabled = false,
  compact = false,
  description,
}: {
  models: readonly ModelChoice[];
  /** Whether text absent from `models` may be committed as its model ID. */
  allowCustomModel: boolean;
  value: string;
  defaultLabel: string;
  defaultDescription?: string;
  onChange(value: string): void;
  loading?: boolean;
  disabled?: boolean;
  compact?: boolean;
  description?: string | undefined;
}) {
  const [customDialogOpen, setCustomDialogOpen] = useState(false);
  const [customModel, setCustomModel] = useState("");
  const control = useRef<HTMLDivElement>(null);
  const customInput = useRef<HTMLInputElement>(null);
  const customForm = useId();
  const fallback: ModelChoice = {
    id: "",
    label: defaultLabel,
    description: defaultDescription,
  };
  const items: ModelChoice[] = [fallback, ...models];
  if (value && !items.some((model) => model.id === value))
    items.push({ id: value, label: value, description: "Unavailable model" });
  const selected = items.find((model) => model.id === value) ?? fallback;
  const choices = allowCustomModel ? [...items, CUSTOM_MODEL_ACTION] : items;
  const openCustomDialog = () => {
    const listed = !value || models.some((model) => model.id === value);
    setCustomModel(listed ? "" : value);
    setCustomDialogOpen(true);
  };
  const submitCustomModel = () => {
    const model = customModel.trim();
    if (!model) return;
    onChange(model);
    setCustomDialogOpen(false);
  };
  return (
    <>
      <div ref={control} className={compact ? styles.compactModel : undefined}>
        <Select
          label="Model"
          value={selected.id}
          valueLabel={selected.label}
          valueTitle={selected.label}
          leading={<ModelIcon model={`${selected.id} ${selected.label}`} />}
          variant={compact ? "compact" : "field"}
          align={compact ? "end" : "start"}
          groups={[
            {
              label: "",
              options: choices.map((model) => ({
                value: model.id,
                label: model.label,
                description: model.description,
                leading: <ModelIcon model={`${model.id} ${model.label}`} />,
              })),
            },
          ]}
          disabled={disabled || loading}
          description={compact ? undefined : description}
          onValueChange={(model) => {
            if (model === CUSTOM_MODEL_ACTION.id) openCustomDialog();
            else onChange(model);
          }}
        />
      </div>
      {allowCustomModel && (
        <Dialog
          open={customDialogOpen}
          onOpenChange={setCustomDialogOpen}
          title="Custom model"
          headerGap="compact"
          initialFocus={customInput}
          finalFocus={() =>
            control.current?.querySelector<HTMLElement>("[role=combobox]") ??
            false
          }
          actions={
            <>
              <Button onClick={() => setCustomDialogOpen(false)}>Cancel</Button>
              <Button
                form={customForm}
                type="submit"
                variant="prominent"
                disabled={!customModel.trim()}
              >
                Use model
              </Button>
            </>
          }
        >
          <form
            id={customForm}
            onSubmit={(event) => {
              event.preventDefault();
              submitCustomModel();
            }}
          >
            <Field label="Model ID" labelVisibility="hidden">
              <Input
                ref={customInput}
                value={customModel}
                placeholder="Enter a model ID"
                required
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                onChange={(event) => setCustomModel(event.target.value)}
              />
            </Field>
          </form>
        </Dialog>
      )}
    </>
  );
}
