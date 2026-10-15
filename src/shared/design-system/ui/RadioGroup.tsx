import { Field as BaseField } from "@base-ui/react/field";
import { RadioGroup as BaseRadioGroup } from "@base-ui/react/radio-group";
import { Radio as BaseRadio } from "@base-ui/react/radio";
import {
  createContext,
  useContext,
  useId,
  type ComponentProps,
  type ReactNode,
} from "react";

const RadioAppearance = createContext<"default" | "segmented">("default");

/** Compose inside Field so each Radio has its own labelled Field.Item. */
export function RadioGroup<Value>({
  children,
  variant = "default",
  ...props
}: Omit<BaseRadioGroup.Props<Value>, "className"> & {
  variant?: "default" | "segmented";
}) {
  return (
    <BaseRadioGroup
      {...props}
      data-buzz-ui=""
      data-variant={variant}
      className="buzz-radio-group"
    >
      <RadioAppearance.Provider value={variant}>
        {children}
      </RadioAppearance.Provider>
    </BaseRadioGroup>
  );
}

export function Radio({
  label,
  description,
  icon,
  variant = "default",
  id,
  ...props
}: Omit<ComponentProps<typeof BaseRadio.Root>, "className" | "children"> & {
  label: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  variant?: "default" | "card";
}) {
  const appearance = useContext(RadioAppearance);
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const descriptionId = `${controlId}-description`;
  if (appearance === "segmented") {
    return (
      <BaseField.Item>
        <BaseRadio.Root
          {...props}
          id={controlId}
          aria-labelledby={props["aria-labelledby"] ?? `${controlId}-label`}
          aria-describedby={
            [props["aria-describedby"], description ? descriptionId : undefined]
              .filter(Boolean)
              .join(" ") || undefined
          }
          data-buzz-ui=""
          className="buzz-segment"
        >
          <span className="buzz-segment-heading" id={`${controlId}-label`}>
            {icon && (
              <span className="buzz-segment-icon" aria-hidden="true">
                {icon}
              </span>
            )}
            <span>{label}</span>
          </span>
          {description && (
            <span id={descriptionId} className="buzz-segment-description">
              {description}
            </span>
          )}
        </BaseRadio.Root>
      </BaseField.Item>
    );
  }
  return (
    <BaseField.Item>
      <label className="buzz-choice" data-variant={variant} htmlFor={controlId}>
        <BaseRadio.Root
          {...props}
          id={controlId}
          aria-labelledby={props["aria-labelledby"] ?? `${controlId}-label`}
          aria-describedby={
            [props["aria-describedby"], description ? descriptionId : undefined]
              .filter(Boolean)
              .join(" ") || undefined
          }
          data-buzz-ui=""
          className="buzz-radio"
        >
          <BaseRadio.Indicator className="buzz-radio-indicator" />
        </BaseRadio.Root>
        <span>
          <span id={`${controlId}-label`} className="buzz-choice-label">
            {label}
          </span>
          {description && (
            <span id={descriptionId} className="buzz-choice-description">
              {description}
            </span>
          )}
        </span>
      </label>
    </BaseField.Item>
  );
}
