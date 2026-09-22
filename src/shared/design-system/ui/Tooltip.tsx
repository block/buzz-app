import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import {
  cloneElement,
  useId,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";

/** A short supplementary hint. The trigger still owns its accessible name. */
export function Tooltip({
  children,
  content,
}: {
  children: ReactElement<{ "aria-describedby"?: string | undefined }>;
  content: ReactNode;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const describedBy =
    [children.props["aria-describedby"], open ? id : undefined]
      .filter(Boolean)
      .join(" ") || undefined;
  return (
    <BaseTooltip.Root open={open} onOpenChange={setOpen}>
      <BaseTooltip.Trigger
        delay={0}
        // Base UI merges render-element props last. Put the combined link on
        // that element so its original description cannot replace the hint.
        render={cloneElement(children, { "aria-describedby": describedBy })}
      />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner
          side="top"
          sideOffset={4}
          className="buzz-tooltip-positioner"
        >
          <BaseTooltip.Popup
            role="tooltip"
            id={id}
            data-buzz-ui=""
            className="buzz-tooltip"
          >
            {content}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}
