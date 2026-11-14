import {
  createContext,
  useContext,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { DotsThreeIcon } from "../../shared/design-system/icons";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  PopoverRoot,
  PopoverTrigger,
  PopoverPopup,
} from "../../shared/design-system/ui/Popover";
import { ActionList } from "../../shared/design-system/ui/ActionList";

const HeaderToolsMenu = createContext<{
  trigger: RefObject<HTMLButtonElement | null>;
  finalFocus: RefObject<(() => HTMLElement | false) | undefined>;
  open: boolean;
  close(): void;
} | null>(null);
export const useHeaderToolsMenu = () => useContext(HeaderToolsMenu);

/** Retain each tool's own interaction inside the header's overflow popover. */
export function ConversationHeaderTools({
  actions,
  label = "Conversation actions",
  triggerRef,
}: {
  actions: ReactNode;
  label?: string;
  triggerRef?: RefObject<HTMLButtonElement | null>;
}) {
  const popup = useRef<HTMLDivElement>(null);
  const localTrigger = useRef<HTMLButtonElement>(null);
  const trigger = triggerRef ?? localTrigger;
  const finalFocus = useRef<(() => HTMLElement | false) | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [visited, setVisited] = useState(false);
  if (!actions) return null;
  return (
    <PopoverRoot
      open={open}
      onOpenChange={(open, details) => {
        if (open) {
          setVisited(true);
          finalFocus.current = undefined;
        }
        if (
          !open &&
          details.reason === "trigger-hover" &&
          document.activeElement?.closest(
            '[role="dialog"][aria-modal="true"], [role="alertdialog"]',
          ) &&
          !popup.current?.contains(document.activeElement)
        ) {
          details.cancel();
          return;
        }
        if (
          open ||
          (details.reason !== "focus-out" &&
            details.reason !== "outside-press" &&
            details.reason !== "escape-key")
        ) {
          setOpen(open);
          return;
        }
        // Dialogs belong to the action's existing page/provider owner, so they
        // can be siblings in React. Keep their actual return trigger mounted.
        const target =
          details.reason === "focus-out" && "relatedTarget" in details.event
            ? details.event.relatedTarget
            : details.event.target;
        const dialog =
          target instanceof Element
            ? target.closest(
                '[role="dialog"][aria-modal="true"], [role="alertdialog"], .buzz-dialog-backdrop',
              )
            : null;
        if (
          dialog &&
          dialog !== popup.current &&
          !dialog.contains(trigger.current)
        )
          details.cancel();
        else setOpen(open);
      }}
    >
      <PopoverTrigger
        openOnHover="control"
        render={
          <IconButton
            ref={trigger}
            size="sm"
            variant="glass"
            aria-label={label}
            title={label}
            icon={<DotsThreeIcon size="1rem" />}
          />
        }
      />
      <PopoverPopup
        ref={popup}
        align="end"
        size="compact"
        padding="list"
        keepMounted={visited}
        finalFocus={() =>
          finalFocus.current ? finalFocus.current() : (trigger.current ?? false)
        }
        aria-label={label}
      >
        <HeaderToolsMenu
          value={{ trigger, finalFocus, open, close: () => setOpen(false) }}
        >
          <ActionList onAction={() => setOpen(false)}>{actions}</ActionList>
        </HeaderToolsMenu>
      </PopoverPopup>
    </PopoverRoot>
  );
}
