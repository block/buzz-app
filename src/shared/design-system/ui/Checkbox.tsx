import { Checkbox as BaseCheckbox } from "@base-ui/react/checkbox";
import { CheckIcon, MinusIcon } from "../icons/index";
import { useId, type ComponentProps, type ReactNode } from "react";

export function Checkbox({
  label,
  id,
  indeterminate,
  ...props
}: Omit<ComponentProps<typeof BaseCheckbox.Root>, "className" | "children"> & {
  label: ReactNode;
}) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  return (
    <label className="buzz-choice" htmlFor={controlId}>
      <BaseCheckbox.Root
        {...props}
        id={controlId}
        indeterminate={indeterminate}
        data-buzz-ui=""
        className="buzz-checkbox"
      >
        <BaseCheckbox.Indicator>
          {indeterminate ? (
            <MinusIcon size={14} aria-hidden="true" />
          ) : (
            <CheckIcon size={14} aria-hidden="true" />
          )}
        </BaseCheckbox.Indicator>
      </BaseCheckbox.Root>
      <span className="buzz-choice-label">{label}</span>
    </label>
  );
}
