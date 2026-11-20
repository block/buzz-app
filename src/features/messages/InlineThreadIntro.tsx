import { type ReactNode, useEffect, useRef, useState } from "react";
import { ArrowRightIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import {
  PopoverDescription,
  PopoverPopup,
  PopoverRoot,
  PopoverTitle,
} from "../../shared/design-system/ui/Popover";
import { Switch } from "../../shared/design-system/ui/Switch";
import styles from "./InlineThreadIntro.module.css";
import {
  setThreadPlacementPreference,
  useThreadPlacementPreference,
} from "./thread-preferences";

const seenKey = "buzz-inline-thread-intro.v1";

/** Whether this device has already been shown how inline threads work. An
 * unreadable store counts as seen, so the intro never repeats on every open. */
export function inlineThreadIntroSeen(): boolean {
  try {
    return localStorage.getItem(seenKey) === "seen";
  } catch {
    return true;
  }
}

export function markInlineThreadIntroSeen(): void {
  try {
    localStorage.setItem(seenKey, "seen");
  } catch {
    // The intro stays for this thread; it may show once more next launch.
  }
}

/** Step 1 points at the thread's title; step 2 at its pop-out button. */
export type InlineThreadIntroStep = 1 | 2;

/** The first inline thread explains itself in two anchored steps: where to
 * read and reply, then how to move it into a tab or turn inline threads off.
 * It lives with its thread sheet and never takes focus from its composer. */
export function InlineThreadIntro({
  step,
  anchor,
  onNext,
  onDone,
}: {
  step: InlineThreadIntroStep;
  anchor: HTMLElement | null;
  onNext(): void;
  onDone(): void;
}) {
  const { placement } = useThreadPlacementPreference();
  // Next hands focus to step 2 once it mounts at its anchor.
  const focusStep = useRef(false);
  const done = () => {
    markInlineThreadIntroSeen();
    // Focus would fall to the page with the tip: give it to the thread's
    // reply editor, or else to Open as tab.
    const sheet = anchor?.closest("[data-details-sheet-surface]");
    const active = document.activeElement;
    if (
      sheet &&
      (!active ||
        active === document.body ||
        active.closest("[data-inline-thread-intro]"))
    )
      (
        sheet.querySelector<HTMLElement>(
          '[data-message-composer] [role="textbox"]',
        ) ?? anchor?.querySelector<HTMLElement>("button")
      )?.focus({ preventScroll: true });
    onDone();
  };
  return (
    <PopoverRoot
      open={!!anchor}
      modal={false}
      onOpenChange={(open, details) => {
        if (open) return;
        // Reading or replying in the thread keeps the tip; Escape finishes it.
        if (
          details.reason === "outside-press" ||
          details.reason === "focus-out"
        ) {
          details.cancel();
          return;
        }
        done();
      }}
    >
      <PopoverPopup
        key={step}
        anchor={anchor}
        side="bottom"
        align={step === 1 ? "start" : "end"}
        // Each step stays below what it points at, rather than flipping.
        collisionAvoidance={{ side: "none", align: "shift" }}
        initialFocus={false}
        finalFocus={false}
        data-inline-thread-intro={step}
      >
        <div
          ref={(element) => {
            if (!element || !focusStep.current) return;
            focusStep.current = false;
            element
              .querySelector<HTMLElement>("button, input")
              ?.focus({ preventScroll: true });
          }}
        >
          <p className={`text-label-sm ${styles.step}`}>{step} of 2</p>
          {step === 1 ? (
            <>
              <PopoverTitle>Threads can now open without a tab</PopoverTitle>
              <PopoverDescription>
                Read the replies here, then write yours in the composer below.
              </PopoverDescription>
              <div className={styles.next}>
                <Button
                  type="button"
                  size="sm"
                  variant="prominent"
                  onClick={() => {
                    focusStep.current = true;
                    onNext();
                  }}
                >
                  Next
                  <ArrowRightIcon size={16} aria-hidden="true" />
                </Button>
              </div>
            </>
          ) : (
            <>
              <PopoverTitle>Open in a tab anytime</PopoverTitle>
              <PopoverDescription>
                Use this button to move the thread into its own tab. You can
                make opening in a tab the default anytime in Settings, or switch
                it back with the toggle below.
              </PopoverDescription>
              <div className={styles.actions}>
                <Switch
                  label="Open threads inline"
                  checked={placement === "inline"}
                  onCheckedChange={(inline) => {
                    // Off restores the earlier default; this sheet stays open.
                    setThreadPlacementPreference(inline ? "inline" : "side");
                    markInlineThreadIntroSeen();
                  }}
                />
                <Button type="button" size="sm" onClick={done}>
                  Got it
                </Button>
              </div>
            </>
          )}
        </div>
      </PopoverPopup>
    </PopoverRoot>
  );
}

/** Marks the control an intro step points at, and gives the step its anchor
 * once the sheet around it has settled, so the step opens where it stays. */
export function IntroSpotlight({
  active,
  shape,
  anchorRef,
  children,
}: {
  active: boolean;
  /** A pill behind a title, or a ring around a round button. */
  shape: "pill" | "ring";
  anchorRef?: ((element: HTMLElement | null) => void) | undefined;
  children: ReactNode;
}) {
  const [element, setElement] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!active || !element || !anchorRef) return;
    let current = true;
    const sheet = element.closest("[data-details-sheet-surface]");
    void Promise.all(
      (sheet?.getAnimations?.() ?? []).map((animation) =>
        animation.finished.catch(() => {}),
      ),
    ).then(() => {
      if (current) anchorRef(element);
    });
    return () => {
      current = false;
      anchorRef(null);
    };
  }, [active, element, anchorRef]);
  return (
    <span
      ref={setElement}
      className={styles.spotlight}
      data-shape={shape}
      data-active={active || undefined}
    >
      {children}
    </span>
  );
}
