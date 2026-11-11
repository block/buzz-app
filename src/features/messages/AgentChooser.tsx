import {
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import {
  PopoverRoot,
  PopoverTrigger,
  PopoverPopup,
} from "../../shared/design-system/ui/Popover";
import activityStyles from "../agents/ActivityRows.module.css";
import messageStyles from "./Messages.module.css";
import { useActivityFocusHandoff } from "./use-activity-focus-handoff";
import type { MessageLinkOrigin } from "./MessageRow";

// Base UI mounts popup content only while open; building the rows inside a
// component keeps their per-request activity lookups off closed renders.
function ChooserItems({ items }: { items: () => ReactNode }) {
  return items();
}

/** The compact cue for agents at work: the current step as the trigger,
 * hover for a preview and click for the "Working now" chooser, whose rows
 * `children` build with a `navigate` that closes the popup through Base UI. */
export function AgentChooser({
  label,
  content,
  openTarget,
  directTarget,
  children,
}: {
  label: string;
  content: ReactNode;
  openTarget?:
    | ((target: string, origin?: MessageLinkOrigin) => boolean)
    | undefined;
  directTarget?: string | undefined;
  children(
    navigate: (target: string, origin?: MessageLinkOrigin) => void,
  ): ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  useActivityFocusHandoff(trigger);
  const popup = useRef<HTMLDivElement>(null);
  const keyboardPreview = useRef(false);
  const actions =
    useRef<
      NonNullable<ComponentProps<typeof PopoverRoot>["actionsRef"]>["current"]
    >(null);
  useEffect(() => {
    if (!open) {
      keyboardPreview.current = false;
      return;
    }
    // Hover leaves focus in the composer. Consume Escape before its panel's
    // React handler; Base UI's document-bubble dismissal would arrive too late.
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.keyCode === 229)
        return;
      event.preventDefault();
      event.stopPropagation();
      actions.current?.close();
    };
    document.addEventListener("keydown", dismiss, true);
    return () => document.removeEventListener("keydown", dismiss, true);
  }, [open]);
  const navigate = (target: string, origin?: MessageLinkOrigin) => {
    const previous = document.activeElement;
    // The popup action unmounts after navigation. Existing panel navigation
    // captures activeElement, so give it the retained avatar control instead.
    trigger.current?.focus({ preventScroll: true });
    // Close through Base UI so its hover/press state resets too. A retained
    // conversation keeps this control mounted after navigation.
    if (openTarget?.(target, origin)) {
      if (actions.current) actions.current.close();
      else setOpen(false);
    } else if (previous instanceof HTMLElement)
      previous.focus({ preventScroll: true });
  };
  return (
    <PopoverRoot
      modal={false}
      open={open}
      onOpenChange={(nextOpen, details) => {
        // Base UI tracks compositionstart/end; also honor the native key flags
        // when composition began before this hover popup mounted.
        if (
          details.reason === "escape-key" &&
          details.event instanceof KeyboardEvent &&
          (details.event.isComposing || details.event.keyCode === 229)
        ) {
          details.cancel();
          return;
        }
        setOpen(nextOpen);
      }}
      actionsRef={actions}
    >
      <PopoverTrigger
        ref={trigger}
        openOnHover="preview"
        render={
          <button
            type="button"
            data-buzz-ui=""
            className={messageStyles.activityBubbleTrigger}
            aria-label={label}
            data-agent-activity-trigger=""
            aria-keyshortcuts={directTarget ? "ArrowDown" : undefined}
            aria-description={
              directTarget
                ? "Press Down Arrow for working agents and conversation actions."
                : undefined
            }
            onKeyDown={(event) => {
              if (
                !directTarget ||
                event.key !== "ArrowDown" ||
                event.nativeEvent.isComposing ||
                event.nativeEvent.keyCode === 229 ||
                event.altKey ||
                event.ctrlKey ||
                event.metaKey ||
                event.shiftKey
              )
                return;
              event.preventDefault();
              event.stopPropagation();
              keyboardPreview.current = true;
              setOpen(true);
              popup.current?.focus();
            }}
          >
            {content}
          </button>
        }
      />
      <PopoverPopup
        ref={popup}
        initialFocus={keyboardPreview.current ? popup : undefined}
        size="wide"
        padding="list"
        side="top"
        align="start"
        aria-label="Working now"
      >
        <section
          className={activityStyles.activityList}
          aria-label="Agents working now"
        >
          <ChooserItems items={() => children(navigate)} />
        </section>
      </PopoverPopup>
    </PopoverRoot>
  );
}
