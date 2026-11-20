import {
  type InlineThreadIntroStep,
  IntroSpotlight,
} from "./InlineThreadIntro";
import { DialogBarMaterial } from "../../shared/design-system/ui/DialogBarMaterial";
import { spring } from "motion";
import { type ComposerOverlayHost, composerSettled } from "./composer-overlay";
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { ArrowSquareOutIcon, XIcon } from "../../shared/design-system/icons";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { useFinalFocusUnlessMoved } from "../../shared/design-system/ui/finalFocus";
import styles from "./DetailsSheet.module.css";
import messageStyles from "./Messages.module.css";

/** Where the sheet sits: around its composer, within the composer's pane. */
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

function geometry({
  composer,
  pane,
  viewport,
  container,
}: ComposerOverlayHost): CSSProperties {
  // Inside another sheet, positions count from that sheet's padding box.
  const frame = fixedFrame(container);
  const frameBox = frame?.getBoundingClientRect();
  const originX = frameBox ? frameBox.left + (frame?.clientLeft ?? 0) : 0;
  const originY = frameBox ? frameBox.top + (frame?.clientTop ?? 0) : 0;
  const frameHeight = frame ? frame.clientHeight : window.innerHeight;
  const local = (box: DOMRect) =>
    new DOMRect(box.left - originX, box.top - originY, box.width, box.height);
  const rect = local(composer.getBoundingClientRect());
  const bounds = local(viewport.getBoundingClientRect());
  // The reader owns sheet layout; its outer surface owns scrim clipping,
  // including the panel's border and rounded corners. Joined panels share
  // their outer shell surface; their inner panels deliberately have no radius.
  const surface =
    pane.closest<HTMLElement>("[data-details-sheet-surface]") ??
    pane.closest<HTMLElement>("[data-buzz-surface][data-joined]") ??
    pane.closest<HTMLElement>("[data-buzz-surface]") ??
    pane;
  const surfaceBox = surface.getBoundingClientRect();
  const surfaceBounds = local(surfaceBox);
  const surfaceStyle = getComputedStyle(surface);
  const boundary =
    pane.closest<HTMLElement>(
      "[data-details-sheet-surface], [data-overlay-boundary]",
    ) ?? pane;
  const clip = boundary.getBoundingClientRect();
  // Joined splits share the outer rounded shape, but dim only their own region.
  // A boundary at the surface's inner border extends through that border.
  const inset = (distance: number, border: string) =>
    distance <= Number.parseFloat(border) ? 0 : distance;
  const clipInsets = [
    inset(clip.top - surfaceBox.top, surfaceStyle.borderTopWidth),
    inset(surfaceBox.right - clip.right, surfaceStyle.borderRightWidth),
    inset(surfaceBox.bottom - clip.bottom, surfaceStyle.borderBottomWidth),
    inset(clip.left - surfaceBox.left, surfaceStyle.borderLeftWidth),
  ]
    .map((value) => `${value}px`)
    .join(" ");
  // A sheet over a composer inside another sheet stops below that sheet's
  // header, which stays above it.
  const header = frame?.matches("[data-details-sheet-surface]")
    ? frame.querySelector("header")?.getBoundingClientRect()
    : undefined;
  return {
    "--composer-left": `${rect.left}px`,
    "--composer-width": `${rect.width}px`,
    "--composer-height": `${rect.height}px`,
    "--composer-bottom": `${frameHeight - rect.bottom}px`,
    "--composer-pane-bottom": `${bounds.bottom - rect.bottom}px`,
    "--composer-radius": getComputedStyle(composer).borderTopLeftRadius,
    "--frame-height": `${frameHeight}px`,
    ...(frame && {
      "--sheet-top": `${Math.max(bounds.top, header ? header.bottom - originY : 0)}px`,
    }),
    "--pane-top": `${bounds.top}px`,
    "--pane-left": `${bounds.left}px`,
    "--pane-width": `${bounds.width}px`,
    "--pane-height": `${bounds.height}px`,
    "--scrim-top": `${surfaceBounds.top}px`,
    "--scrim-left": `${surfaceBounds.left}px`,
    "--scrim-width": `${surfaceBounds.width}px`,
    "--scrim-height": `${surfaceBounds.height}px`,
    "--scrim-radius": surfaceStyle.borderRadius,
    "--scrim-inset": clipInsets,
  } as CSSProperties;
}

/** Follows the composer while the sheet is mounted: it grows as a reply is
 * typed, and the pane resizes with the window and its splits. */
function useComposerGeometry(
  host: ComposerOverlayHost,
  mounted: boolean,
  surface: HTMLElement | null,
) {
  const { composer, pane, viewport } = host;
  const [style, setStyle] = useState(() => geometry(host));
  useLayoutEffect(() => {
    if (!mounted) return;
    const header = surface?.querySelector("header");
    const update = () =>
      setStyle({
        ...geometry(host),
        "--sheet-border-width": surface
          ? getComputedStyle(surface).borderBottomWidth
          : "0px",
        "--sheet-header-height": `${header?.getBoundingClientRect().height ?? 0}px`,
      } as CSSProperties);
    update();
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(update);
    observer?.observe(composer);
    observer?.observe(pane);
    observer?.observe(viewport);
    if (header) observer?.observe(header);
    window.addEventListener("resize", update);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [host, composer, pane, viewport, mounted, surface]);
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
 * into the composer as it closes. Base UI owns the unmount timing.
 * Workspace media uses an interruptible CSS transition instead. */
function useGrowth() {
  const last = useRef<{ open: boolean; animation?: Animation }>(undefined);
  return (element: HTMLElement, open: boolean, mounting = false) => {
    if (mounting) last.current = undefined;
    const previous = last.current;
    if (previous?.open === open) return;
    // Keep layout at its final size; reveal the surface without stretching
    // its text, media, or editor.
    const painted = getComputedStyle(element);
    const shownClip = painted.clipPath;
    const shownTransform = painted.transform;
    previous?.animation?.cancel();
    last.current = { open };
    if (typeof element.animate !== "function" || immediate()) return;
    const radius = painted.borderRadius;
    const composerHeight = Number.parseFloat(
      token(element, "--composer-height", "0px"),
    );
    const gap = token(element, "--sheet-gap", "8px");
    const composerRadius = token(element, "--composer-radius", radius);
    // Start at the composer's exact outline, including its bottom edge. Grow
    // the surrounding gap as the reader opens; the editor itself never scales.
    const folded = `inset(max(0px, calc(100% - ${composerHeight}px - ${gap})) ${gap} ${gap} round ${composerRadius})`;
    const expanded = `inset(0px 0px 0px round ${radius})`;
    const duration = milliseconds(
      token(
        element,
        open ? "--duration-settle" : "--duration-fast",
        open ? "220ms" : "150ms",
      ),
    );
    const frames: Keyframe[] = [
      {
        clipPath: previous
          ? shownClip === "none"
            ? expanded
            : shownClip
          : folded,
        transform: shownTransform,
      },
      { clipPath: open ? expanded : folded, transform: "none" },
    ];
    // Motion generates a native linear() spring curve; WAAPI retains the
    // existing painted-state reversal and Base UI's animation completion owner.
    const springCurve = spring({
      duration,
      bounce: 0.25,
      keyframes: [0, 1],
    }).toString();
    const springEasing = springCurve.slice(springCurve.indexOf(" ") + 1);
    last.current.animation = element.animate(frames, {
      duration,
      easing:
        open && CSS.supports("animation-timing-function", springEasing)
          ? springEasing
          : token(element, "--easing-enter", "cubic-bezier(0.23, 1, 0.32, 1)"),
      fill: open ? "none" : "forwards",
    });
  };
}

/** Crossfade scoped editors in place without moving their focus or draft ownership. */
function useComposerHandoff(
  sheet: HTMLElement | null,
  source: HTMLElement,
  open: boolean,
  enabled: boolean,
) {
  const interrupted = useRef<{
    target: HTMLElement;
    opacity: string;
    sourceOpacity: string;
  } | null>(null);
  useLayoutEffect(() => {
    if (!sheet || !enabled) return;
    let animations: Animation[] = [];
    let started = false;
    let editor: HTMLElement | null = null;
    const start = () => {
      const target = sheet.querySelector<HTMLElement>(
        "[data-message-composer]",
      );
      if (!target || started) return;
      started = true;
      editor = target;
      if (immediate() || typeof target.animate !== "function") {
        if (open) {
          source.dataset.composerCovered = "";
        }
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
      const prior =
        interrupted.current?.target === target ? interrupted.current : null;
      interrupted.current = null;
      const incoming = target.animate(
        [
          {
            opacity: prior?.opacity ?? (open ? 0 : 1),
          },
          { opacity: open ? 1 : 0 },
        ],
        options,
      );
      const outgoing = source.animate(
        [
          { opacity: prior?.sourceOpacity ?? (open ? 1 : 0) },
          { opacity: open ? 0 : 1 },
        ],
        options,
      );
      animations = [incoming, outgoing];
      incoming.onfinish = () => {
        if (open) {
          source.dataset.composerCovered = "";
          animations.forEach((animation) => {
            animation.cancel();
          });
        }
      };
    };
    start();
    // Media/thread editors arrive after their verified root, independently of
    // the sheet's render. Observe only this popup and animate once per opening.
    const observer = new MutationObserver(start);
    if (!started) observer.observe(sheet, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      if (
        editor &&
        animations.some((animation) => animation.playState === "running")
      ) {
        const painted = getComputedStyle(editor);
        interrupted.current = {
          target: editor,
          opacity: painted.opacity,
          sourceOpacity: getComputedStyle(source).opacity,
        };
      } else {
        interrupted.current = null;
      }
      animations.forEach((animation) => {
        animation.cancel();
      });
      delete source.dataset.composerCovered;
    };
  }, [sheet, source, open, enabled]);
}

/** A details reader that rises out of the conversation's composer, which stays
 * in place below it so a reply can be written while reading. It uses the
 * medium dialog's insets, with its title and Close on one row. */
export function DetailsSheet({
  open,
  onOpenChange,
  host,
  title,
  description,
  leading,
  closeLabel = "Close",
  finalFocus,
  children,
  containsComposer = false,
  height = "content",
  tall = false,
  readerOnly = false,
  headerActions,
  onClosed,
  onOpenAsTab,
  focusContent = false,
  onEscapeKey,
  spotlight,
  onSpotlightAnchor,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  host: ComposerOverlayHost;
  title: ReactNode;
  description?: ReactNode;
  /** Shown before the title, such as its author's avatar. */
  leading?: ReactNode;
  closeLabel?: string;
  finalFocus?: RefObject<HTMLElement | null> | undefined;
  children: ReactNode;
  /** Thread/media content supplies its own correctly scoped composer. */
  containsComposer?: boolean;
  /** Media stages need a bounded working area; threads hug their contents. */
  height?: "content" | "stable";
  /** Takes the full height while true, as a thread does under a panel, and
   * settles back to its content after. */
  tall?: boolean;
  /** Inspector content owns its scrollport and does not expose an editor. */
  readerOnly?: boolean;
  headerActions?: ReactNode;
  onClosed?: () => void;
  /** Opens what this sheet reads in a tab, as its own thread tab or a reader
   * tab, and closes the sheet. Without it there is no Open as tab. */
  onOpenAsTab?: (() => void) | undefined;
  /** The content places focus itself, as a thread opened to reply does;
   * otherwise the sheet takes focus. */
  focusContent?: boolean;
  /** Returns true when it handled Escape, keeping the sheet open. */
  onEscapeKey?: (() => boolean) | undefined;
  /** The intro step pointing into this sheet: 1 its title, 2 Open as tab. */
  spotlight?: InlineThreadIntroStep | undefined;
  /** Receives the element the current intro step points at. */
  onSpotlightAnchor?: ((element: HTMLElement | null) => void) | undefined;
}) {
  const { composer } = host;
  const handing = useRef(false);
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  const [surface, setSurface] = useState<HTMLDivElement | null>(null);
  const style = useComposerGeometry(host, mounted, surface);
  useLayoutEffect(() => {
    if (!mounted || (!containsComposer && !readerOnly)) return;
    if (readerOnly) composer.dataset.composerCovered = "";
    const inert = composer.inert;
    composer.inert = true;
    return () => {
      composer.inert = inert;
      if (readerOnly) delete composer.dataset.composerCovered;
    };
  }, [composer, mounted, containsComposer, readerOnly]);
  const popup = useRef<HTMLDivElement | null>(null);
  const backdrop = useRef<HTMLDivElement | null>(null);
  useComposerHandoff(surface, composer, open, containsComposer);
  const grown = useRef<HTMLDivElement | null>(null);
  const focus = useFinalFocusUnlessMoved(finalFocus, undefined);
  // Base UI hands focus to the first tabbable inside a target that isn't
  // tabbable itself. A revealed message row has tabindex -1, so its author's
  // avatar would take focus and open their profile card. Focus the row instead.
  const resolveFocus = focus.finalFocus;
  const returnFocus: typeof resolveFocus =
    typeof resolveFocus === "function"
      ? (closeType) => {
          const target = resolveFocus(closeType);
          // An owner that cleared its target placed focus itself, as a
          // thread handed to its tab does; Base UI's default would take it.
          if (target === null) return false;
          if (!(target instanceof HTMLElement) || target.tabIndex >= 0)
            return target;
          target.focus({ preventScroll: true });
          return false;
        }
      : resolveFocus;
  const grow = useGrowth();
  // The portal mounts the popup after this effect on first open; its ref
  // starts that growth. Later changes reverse whatever motion is running.
  useLayoutEffect(() => {
    if (popup.current && height !== "stable") grow(popup.current, open);
  });
  return (
    <BaseDialog.Root
      open={open}
      // Expansion belongs to this pane; the rest of the app stays interactive.
      modal={false}
      onOpenChange={(next, details) => {
        if (!next) {
          if (details.reason === "escape-key" && onEscapeKey?.()) {
            details.cancel();
            return;
          }
          const target =
            details.event instanceof FocusEvent
              ? details.event.relatedTarget
              : details.event?.target;
          // Only this pane's scrim dismisses on outside press. Application
          // controls and sibling portalled viewers remain independent.
          if (
            details.reason === "outside-press" &&
            target !== backdrop.current
          ) {
            details.cancel();
            return;
          }
          // Only a press, Escape or Close dismisses it, never moving focus.
          if (details.reason === "focus-out") {
            details.cancel();
            return;
          }
        }
        onOpenChange(next);
      }}
      onOpenChangeComplete={(next) => {
        if (next) return;
        setMounted(false);
        onClosed?.();
        // Once focus has visited the composer, Base UI returns none and Close
        // would leave it on the page; hand it back to the opener instead.
        const active = document.activeElement;
        if (active === document.body || popup.current?.contains(active))
          finalFocus?.current?.focus({ preventScroll: true });
      }}
    >
      <BaseDialog.Portal
        container={host.container}
        className={messageStyles.detailsSheetLayer}
        data-workspace-overlay={host.viewport !== host.pane || undefined}
        data-details-sheet=""
      >
        <BaseDialog.Backdrop
          ref={backdrop}
          forceRender
          className={styles.scrim}
          data-window={height === "stable" || undefined}
          style={style}
        />
        <BaseDialog.Popup
          ref={(element) => {
            // React reattaches this callback each render; grow once per mount.
            if (element && element !== grown.current) {
              grown.current = element;
              setSurface(element);
              if (height !== "stable") grow(element, true, true);
            }
            popup.current = element;
            focus.ref(element);
          }}
          className={styles.sheet}
          data-details-sheet-surface=""
          data-contained-composer={containsComposer || undefined}
          data-reader-only={readerOnly || undefined}
          data-height={height}
          data-tall={tall || undefined}
          style={style}
          // The sheet takes focus itself: its first header action would show
          // a focus tooltip that the first Escape closes instead of the
          // sheet. A reply opening leaves focus for its reply editor.
          initialFocus={focusContent ? false : popup}
          finalFocus={returnFocus}
        >
          <div className={styles.content}>
            {/* One row: who wrote it and when, with Close at its end. */}
            <header className={`buzz-dialog-header ${styles.header}`}>
              {containsComposer && height === "content" && (
                <DialogBarMaterial className={styles.headerMaterial} />
              )}
              <div className={styles.byline}>
                {leading}
                <BaseDialog.Title
                  className={`text-label ${styles.name}`}
                  data-spotlight={spotlight === 1 || undefined}
                >
                  {spotlight === undefined ? (
                    title
                  ) : (
                    <IntroSpotlight
                      shape="pill"
                      active={spotlight === 1}
                      anchorRef={onSpotlightAnchor}
                    >
                      {title}
                    </IntroSpotlight>
                  )}
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
                {headerActions}
                {onOpenAsTab && (
                  <IntroSpotlight
                    shape="ring"
                    active={spotlight === 2}
                    anchorRef={onSpotlightAnchor}
                  >
                    <IconButton
                      aria-label="Open as tab"
                      // An intro step names it while it points here.
                      title={
                        spotlight === undefined ? "Open as tab" : undefined
                      }
                      variant="glass"
                      shape="round"
                      size="compact"
                      icon={<ArrowSquareOutIcon size={16} aria-hidden="true" />}
                      onClick={() => {
                        // Its tab may mount a new composer: let a send
                        // finish first.
                        const sheet = popup.current;
                        if (!sheet || handing.current) return;
                        handing.current = true;
                        void composerSettled(sheet).then(() => {
                          handing.current = false;
                          if (sheet.isConnected) onOpenAsTab();
                        });
                      }}
                    />
                  </IntroSpotlight>
                )}
                <BaseDialog.Close
                  render={
                    <IconButton
                      aria-label={closeLabel}
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
          {!containsComposer && !readerOnly && (
            <div className={styles.composerSpace} aria-hidden="true" />
          )}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
