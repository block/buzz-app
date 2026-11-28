import { Checkbox as BaseCheckbox } from "@base-ui/react/checkbox";
import { CheckboxGroup as BaseCheckboxGroup } from "@base-ui/react/checkbox-group";
import { CheckIcon, MinusIcon } from "../icons/index";
import { useId, type ComponentProps, type ReactNode } from "react";

export function CheckboxGroup({
  children,
  size = "md",
  ...props
}: Omit<ComponentProps<typeof BaseCheckboxGroup>, "className"> & {
  size?: "sm" | "md";
}) {
  return (
    <BaseCheckboxGroup
      {...props}
      data-buzz-ui=""
      data-size={size}
      className="buzz-checkbox-group"
    >
      {children}
    </BaseCheckboxGroup>
  );
}

export function Checkbox({
  label,
  description,
  variant = "default",
  id,
  indeterminate,
  size = "md",
  ...props
}: Omit<ComponentProps<typeof BaseCheckbox.Root>, "className" | "children"> & {
  label: ReactNode;
  description?: ReactNode;
  variant?: "default" | "card";
  size?: "sm" | "md";
}) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const descriptionId = `${controlId}-description`;
  return (
    <label
      className="buzz-choice"
      data-variant={variant === "default" ? undefined : variant}
      data-size={size}
      htmlFor={controlId}
    >
      <BaseCheckbox.Root
        {...props}
        id={controlId}
        indeterminate={indeterminate}
        aria-labelledby={
          props["aria-labelledby"] ??
          (description && !props["aria-label"]
            ? `${controlId}-label`
            : undefined)
        }
        aria-describedby={
          [props["aria-describedby"], description ? descriptionId : undefined]
            .filter(Boolean)
            .join(" ") || undefined
        }
        data-buzz-ui=""
        className="buzz-checkbox"
        data-size={size}
      >
        <BaseCheckbox.Indicator>
          {indeterminate ? (
            <MinusIcon size={size === "sm" ? 12 : 14} aria-hidden="true" />
          ) : (
            <CheckIcon size={size === "sm" ? 12 : 14} aria-hidden="true" />
          )}
        </BaseCheckbox.Indicator>
      </BaseCheckbox.Root>
      {description ? (
        <span>
          <span id={`${controlId}-label`} className="buzz-choice-label">
            {label}
          </span>
          <span id={descriptionId} className="buzz-choice-description">
            {description}
          </span>
        </span>
      ) : (
        <span className="buzz-choice-label">{label}</span>
      )}
    </label>
  );
}
