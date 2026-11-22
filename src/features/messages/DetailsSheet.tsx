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
import {
  ArrowSquareOutIcon,
  SidebarRightIcon,
  XIcon,
} from "../../shared/design-system/icons";
import { DialogBarMaterial } from "../../shared/design-system/ui/DialogBarMaterial";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { useFinalFocusUnlessMoved } from "../../shared/design-system/ui/finalFocus";
import type { ComposerOverlayHost } from "./composer-overlay";
import {
  type InlineThreadIntroStep,
  IntroSpotlight,
} from "./InlineThreadIntro";
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

/** Where the sheet sits: around its composer, within the composer's pane. A
 * media sheet (`windowed`) is drawn over the whole window, across the
 * workspace around the pane. */
function geometry(
  { composer, pane, viewport = pane }: ComposerOverlayHost,
  windowed: boolean,
  readerOnly = false,
): CSSProperties {
  // Inside another sheet, positions count from that sheet's padding box.
  const frame = windowed ? null : fixedFrame(pane);
  const frameBox = frame?.getBoundingClientRect();
  const originX = frameBox ? frameBox.left + (frame?.clientLeft ?? 0) : 0;
  const originY = frameBox ? frameBox.top + (frame?.clientTop ?? 0) : 0;
  const frameHeight = frame ? frame.clientHeight : window.innerHeight;
  const local = (box: DOMRect) =>
    new DOMRect(box.left - originX, box.top - originY, box.width, box.height);
  const rect = local(composer.getBoundingClientRect());
  const bounds = local(pane.getBoundingClientRect());
  const workspace = viewport.getBoundingClientRect();
  // The scrim dims the pane's outer surface, clipped to the pane's own region:
  // joined panels share their shell's rounded shape, and their inner panels
  // deliberately have no radius.
  const surface =
    pane.closest<HTMLElement>("[data-details-sheet-surface]") ??
    pane.closest<HTMLElement>("[data-buzz-surface][data-joined]") ??
    pane.closest<HTMLElement>("[data-buzz-surface]") ??
    pane;
  const surfaceBox = surface.getBoundingClientRect();
  const surfaceBounds = local(surfaceBox);
  const surfaceStyle = getComputedStyle(surface);
  const clip = (
    pane.closest<HTMLElement>(
      "[data-details-sheet-surface], [data-overlay-boundary]",
    ) ?? pane
  ).getBoundingClientRect();
  // Over a composer inside another sheet, a panel stacks tightly over that
  // sheet, covering its header, and so does its scrim. Details stop below the
  // header and leave it out of their scrim: its Close still closes both.
  const nested = !!frame?.matches("[data-details-sheet-surface]");
  const header =
    nested && !readerOnly
      ? frame?.querySelector("header")?.getBoundingClientRect()
      : undefined;
  // A region edge at the surface's border extends through that border.
  const inset = (distance: number, border: string) =>
    distance <= Number.parseFloat(border) ? 0 : distance;
  const scrimInset = [
    Math.max(
      inset(clip.top - surfaceBox.top, surfaceStyle.borderTopWidth),
      header ? header.bottom - surfaceBox.top : 0,
    ),
    inset(surfaceBox.right - clip.right, surfaceStyle.borderRightWidth),
    inset(surfaceBox.bottom - clip.bottom, surfaceStyle.borderBottomWidth),
    inset(clip.left - surfaceBox.left, surfaceStyle.borderLeftWidth),
  ]
    .map((value) => `${value}px`)
    .join(" ");
  return {
    "--composer-left": `${rect.left}px`,
    "--composer-width": `${rect.width}px`,
    "--composer-height": `${rect.height}px`,
    "--composer-bottom": `${frameHeight - rect.bottom}px`,
    "--composer-radius": getComputedStyle(composer).borderTopLeftRadius,
    "--frame-height": `${frameHeight}px`,
    // Only a strip of the sheet beneath shows above a panel.
    ...(frame && {
      "--sheet-top":
        nested && readerOnly
          ? `calc(${Math.max(bounds.top, 0)}px + var(--space-4))`
          : `${Math.max(bounds.top, header ? header.bottom - originY : 0)}px`,
    }),
    "--pane-top": `${(windowed ? workspace : bounds).top}px`,
    ...(windowed && {
      "--pane-left": `${workspace.left}px`,
      "--pane-width": `${workspace.width}px`,
      "--composer-pane-bottom": `${workspace.bottom - rect.bottom}px`,
    }),
    "--scrim-top": `${surfaceBounds.top}px`,
    "--scrim-left": `${surfaceBounds.left}px`,
    "--scrim-width": `${surfaceBounds.width}px`,
    "--scrim-height": `${surfaceBounds.height}px`,
    "--scrim-radius": surfaceStyle.borderRadius,
    "--scrim-inset": scrimInset,
  } as CSSProperties;
}

/** Follows the composer while the sheet is mounted: it grows as a reply is
 * typed, and the pane resizes with the window and its splits. It also measures
 * the sheet's header, which a thread reads beneath. */
function useComposerGeometry(
  host: ComposerOverlayHost,
  windowed: boolean,
  readerOnly: boolean,
  mounted: boolean,
  surface: HTMLElement | null,
) {
  const { composer, pane, viewport } = host;
  const [style, setStyle] = useState(() =>
    geometry(host, windowed, readerOnly),
  );
  useLayoutEffect(() => {
    if (!mounted) return;
    const header = surface?.querySelector("header");
    const update = () =>
      setStyle({
        ...geometry({ composer, pane, viewport }, windowed, readerOnly),
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
    if (viewport) observer?.observe(viewport);
    if (header) observer?.observe(header);
    window.addEventListener("resize", update);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [composer, pane, viewport, windowed, readerOnly, mounted, surface]);
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
 * into the composer as it closes. Base UI owns the unmount timing. A media
 * sheet uses an interruptible CSS transition instead. */
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
 * moving focus or draft ownership. A close that interrupts the opening
 * reverses from the painted opacity rather than jumping. */
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
      const prior =
        interrupted.current?.target === target ? interrupted.current : null;
      interrupted.current = null;
      const incoming = target.animate(
        [
          { opacity: prior?.opacity ?? (open ? 0 : 1) },
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
        if (!open) return;
        source.dataset.composerCovered = "";
        for (const animation of animations) animation.cancel();
      };
    };
    start();
    // A thread's reply box, or media's comment box, arrives after its verified
    // root, independently of the sheet's render.
    const observer = new MutationObserver(start);
    if (!started) observer.observe(sheet, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      interrupted.current =
        editor && animations.some((item) => item.playState === "running")
          ? {
              target: editor,
              opacity: getComputedStyle(editor).opacity,
              sourceOpacity: getComputedStyle(source).opacity,
            }
          : null;
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
  closeLabel = "Close",
  finalFocus,
  children,
  containsComposer = false,
  height = "content",
  readerOnly = false,
  tall = false,
  headerActions,
  onClosed,
  onMoveToTab,
  onOpenAsTab,
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
  /** A thread, or media, supplies its own reply box in place of the view's
   * composer. */
  containsComposer?: boolean;
  /** Threads and details fit their content; media takes a stable working
   * area across the workspace, over the whole window. */
  height?: "content" | "stable";
  /** A panel: it takes the full height and covers the composer, which it
   * leaves untouched underneath. */
  readerOnly?: boolean;
  /** Takes the full height while true, as a thread does under a panel, and
   * settles back to its content after. */
  tall?: boolean;
  /** Shown before Close, such as media's gallery controls. */
  headerActions?: ReactNode;
  /** Once a close has finished its motion. */
  onClosed?: (() => void) | undefined;
  /** Hands what this sheet reads to a side-pane tab. */
  onMoveToTab?: (() => void) | undefined;
  /** Closes this sheet and opens what it reads as a tab. */
  onOpenAsTab?: (() => void) | undefined;
  /** The intro step pointing into this sheet: 1 its title, 2 Move to side
   * panel. */
  spotlight?: InlineThreadIntroStep | undefined;
  /** Receives the element the current intro step points at. */
  onSpotlightAnchor?: ((element: HTMLElement | null) => void) | undefined;
}) {
  const { composer } = host;
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  const [surface, setSurface] = useState<HTMLDivElement | null>(null);
  const windowed = height === "stable";
  const style = useComposerGeometry(
    host,
    windowed,
    readerOnly,
    mounted,
    surface,
  );
  // The view's own composer stays usable under a details reader; a thread's
  // reply box replaces it, and a panel covers it, keeping its text.
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
  useComposerHandoff(surface, composer, open, containsComposer);
  const popup = useRef<HTMLDivElement | null>(null);
  const backdrop = useRef<HTMLDivElement | null>(null);
  const grown = useRef<HTMLDivElement | null>(null);
  const focus = useFinalFocusUnlessMoved(finalFocus, undefined);
  const grow = useGrowth();
  // Later changes reverse whatever motion is running.
  useLayoutEffect(() => {
    if (popup.current && !windowed) grow(popup.current, open);
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
        onClosed?.();
        const active = document.activeElement;
        if (active === document.body || popup.current?.contains(active))
          finalFocus?.current?.focus({ preventScroll: true });
      }}
    >
      <BaseDialog.Portal
        // Media is drawn over the window, above the workspace's side panes.
        container={windowed ? document.body : host.pane}
        className={messageStyles.detailsSheetLayer}
        data-workspace-overlay={windowed || undefined}
        data-details-sheet=""
      >
        <BaseDialog.Backdrop
          ref={backdrop}
          forceRender
          className={styles.scrim}
          data-window={windowed || undefined}
          style={style}
        />
        <BaseDialog.Popup
          ref={(element) => {
            // React reattaches this callback each render; grow once per mount.
            if (element && element !== grown.current) {
              grown.current = element;
              setSurface(element);
              if (!windowed) grow(element, true, true);
            }
            popup.current = element;
            focus.ref(element);
          }}
          className={styles.sheet}
          data-details-sheet-surface=""
          data-contained-composer={containsComposer || undefined}
          data-reader-only={readerOnly || undefined}
          data-tall={tall || undefined}
          // Threads and details fit their content and grow with it, up to the
          // maximum; a panel takes the full height (`data-reader-only`), and
          // media a stable area across the workspace.
          data-height={height}
          style={style}
          // A thread places focus in its reply box; a reader takes it itself.
          // Media takes focus at its first control, so its keys work at once.
          initialFocus={windowed ? undefined : containsComposer ? false : popup}
          finalFocus={focus.finalFocus}
          // A panel under its header shows that header's material once
          // scrolled.
          onScrollCapture={
            readerOnly
              ? (event) =>
                  event.currentTarget.toggleAttribute(
                    "data-scrolled",
                    event.target instanceof Element &&
                      event.target.scrollTop > 0,
                  )
              : undefined
          }
        >
          <div className={styles.content}>
            <header className={`buzz-dialog-header ${styles.header}`}>
              {((containsComposer && !windowed) || readerOnly) && (
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
                  <IconButton
                    aria-label="Open as tab"
                    title="Open as tab"
                    variant="glass"
                    shape="round"
                    size="compact"
                    icon={<ArrowSquareOutIcon size={16} aria-hidden="true" />}
                    onClick={onOpenAsTab}
                  />
                )}
                {onMoveToTab && (
                  <IntroSpotlight
                    shape="ring"
                    active={spotlight === 2}
                    anchorRef={onSpotlightAnchor}
                  >
                    <IconButton
                      aria-label="Move to side panel"
                      // An intro step names it while it points here.
                      title={
                        spotlight === undefined
                          ? "Move to side panel"
                          : undefined
                      }
                      variant="glass"
                      shape="round"
                      size="compact"
                      icon={<SidebarRightIcon size={16} aria-hidden="true" />}
                      onClick={onMoveToTab}
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
