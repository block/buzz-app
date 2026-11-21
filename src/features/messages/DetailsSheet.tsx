import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { spring } from "motion";
import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { SidebarRightIcon, XIcon } from "../../shared/design-system/icons";
import { DialogBarMaterial } from "../../shared/design-system/ui/DialogBarMaterial";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { useFinalFocusUnlessMoved } from "../../shared/design-system/ui/finalFocus";
import type { ComposerOverlayHost } from "./composer-overlay";
import styles from "./DetailsSheet.module.css";
import messageStyles from "./Messages.module.css";

/** The element fixed descendants of `element` are placed in: the viewport,
 * or an ancestor that filters or transforms, as a sheet's surface does for a
 * sheet opened over a composer inside it. */
function fixedFrame(element: HTMLElement): HTMLElement | null {
  for (
    let node = element.parentElement;
    node && node !== document.documentElement;
    node = node.parentElement
  ) {
    const style = getComputedStyle(node);
    if (
      style.transform !== "none" ||
      style.filter !== "none" ||
      (style.backdropFilter && style.backdropFilter !== "none") ||
      style.perspective !== "none" ||
      /paint|layout|strict|content/.test(style.contain) ||
      /transform|filter|perspective/.test(style.willChange)
    )
      return node;
  }
  return null;
}

/** Where the sheet sits: around its composer, within the composer's pane. */
function geometry({ composer, pane }: ComposerOverlayHost): CSSProperties {
  // Inside another sheet, positions count from that sheet's padding box.
  const frame = fixedFrame(pane);
  const frameBox = frame?.getBoundingClientRect();
  const originX = frameBox ? frameBox.left + (frame?.clientLeft ?? 0) : 0;
  const originY = frameBox ? frameBox.top + (frame?.clientTop ?? 0) : 0;
  const frameHeight = frame ? frame.clientHeight : window.innerHeight;
  const local = (box: DOMRect) =>
    new DOMRect(box.left - originX, box.top - originY, box.width, box.height);
  const rect = local(composer.getBoundingClientRect());
  const bounds = local(pane.getBoundingClientRect());
  // The scrim dims the pane's own surface, clipped to its rounded shape.
  const surface =
    pane.closest<HTMLElement>("[data-details-sheet-surface]") ??
    pane.closest<HTMLElement>("[data-buzz-surface]") ??
    pane;
  const surfaceBounds = local(surface.getBoundingClientRect());
  const surfaceStyle = getComputedStyle(surface);
  // A sheet over a composer inside another sheet stops below that sheet's
  // header, which stays above it.
  const header = frame?.matches("[data-details-sheet-surface]")
    ? frame.querySelector("header")?.getBoundingClientRect()
    : undefined;
  // Nor does its scrim cover that header, whose Close still closes both.
  const scrimTop = header
    ? Math.max(surfaceBounds.top, header.bottom - originY)
    : surfaceBounds.top;
  return {
    "--composer-left": `${rect.left}px`,
    "--composer-width": `${rect.width}px`,
    "--composer-height": `${rect.height}px`,
    "--composer-bottom": `${frameHeight - rect.bottom}px`,
    "--composer-radius": getComputedStyle(composer).borderTopLeftRadius,
    "--frame-height": `${frameHeight}px`,
    ...(frame && {
      "--sheet-top": `${Math.max(bounds.top, header ? header.bottom - originY : 0)}px`,
    }),
    "--pane-top": `${bounds.top}px`,
    "--scrim-top": `${scrimTop}px`,
    "--scrim-left": `${surfaceBounds.left}px`,
    "--scrim-width": `${surfaceBounds.width}px`,
    "--scrim-height": `${surfaceBounds.bottom - scrimTop}px`,
    "--scrim-radius": header
      ? `0 0 ${surfaceStyle.borderBottomRightRadius} ${surfaceStyle.borderBottomLeftRadius}`
      : surfaceStyle.borderRadius,
  } as CSSProperties;
}

/** Follows the composer while the sheet is mounted: it grows as a reply is
 * typed, and the pane resizes with the window and its splits. */
function useComposerGeometry(host: ComposerOverlayHost, mounted: boolean) {
  const { composer, pane } = host;
  const [style, setStyle] = useState(() => geometry(host));
  useLayoutEffect(() => {
    if (!mounted) return;
    const update = () => setStyle(geometry({ composer, pane }));
    update();
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(update);
    observer?.observe(composer);
    observer?.observe(pane);
    window.addEventListener("resize", update);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [composer, pane, mounted]);
  return style;
}

const immediate = () =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ||
  document.documentElement.hasAttribute("data-keyboard-navigation");

/** Motion tokens, read where the sheet paints so scaled themes agree. */
function token(element: Element, name: string, fallback: string) {
  return getComputedStyle(element).getPropertyValue(name).trim() || fallback;
}
const milliseconds = (value: string) =>
  value.endsWith("ms")
    ? Number.parseFloat(value)
    : Number.parseFloat(value) * 1000;

/** Grows the sheet up out of the composer as it opens and folds it back down
 * into the composer as it closes. Base UI owns the unmount timing. */
function useGrowth() {
  const last = useRef<{ open: boolean; animation?: Animation }>(undefined);
  return (element: HTMLElement, open: boolean, mounting = false) => {
    if (mounting) last.current = undefined;
    const previous = last.current;
    if (previous?.open === open) return;
    // Keep layout at its final size; reveal the surface without stretching
    // its text or editor.
    const painted = getComputedStyle(element);
    const shownClip = painted.clipPath;
    previous?.animation?.cancel();
    last.current = { open };
    if (typeof element.animate !== "function" || immediate()) return;
    const radius = painted.borderRadius;
    const composerHeight = Number.parseFloat(
      token(element, "--composer-height", "0px"),
    );
    const gap = token(element, "--sheet-gap", "8px");
    const composerRadius = token(element, "--composer-radius", radius);
    // Start at the composer's exact outline; the editor itself never scales.
    const folded = `inset(max(0px, calc(100% - ${composerHeight}px - ${gap})) ${gap} ${gap} round ${composerRadius})`;
    const expanded = `inset(0px 0px 0px round ${radius})`;
    const duration = milliseconds(
      token(
        element,
        open ? "--duration-settle" : "--duration-fast",
        open ? "220ms" : "150ms",
      ),
    );
    const from = previous
      ? shownClip === "none"
        ? expanded
        : shownClip
      : folded;
    // Motion generates a native linear() spring curve for WAAPI.
    const curve = spring({ duration, bounce: 0.25, keyframes: [0, 1] });
    const springEasing = curve
      .toString()
      .slice(curve.toString().indexOf(" ") + 1);
    last.current.animation = element.animate(
      [{ clipPath: from }, { clipPath: open ? expanded : folded }],
      {
        duration,
        easing:
          open && CSS.supports("animation-timing-function", springEasing)
            ? springEasing
            : token(
                element,
                "--easing-enter",
                "cubic-bezier(0.23, 1, 0.32, 1)",
              ),
        fill: open ? "none" : "forwards",
      },
    );
  };
}

/** Crossfades the view's own composer into the sheet's, in place, without
 * moving focus or draft ownership. */
function useComposerHandoff(
  sheet: HTMLElement | null,
  source: HTMLElement,
  open: boolean,
  enabled: boolean,
) {
  useLayoutEffect(() => {
    if (!sheet || !enabled) return;
    let animations: Animation[] = [];
    let started = false;
    const start = () => {
      const target = sheet.querySelector<HTMLElement>(
        "[data-message-composer]",
      );
      if (!target || started) return;
      started = true;
      if (immediate() || typeof target.animate !== "function") {
        if (open) source.dataset.composerCovered = "";
        return;
      }
      const options: KeyframeAnimationOptions = {
        duration: milliseconds(
          token(sheet, open ? "--duration-settle" : "--duration-fast", "220ms"),
        ),
        easing: token(
          sheet,
          "--easing-enter",
          "cubic-bezier(0.23, 1, 0.32, 1)",
        ),
        fill: "both",
      };
      const incoming = target.animate(
        [{ opacity: open ? 0 : 1 }, { opacity: open ? 1 : 0 }],
        options,
      );
      const outgoing = source.animate(
        [{ opacity: open ? 1 : 0 }, { opacity: open ? 0 : 1 }],
        options,
      );
      animations = [incoming, outgoing];
      incoming.onfinish = () => {
        if (!open) return;
        source.dataset.composerCovered = "";
        for (const animation of animations) animation.cancel();
      };
    };
    start();
    // A thread's reply box arrives after its verified root, independently of
    // the sheet's render.
    const observer = new MutationObserver(start);
    if (!started) observer.observe(sheet, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      for (const animation of animations) animation.cancel();
      delete source.dataset.composerCovered;
    };
  }, [sheet, source, open, enabled]);
}

/** A dialog that rises out of its view's composer, which stays in place below
 * it so a reply can be written while reading. A thread brings its own reply
 * box, which takes the composer's place. */
export function DetailsSheet({
  open,
  onOpenChange,
  host,
  title,
  description,
  leading,
  finalFocus,
  children,
  containsComposer = false,
  onMoveToTab,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  host: ComposerOverlayHost;
  title: ReactNode;
  description?: ReactNode;
  /** Shown before the title, such as its author's avatar. */
  leading?: ReactNode;
  finalFocus?: RefObject<HTMLElement | null> | undefined;
  children: ReactNode;
  /** A thread supplies its own reply box in place of the view's composer. */
  containsComposer?: boolean;
  /** Hands what this sheet reads to a side-pane tab. */
  onMoveToTab?: (() => void) | undefined;
}) {
  const { composer } = host;
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  const [surface, setSurface] = useState<HTMLDivElement | null>(null);
  const style = useComposerGeometry(host, mounted);
  // The view's own composer stays usable under a reader; a thread's reply box
  // replaces it.
  useLayoutEffect(() => {
    if (!mounted || !containsComposer) return;
    const inert = composer.inert;
    composer.inert = true;
    return () => {
      composer.inert = inert;
    };
  }, [composer, mounted, containsComposer]);
  useComposerHandoff(surface, composer, open, containsComposer);
  const popup = useRef<HTMLDivElement | null>(null);
  const backdrop = useRef<HTMLDivElement | null>(null);
  const grown = useRef<HTMLDivElement | null>(null);
  const focus = useFinalFocusUnlessMoved(finalFocus, undefined);
  const grow = useGrowth();
  // Later changes reverse whatever motion is running.
  useLayoutEffect(() => {
    if (popup.current) grow(popup.current, open);
  });
  return (
    <BaseDialog.Root
      open={open}
      // The sheet belongs to this pane; the rest of the app stays interactive.
      modal={false}
      onOpenChange={(next, details) => {
        // Only this pane's scrim dismisses on outside press, and moving focus
        // never does.
        if (
          !next &&
          (details.reason === "focus-out" ||
            (details.reason === "outside-press" &&
              details.event?.target !== backdrop.current))
        ) {
          details.cancel();
          return;
        }
        onOpenChange(next);
      }}
      onOpenChangeComplete={(next) => {
        if (next) return;
        setMounted(false);
        const active = document.activeElement;
        if (active === document.body || popup.current?.contains(active))
          finalFocus?.current?.focus({ preventScroll: true });
      }}
    >
      <BaseDialog.Portal
        container={host.pane}
        className={messageStyles.detailsSheetLayer}
        data-details-sheet=""
      >
        <BaseDialog.Backdrop
          ref={backdrop}
          forceRender
          className={styles.scrim}
          style={style}
        />
        <BaseDialog.Popup
          ref={(element) => {
            // React reattaches this callback each render; grow once per mount.
            if (element && element !== grown.current) {
              grown.current = element;
              setSurface(element);
              grow(element, true, true);
            }
            popup.current = element;
            focus.ref(element);
          }}
          className={styles.sheet}
          data-details-sheet-surface=""
          data-contained-composer={containsComposer || undefined}
          style={style}
          // A thread places focus in its reply box; a reader takes it itself.
          initialFocus={containsComposer ? false : popup}
          finalFocus={focus.finalFocus}
        >
          <div className={styles.content}>
            <header className={`buzz-dialog-header ${styles.header}`}>
              {containsComposer && (
                <DialogBarMaterial className={styles.headerMaterial} />
              )}
              <div className={styles.byline}>
                {leading}
                <BaseDialog.Title className={`text-label ${styles.name}`}>
                  {title}
                </BaseDialog.Title>
                {description && (
                  <BaseDialog.Description
                    className={`buzz-dialog-description ${styles.time}`}
                  >
                    {description}
                  </BaseDialog.Description>
                )}
              </div>
              <div className="buzz-dialog-header-actions">
                {onMoveToTab && (
                  <IconButton
                    aria-label="Move to side panel"
                    title="Move to side panel"
                    variant="glass"
                    shape="round"
                    size="compact"
                    icon={<SidebarRightIcon size={16} aria-hidden="true" />}
                    onClick={onMoveToTab}
                  />
                )}
                <BaseDialog.Close
                  render={
                    <IconButton
                      aria-label="Close"
                      variant="glass"
                      shape="round"
                      size="compact"
                      icon={<XIcon size={16} aria-hidden="true" />}
                    />
                  }
                />
              </div>
            </header>
            <div className={`buzz-dialog-body ${styles.body}`}>
              <div className={styles.reader}>{children}</div>
            </div>
          </div>
          {/* The composer shows through here, inside the sheet's ring. */}
          {!containsComposer && (
            <div className={styles.composerSpace} aria-hidden="true" />
          )}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
