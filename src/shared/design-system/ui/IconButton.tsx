import type { ComponentProps, ReactElement } from "react";
import { Button } from "./Button";

type IconButtonVariant = "quiet" | "ghost" | "solid" | "tint" | "chrome";
type IconButtonSize = "compact" | "toolbar" | "default" | "large";

export type IconButtonProps = Omit<
  ComponentProps<typeof Button>,
  "children" | "size" | "variant"
> & {
  "aria-label": string;
  icon: ReactElement;
  variant?: IconButtonVariant;
  size?: IconButtonSize;
};

export function IconButton({
  icon,
  variant = "ghost",
  size = "default",
  ...props
}: IconButtonProps) {
  return (
    <Button
      {...props}
      variant="ghost"
      data-icon-variant={variant}
      data-icon-size={size}
    >
      {icon}
    </Button>
  );
}
