import { Popover as BasePopover } from "@base-ui/react/popover";

export type PopoverActions = BasePopover.Root.Actions;

function Positioner({
  className,
  align = "start",
  sideOffset = 4,
  collisionPadding = 8,
  ...props
}: BasePopover.Positioner.Props) {
  return (
    <BasePopover.Positioner
      {...props}
      align={align}
      sideOffset={sideOffset}
      collisionPadding={collisionPadding}
      className={(state) =>
        [
          "buzz-popover-positioner",
          typeof className === "function" ? className(state) : className,
        ]
          .filter(Boolean)
          .join(" ")
      }
    />
  );
}

function Popup({
  className,
  variant = "default",
  ...props
}: BasePopover.Popup.Props & { variant?: "default" | "flush" }) {
  return (
    <BasePopover.Popup
      {...props}
      data-buzz-ui=""
      data-variant={variant}
      className={(state) =>
        [
          "buzz-popover",
          typeof className === "function" ? className(state) : className,
        ]
          .filter(Boolean)
          .join(" ")
      }
    />
  );
}

/** Shared surface; Base UI owns portals, anchoring, dismissal and focus. */
export const Popover = {
  Root: BasePopover.Root,
  Trigger: BasePopover.Trigger,
  Portal: BasePopover.Portal,
  Positioner,
  Popup,
  Close: BasePopover.Close,
  Title: BasePopover.Title,
  Description: BasePopover.Description,
};
