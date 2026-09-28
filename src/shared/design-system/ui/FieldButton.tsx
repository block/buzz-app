import { Button as BaseButton } from "@base-ui/react/button";
import type { ComponentProps } from "react";
import { CaretDownIcon } from "../icons";

/** A picker trigger with the same perimeter and inset as a text field. */
export function FieldButton({
  children,
  type = "button",
  ...props
}: Omit<ComponentProps<typeof BaseButton>, "className">) {
  return (
    <BaseButton
      {...props}
      type={type}
      data-buzz-ui=""
      className="buzz-input buzz-select-trigger"
    >
      <span className="buzz-select-value">{children}</span>
      <CaretDownIcon
        size={16}
        className="buzz-dropdown-chevron"
        aria-hidden="true"
      />
    </BaseButton>
  );
}
