import { Input as BaseInput } from "@base-ui/react/input";
import type { ComponentProps } from "react";

export type InputProps = Omit<ComponentProps<typeof BaseInput>, "className"> & {
  controlSize?: "sm" | "md";
};
export function Input({ controlSize = "md", ...props }: InputProps) {
  return (
    <BaseInput
      {...props}
      data-buzz-ui=""
      data-size={controlSize}
      className="buzz-input"
    />
  );
}
