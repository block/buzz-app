import { createContext, useContext } from "react";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { MenuIcon } from "../../shared/design-system/icons";

/** The collection host owns visibility; conversation headers only expose its control. */
export const ConversationListVisibility = createContext<{
  open: boolean;
  animate: boolean;
  label: string;
  controls: string;
  setOpen(open: boolean, animate?: boolean): void;
} | null>(null);

export function ConversationListToggle({
  inList = false,
}: {
  inList?: boolean;
}) {
  const list = useContext(ConversationListVisibility);
  if (!list) return null;
  const label = `${list.open ? "Hide" : "Show"} ${list.label} list`;
  return (
    <span className="flex min-w-0 items-center gap-2">
      <IconButton
        size="sm"
        variant="glass"
        data-highlight-expanded="false"
        aria-label={label}
        title={label}
        aria-controls={list.controls}
        aria-expanded={list.open}
        icon={<MenuIcon size={18} />}
        onClick={(event) => {
          list.setOpen(!list.open, event.detail > 0);
          if (inList && list.open) {
            const panel = document
              .getElementById(list.controls)
              ?.closest("[data-list-controlled]");
            const reader = panel?.querySelector(
              '[aria-label="Conversation detail"]',
            );
            Array.from(
              reader?.querySelectorAll<HTMLButtonElement>(
                "button[aria-controls]",
              ) ?? [],
            )
              .find(
                (button) =>
                  button.getAttribute("aria-controls") === list.controls &&
                  button.getClientRects().length > 0,
              )
              ?.focus({ preventScroll: true });
          }
        }}
      />
      {!list.open && (
        <span className="truncate text-label-sm text-standard">
          {list.label}
        </span>
      )}
    </span>
  );
}
