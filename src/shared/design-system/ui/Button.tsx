import { Button as BaseButton } from "@base-ui/react/button";
import { makeEventPreventable } from "@base-ui/react/merge-props";
import { CircleNotchIcon } from "../icons/index";
import {
  createContext,
  use,
  type ComponentProps,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import { Tooltip, type HintTiming } from "./Tooltip";

type ButtonVariant =
  | "prominent"
  | "subtle"
  | "glass"
  | "subtle-muted"
  | "ghost"
  | "destructive"
  | "outline"
  | "attention"
  | "glass"
  | "glass-ghost"
  | "inverted"
  | "link"
  | "plain"
  | "primary"
  | "quiet";
type ButtonSize =
  | "caption"
  | "inline"
  | "xs"
  | "sm"
  | "md"
  | "lg"
  | "compact"
  | "default";

export type ButtonProps = Omit<
  ComponentProps<typeof BaseButton>,
  "className"
> & {
  children: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  /** How long the `title` hint waits; see DESIGN.md "Hover timing". */
  hint?: HintTiming;
} & (
    | { shape?: "capsule" | "control" }
    // Icon geometry has no visible label, so it requires an accessible name.
    | { shape: "icon"; "aria-label": string }
  );

/**
 * Base UI makes a Button inside one of its composite widgets, such as a tab
 * list or radio group, a composite item. Those widgets mark their subtree so
 * Buttons there keep Base UI's behavior.
 */
export const CompositeButtons = createContext(false);

/** Base UI owns activation. Legacy variant/size names remain during migration. */
export function Button({
  children,
  variant = "subtle",
  size = "md",
  shape = "capsule",
  type = "button",
  loading = false,
  disabled,
  onClick,
  title,
  hint,
  ...props
}: ButtonProps) {
  // Outside a composite, Base UI's Button only adds a tab stop, disabled
  // guards and pass-through handlers to a native button, so rows full of icon
  // buttons skip its hooks, prop merging and render-element machinery. The
  // choice must not depend on disabled or loading, which would remount it.
  const Control =
    props.render ||
    props.nativeButton === false ||
    typeof props.style === "function" ||
    use(CompositeButtons)
      ? BaseButton
      : NativeButton;
  const control = (
    <Control
      {...props}
      {...(shape === "icon"
        ? {
            "data-icon-variant": variant,
            "data-icon-shape": "control",
            "data-icon-size": size,
          }
        : {})}
      type={type}
      disabled={disabled || loading}
      focusableWhenDisabled={
        props.focusableWhenDisabled ?? (loading && !disabled)
      }
      aria-busy={loading || props["aria-busy"]}
      onClick={(event) => {
        if (loading || disabled) {
          event.preventDefault();
          return;
        }
        onClick?.(preventable(event));
      }}
      data-buzz-ui=""
      className="buzz-button"
      data-variant={
        variant === "primary"
          ? "prominent"
          : variant === "quiet" || variant === "subtle-muted"
            ? "subtle"
            : variant
      }
      data-muted={variant === "subtle-muted" || undefined}
      data-size={size === "compact" ? "sm" : size === "default" ? "md" : size}
      data-button-shape={shape}
      data-loading={loading || undefined}
    >
      {variant === "attention" && (
        <svg
          className="buzz-button-attention"
          aria-hidden="true"
          focusable="false"
        >
          <rect x="0.5" y="0.5" />
        </svg>
      )}
      <span className="buzz-button-label">{children}</span>
      {loading && (
        <CircleNotchIcon
          className="buzz-button-spinner"
          size={18}
          aria-hidden="true"
        />
      )}
    </Control>
  );
  // Keep the native title API at call sites, but share the hint's appearance
  // and dismissal behavior. Content titles on non-controls remain native.
  return title ? (
    <Tooltip content={title} hint={hint} disableHoverablePopup>
      {control}
    </Tooltip>
  ) : (
    control
  );
}

/** What Base UI's Button renders for a native button outside a composite. */
function NativeButton({
  disabled = false,
  focusableWhenDisabled = false,
  nativeButton: _nativeButton,
  render: _render,
  style,
  onClick,
  onMouseDown,
  onKeyDown,
  onKeyUp,
  onPointerDown,
  ...props
}: ComponentProps<typeof BaseButton>) {
  return (
    <button
      tabIndex={0}
      {...(props as ComponentProps<"button">)}
      style={style as ComponentProps<"button">["style"]}
      {...(focusableWhenDisabled
        ? { "aria-disabled": disabled }
        : { disabled })}
      data-disabled={disabled ? "" : undefined}
      onClick={(event) => {
        if (disabled) event.preventDefault();
        else onClick?.(preventable(event));
      }}
      onMouseDown={(event) => {
        if (!disabled) onMouseDown?.(preventable(event));
      }}
      onKeyDown={(event) => {
        // Tabbing away from a focusable disabled button stays possible.
        if (disabled && focusableWhenDisabled && event.key !== "Tab")
          event.preventDefault();
        if (!disabled) onKeyDown?.(preventable(event));
      }}
      onKeyUp={(event) => {
        if (!disabled) onKeyUp?.(preventable(event));
      }}
      onPointerDown={(event) => {
        if (disabled) event.preventDefault();
        else onPointerDown?.(preventable(event));
      }}
    />
  );
}

/** Handlers given to a Base UI Button may defer its own handling. */
function preventable<Event extends SyntheticEvent>(event: Event) {
  return makeEventPreventable(
    event as Parameters<typeof makeEventPreventable<Event>>[0],
  );
}
