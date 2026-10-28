import type { ComponentProps, ReactElement } from "react";
import { Button, type ButtonProps } from "./Button";

type IconButtonVariant =
  | NonNullable<ButtonProps["variant"]>
  | "destructive-quiet"
  | "solid"
  | "tint"
  | "chrome"
  | "avatar"
  | "media"
  | "bare";
type IconButtonSize =
  | NonNullable<ButtonProps["size"]>
  | "xs"
  | "toolbar"
  | "large";
type IconButtonShape = "inset" | "control" | "round" | "row-end" | "squircle";

export type IconButtonProps = Omit<
  ComponentProps<typeof Button>,
  "children" | "size" | "variant" | "shape"
> & {
  "aria-label": string;
  icon: ReactElement;
  variant?: IconButtonVariant;
  size?: IconButtonSize;
  shape?: IconButtonShape;
};

export function IconButton({
  icon,
  variant = "ghost",
  size = "sm",
  shape: shapeProp,
  ...props
}: IconButtonProps) {
  "use memo";
  // Defaults that read other props stay out of the parameter list, where the
  // React Compiler cannot order them.
  const shape = shapeProp ?? (variant === "avatar" ? "round" : "control");
  return (
    <Button
      {...props}
      variant={
        variant === "destructive-quiet"
          ? "destructive"
          : variant === "solid"
            ? "prominent"
            : variant === "tint" ||
                variant === "chrome" ||
                variant === "avatar" ||
                variant === "media" ||
                variant === "bare"
              ? "ghost"
              : variant
      }
      size={
        size === "xs" || size === "toolbar"
          ? "sm"
          : size === "large"
            ? "lg"
            : size
      }
      data-icon-variant={variant}
      data-icon-size={size}
      data-icon-shape={shape}
    >
      {icon}
    </Button>
  );
}
