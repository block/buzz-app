import { useImageGalleryMotion } from "./use-image-gallery-motion";
import {
  usePrefetchedPreviews,
  useWarmOriginals,
  warmable,
} from "./use-gallery-preload";
import { BLURHASH_SIZE, paintBlurhash } from "./blurhash";
import { MIN_ZOOM, useImageViewport } from "./use-image-viewport";
import { useMediaControls } from "./use-media-controls";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import {
  ArrowSquareOutIcon,
  CaretLeftIcon,
  CaretRightIcon,
  CopyIcon,
  DownloadIcon,
  MinusIcon,
  PlusIcon,
} from "../../shared/design-system/icons/index";
import type { Attachment } from "../relay/contracts";
import {
  isNativeMediaSource,
  isProxySource,
  safeOpenUrl,
} from "./attachment-source";
import styles from "./Messages.module.css";
import { MediaDownloadAction } from "./MediaDownloadAction";
import { copyImageToClipboard, supportsImageCopy } from "./image-copy";
import { copyNativeImage } from "./native-image-copy";

const ZOOM_STEP = 0.25;
const ZOOM_PRESETS = [0.5, 1, 1.5, 2];

type Point = Readonly<{ x: number; y: number }>;
// Pointer travel beyond this is a pan, not a click.
const CLICK_SLOP = 4;

type ImageReviewStageProps = {
  attachments: readonly Attachment[];
  selectedUrl: string;
  media(url: string): string | undefined;
  select(url: string): void;
  onOpenLink(url: string): boolean;
  allowCopy?: boolean;
  /** Smaller rendition of the same picture, shown while the original loads. */
  preview?(attachment: Attachment): string | undefined;
};

/** Whether the selected original has loaded and decoded; `cached` when it was
 * already complete on arrival, so its preview never shows. */
type Original = { source: string; decoded: boolean; cached?: true };

export function ImageReviewStage({
  attachments,
  selectedUrl,
  media,
  select,
  onOpenLink,
  allowCopy = true,
  preview,
}: ImageReviewStageProps) {
  const stage = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const previousButton = useRef<HTMLButtonElement>(null);
  const nextButton = useRef<HTMLButtonElement>(null);
  const press = useRef<
    | {
        pointer: number;
        origin: Point;
        offset: Point;
        panning: boolean;
        // Cleared by pointer travel, a second contact, pressing off the decoded
        // image (a preview is not the picture), or a source change during the press.
        click: boolean;
      }
    | undefined
  >(undefined);
  const zoomHint = useId();
  const [dragging, setDragging] = useState(false);
  const selectedIndex = Math.max(
    0,
    attachments.findIndex((item) => item.url === selectedUrl),
  );
  const selected = attachments[selectedIndex] ?? attachments[0];
  const source = selected ? media(selected.url) : undefined;
  // A press that outlives its image must not zoom any later one, even when
  // navigation returns to the same source.
  useLayoutEffect(() => {
    void source;
    if (press.current) press.current.click = false;
  }, [source]);
  // The original stays hidden until it loads, so a partial picture never
  // shows, and its preview fades out once it has decoded. A failed original
  // keeps its preview.
  const [original, setOriginal] = useState<Original>();
  const settled = original?.source === source ? original : undefined;
  const loading = !!source && !settled;
  const decoded = !!settled?.decoded;
  useLayoutEffect(() => {
    const element = image.current;
    if (!element || !source) return;
    if (element.complete) {
      setOriginal({ source, decoded: element.naturalWidth > 0, cached: true });
      return;
    }
    // A fresh element for a source settled earlier starts loading again.
    setOriginal(undefined);
    let active = true;
    const settle = (decoded: boolean) => {
      if (active) setOriginal({ source, decoded });
    };
    const loaded = async () => {
      settle(false);
      try {
        await element.decode();
        settle(true);
      } catch {
        // Decode rejection keeps the preview, as a load error does.
      }
    };
    const failed = () => settle(false);
    element.addEventListener("load", loaded);
    element.addEventListener("error", failed);
    return () => {
      active = false;
      element.removeEventListener("load", loaded);
      element.removeEventListener("error", failed);
    };
  }, [source]);
  const [travel, setTravel] = useState(1);
  const failedPreviews = usePrefetchedPreviews(
    preview ? attachments.flatMap((item) => preview(item) ?? []) : [],
  );
  const release = useWarmOriginals(
    attachments.map((item) => (warmable(item) ? media(item.url) : undefined)),
    selectedIndex,
    travel,
  );
  const nativeSource = source ? isNativeMediaSource(source) : false;
  const proxySource = source ? isProxySource(source) || nativeSource : false;
  const [downloadFeedbackVisible, setDownloadFeedbackVisible] = useState(false);
  const [copying, setCopying] = useState(false);
  const [copyNotice, setCopyNotice] = useState<"success" | "error">();
  const copyBusy = useRef(false);
  const copyNoticeTimer = useRef<number | undefined>(undefined);
  const selectedUrlRef = useRef(selectedUrl);
  selectedUrlRef.current = selectedUrl;
  const externalSource = source ? safeOpenUrl(source) && !proxySource : false;
  const canCopyImage =
    allowCopy && proxySource && (nativeSource || supportsImageCopy());
  const {
    zoom,
    offset,
    maxZoom,
    zoomTo: setBoundedZoom,
    toggleZoomAt,
    panTo,
    constrain,
  } = useImageViewport(stage, image, source);
  const copyFeedbackVisible = copying || copyNotice !== undefined;
  const feedbackVisible = copyFeedbackVisible || downloadFeedbackVisible;
  const idle = useMediaControls(stage, source, feedbackVisible);
  const pannable = zoom > 1;
  const nextZoom = ZOOM_PRESETS.find((preset) => preset > zoom) ?? MIN_ZOOM;
  const { departing, prepare } = useImageGalleryMotion(
    stage,
    image,
    selected?.url,
    source,
  );

  const clearCopyNoticeTimer = useCallback(() => {
    if (copyNoticeTimer.current === undefined) return;
    window.clearTimeout(copyNoticeTimer.current);
    copyNoticeTimer.current = undefined;
  }, []);
  const clearCopyNotice = useCallback(() => {
    clearCopyNoticeTimer();
    setCopyNotice(undefined);
  }, [clearCopyNoticeTimer]);
  const showCopyNotice = useCallback(
    (notice: "success" | "error") => {
      clearCopyNoticeTimer();
      setCopyNotice(notice);
      copyNoticeTimer.current = window.setTimeout(
        () => {
          copyNoticeTimer.current = undefined;
          setCopyNotice(undefined);
        },
        notice === "success" ? 4000 : 6000,
      );
    },
    [clearCopyNoticeTimer],
  );
  const copyImage = useCallback(async () => {
    if (copyBusy.current || !image.current) return;
    const copiedUrl = selectedUrl;
    copyBusy.current = true;
    setCopying(true);
    clearCopyNotice();
    try {
      // The broker path must invoke clipboard.write synchronously in the gesture.
      // Native media instead stays in the authenticated host boundary.
      if (nativeSource && source) await copyNativeImage(source);
      else await copyImageToClipboard(image.current);
      if (selectedUrlRef.current === copiedUrl) showCopyNotice("success");
    } catch {
      if (selectedUrlRef.current === copiedUrl) showCopyNotice("error");
    } finally {
      copyBusy.current = false;
      setCopying(false);
    }
  }, [clearCopyNotice, nativeSource, source, selectedUrl, showCopyNotice]);

  const choose = useCallback(
    (index: number) => {
      const item = attachments[index];
      if (!item || item.url === selected?.url) return;
      const direction = index > selectedIndex ? 1 : -1;
      setTravel(direction);
      prepare(direction, decoded);
      // An original left before it loaded keeps downloading only while it
      // stays within the preload window.
      if (image.current) release(image.current);
      setBoundedZoom(1);
      clearCopyNotice();
      const active = document.activeElement;
      const keepsNavigationFocus =
        (active === previousButton.current && index > 0) ||
        (active === nextButton.current && index < attachments.length - 1);
      if (!keepsNavigationFocus) stage.current?.focus({ preventScroll: true });
      select(item.url);
    },
    [
      attachments,
      setBoundedZoom,
      select,
      selected?.url,
      selectedIndex,
      prepare,
      decoded,
      release,
      clearCopyNotice,
    ],
  );
  useEffect(() => {
    if (attachments.length < 2) return;
    const keydown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
      )
        return;
      const viewer = stage.current?.closest('[role="dialog"]') ?? stage.current;
      const target = event.target;
      // A disabled end-arrow or a click on the picture can leave focus on body.
      const modalHasBodyFocus =
        target === document.body &&
        viewer?.getAttribute("aria-modal") === "true" &&
        !viewer.closest('[inert], [aria-hidden="true"]');
      if (
        !viewer ||
        !(target instanceof Element) ||
        (!viewer.contains(target) && !modalHasBodyFocus) ||
        target.closest(
          'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="slider"], [role="menu"], [role="listbox"]',
        ) ||
        (target.closest('[role="dialog"]') &&
          target.closest('[role="dialog"]') !== viewer)
      )
        return;
      event.preventDefault();
      choose(selectedIndex + (event.key === "ArrowRight" ? 1 : -1));
    };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [attachments.length, selectedIndex, choose]);

  useEffect(() => clearCopyNoticeTimer, [clearCopyNoticeTimer]);

  if (!selected)
    return (
      <p className={styles.mediaReviewUnavailable} role="status">
        Image unavailable
      </p>
    );
  return (
    // biome-ignore lint/a11y/useSemanticElements: This groups gallery media and navigation, not form fields.
    <div
      ref={stage}
      role="group"
      aria-label="Image gallery"
      tabIndex={-1}
      data-controls-idle={idle || undefined}
      data-controls-revealed={feedbackVisible || undefined}
      data-review-zoomed={zoom !== 1 || undefined}
      className={`${styles.imageReviewStage} ${pannable ? styles.imageReviewPannable : ""} ${dragging ? styles.imageReviewDragging : ""}`}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        if (press.current) {
          // Multi-touch is not a click; the first contact keeps the pan.
          press.current.click = false;
          return;
        }
        press.current = {
          pointer: event.pointerId,
          origin: { x: event.clientX, y: event.clientY },
          offset,
          panning: pannable,
          click: event.isPrimary && event.target === image.current && decoded,
        };
        // Capture so the release always ends this press, even off the stage.
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(pannable);
      }}
      onPointerMove={(event) => {
        const active = press.current;
        if (!active || active.pointer !== event.pointerId) return;
        const dx = event.clientX - active.origin.x;
        const dy = event.clientY - active.origin.y;
        if (Math.hypot(dx, dy) > CLICK_SLOP) active.click = false;
        if (active.panning)
          panTo({ x: active.offset.x + dx, y: active.offset.y + dy });
      }}
      onPointerUp={(event) => {
        const active = press.current;
        if (active?.pointer !== event.pointerId) return;
        press.current = undefined;
        setDragging(false);
        event.currentTarget.releasePointerCapture(event.pointerId);
        if (active.click) toggleZoomAt(event.clientX, event.clientY);
      }}
      onLostPointerCapture={(event) => {
        if (press.current?.pointer !== event.pointerId) return;
        press.current = undefined;
        setDragging(false);
      }}
      onPointerCancel={(event) => {
        if (press.current?.pointer !== event.pointerId) return;
        press.current = undefined;
        setDragging(false);
      }}
    >
      {[
        ...(departing && departing.url !== selected.url ? [departing] : []),
        {
          url: selected.url,
          source,
          decoded,
          transform:
            zoom === 1
              ? "none"
              : `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
        },
      ].map((item) => {
        const current = item.url === selected.url;
        const attachment = attachments.find(({ url }) => url === item.url);
        const thumbnail = attachment && preview?.(attachment);
        // A departing original that never decoded leaves as its preview.
        const covered = current ? !(settled?.cached && decoded) : !item.decoded;
        return item.source ? (
          <Fragment key={item.url}>
            {(current || item.decoded) && (
              <img
                ref={current ? image : undefined}
                data-review-media={current ? "" : undefined}
                data-gallery-departing={!current ? "" : undefined}
                data-gallery-loading={(current && loading) || undefined}
                data-review-chrome={!current ? "" : undefined}
                src={item.source}
                alt={current ? "Attachment preview" : ""}
                aria-describedby={current ? zoomHint : undefined}
                aria-hidden={!current || undefined}
                draggable={false}
                fetchPriority={current ? "high" : undefined}
                onLoad={current ? constrain : undefined}
                style={{ transform: item.transform }}
              />
            )}
            {covered && attachment && (
              <GalleryPreview
                attachment={attachment}
                thumbnail={
                  thumbnail && !failedPreviews.has(thumbnail)
                    ? thumbnail
                    : undefined
                }
                departing={!current}
                ready={current && decoded}
                transform={item.transform}
              />
            )}
          </Fragment>
        ) : (
          <p
            key={item.url}
            className={styles.mediaReviewUnavailable}
            role="status"
          >
            Image unavailable
          </p>
        );
      })}
      <p id={zoomHint} className="sr-only">
        Click the image to zoom.
      </p>
      <div
        className={styles.imageReviewToolbar}
        data-image-controls=""
        data-review-chrome=""
        onPointerDown={(event) => event.stopPropagation()}
      >
        {attachments.length > 1 && (
          <div className={styles.imageReviewSwitcher}>
            <IconButton
              size="sm"
              type="button"
              ref={previousButton}
              aria-label="Previous image"
              disabled={selectedIndex === 0}
              onClick={() => choose(selectedIndex - 1)}
              icon={<CaretLeftIcon size={18} aria-hidden="true" />}
            />
            <span aria-live="polite" aria-atomic="true">
              {selectedIndex + 1} / {attachments.length}
            </span>
            <IconButton
              size="sm"
              type="button"
              ref={nextButton}
              aria-label="Next image"
              disabled={selectedIndex === attachments.length - 1}
              onClick={() => choose(selectedIndex + 1)}
              icon={<CaretRightIcon size={18} aria-hidden="true" />}
            />
          </div>
        )}
        <div className={styles.imageReviewZoom}>
          <IconButton
            size="sm"
            type="button"
            aria-label="Zoom out"
            disabled={zoom <= MIN_ZOOM}
            onClick={() => setBoundedZoom(zoom - ZOOM_STEP)}
            icon={<MinusIcon size={16} aria-hidden="true" />}
          />
          <Button
            variant="ghost"
            size="sm"
            type="button"
            aria-label={`Image zoom: ${Math.round(zoom * 100)}%. Zoom to ${nextZoom * 100}%`}
            onClick={() => setBoundedZoom(nextZoom)}
          >
            {Math.round(zoom * 100)}%
          </Button>
          <IconButton
            size="sm"
            type="button"
            aria-label="Zoom in"
            disabled={zoom >= maxZoom}
            onClick={() => setBoundedZoom(zoom + ZOOM_STEP)}
            icon={<PlusIcon size={16} aria-hidden="true" />}
          />
        </div>
        {canCopyImage && (
          <IconButton
            hint="familiar"
            size="sm"
            type="button"
            aria-label="Copy image"
            title="Copy image"
            disabled={!decoded}
            loading={copying}
            onClick={() => void copyImage()}
            icon={<CopyIcon size={17} aria-hidden="true" />}
          />
        )}
        {copyNotice && (
          <span role={copyNotice === "error" ? "alert" : "status"}>
            {copyNotice === "success" ? "Image copied" : "Couldn't copy image"}
          </span>
        )}
        {nativeSource && source && (
          <MediaDownloadAction
            key={JSON.stringify([selected.url, source, selected.name])}
            kind="image"
            source={source}
            name={selected.name ?? ""}
            onFeedbackVisible={setDownloadFeedbackVisible}
          />
        )}
        {proxySource && !nativeSource && (
          <IconButton
            nativeButton={false}
            role="link"
            render={<a href={source} download />}
            size="sm"
            aria-label="Download image"
            title="Download image"
            icon={<DownloadIcon size={17} />}
          />
        )}
        {source && externalSource && (
          <IconButton
            nativeButton={false}
            role="link"
            render={
              <a
                href={source}
                target="_blank"
                rel="noreferrer"
                onClick={(event) => {
                  if (event.metaKey || event.ctrlKey || event.shiftKey) return;
                  if (onOpenLink(source)) event.preventDefault();
                }}
              />
            }
            size="sm"
            aria-label="Open image in browser"
            title="Open image in browser"
            icon={<ArrowSquareOutIcon size={17} />}
          />
        )}
      </div>
    </div>
  );
}

/** Stands in for an original until it decodes: its relay thumbnail, else a
 * frame in its `dim` aspect ratio painted with its blurhash or a flat fill. */
function GalleryPreview({
  attachment,
  thumbnail,
  departing,
  ready,
  transform,
}: {
  attachment: Attachment;
  thumbnail: string | undefined;
  departing: boolean;
  ready: boolean;
  transform: string;
}) {
  const [thumbnailFailed, setThumbnailFailed] = useState(false);
  const shared = {
    "data-gallery-departing": departing ? "" : undefined,
    "data-gallery-ready": ready ? "" : undefined,
    "data-review-chrome": "",
    "aria-hidden": true,
    style: { transform },
  } as const;
  if (thumbnail && !thumbnailFailed)
    return (
      <img
        {...shared}
        data-gallery-preview="thumbnail"
        src={thumbnail}
        alt=""
        draggable={false}
        onError={() => setThumbnailFailed(true)}
      />
    );
  const { width = 0, height = 0 } = attachment.dimensions ?? {};
  if (!(width > 0 && height > 0)) return null;
  return (
    <PreviewFrame
      {...shared}
      width={width}
      height={height}
      hash={attachment.blurhash}
    />
  );
}

function PreviewFrame({
  width,
  height,
  hash,
  ...props
}: ComponentProps<"canvas"> & {
  width: number;
  height: number;
  hash: string | undefined;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  // A raster in the original's ratio, so `object-fit: contain` matches it.
  const scale = BLURHASH_SIZE / Math.max(width, height);
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  useLayoutEffect(() => {
    const element = canvas.current;
    const context = element?.getContext("2d");
    if (!element || !context) return;
    // CSS owns the fill, which stays when there is no blurhash or it cannot
    // be painted.
    context.fillStyle = getComputedStyle(element).color;
    context.fillRect(0, 0, w, h);
    if (hash) paintBlurhash(element, hash, w, h);
  }, [hash, w, h]);
  return (
    <canvas
      {...props}
      ref={canvas}
      width={w}
      height={h}
      data-gallery-preview={hash ? "blurhash" : "fill"}
    />
  );
}
