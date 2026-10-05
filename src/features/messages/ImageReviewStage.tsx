import { useImageGalleryMotion } from "./use-image-gallery-motion";
import { useImageViewport } from "./use-image-viewport";
import { useMediaControls } from "./use-media-controls";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { useCallback, useEffect, useRef, useState } from "react";
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
import { downloadNativeMedia } from "./native-download";
import { copyImageToClipboard, supportsImageCopy } from "./image-copy";

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.25;
const ZOOM_PRESETS = [0.5, 1, 1.5, 2];

type Point = Readonly<{ x: number; y: number }>;

type ImageReviewStageProps = {
  attachments: readonly Attachment[];
  selectedUrl: string;
  media(url: string): string | undefined;
  select(url: string): void;
  onOpenLink(url: string): boolean;
};

export function ImageReviewStage({
  attachments,
  selectedUrl,
  media,
  select,
  onOpenLink,
}: ImageReviewStageProps) {
  const stage = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const previousButton = useRef<HTMLButtonElement>(null);
  const nextButton = useRef<HTMLButtonElement>(null);
  const drag = useRef<
    { pointer: number; origin: Point; offset: Point } | undefined
  >(undefined);
  const [dragging, setDragging] = useState(false);
  const selectedIndex = Math.max(
    0,
    attachments.findIndex((item) => item.url === selectedUrl),
  );
  const selected = attachments[selectedIndex] ?? attachments[0];
  const source = selected ? media(selected.url) : undefined;
  const nativeSource = source ? isNativeMediaSource(source) : false;
  const proxySource = source ? isProxySource(source) || nativeSource : false;
  const [downloadErrorSource, setDownloadErrorSource] = useState<string>();
  const [copying, setCopying] = useState(false);
  const [copyNotice, setCopyNotice] = useState<"success" | "error">();
  const copyBusy = useRef(false);
  const copyNoticeTimer = useRef<number | undefined>(undefined);
  const selectedUrlRef = useRef(selectedUrl);
  selectedUrlRef.current = selectedUrl;
  const externalSource = source ? safeOpenUrl(source) && !proxySource : false;
  const canCopyImage = !!source && supportsImageCopy();
  const {
    zoom,
    offset,
    zoomTo: setBoundedZoom,
    panTo,
    constrain,
  } = useImageViewport(stage, image, source);
  const idle = useMediaControls(stage, source);
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
      // Do not await before this call: WebKit requires clipboard.write to happen
      // inside the user's click gesture.
      await copyImageToClipboard(image.current);
      if (selectedUrlRef.current === copiedUrl) showCopyNotice("success");
    } catch {
      if (selectedUrlRef.current === copiedUrl) showCopyNotice("error");
    } finally {
      copyBusy.current = false;
      setCopying(false);
    }
  }, [clearCopyNotice, selectedUrl, showCopyNotice]);

  const choose = useCallback(
    (index: number) => {
      const item = attachments[index];
      if (!item || item.url === selected?.url) return;
      prepare(index > selectedIndex ? 1 : -1);
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
      data-review-zoomed={zoom !== 1 || undefined}
      className={`${styles.imageReviewStage} ${pannable ? styles.imageReviewPannable : ""} ${dragging ? styles.imageReviewDragging : ""}`}
      onPointerDown={(event) => {
        if (!pannable || event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = {
          pointer: event.pointerId,
          origin: { x: event.clientX, y: event.clientY },
          offset,
        };
        setDragging(true);
      }}
      onPointerMove={(event) => {
        const active = drag.current;
        if (!active || active.pointer !== event.pointerId) return;
        panTo({
          x: active.offset.x + event.clientX - active.origin.x,
          y: active.offset.y + event.clientY - active.origin.y,
        });
      }}
      onPointerUp={(event) => {
        if (drag.current?.pointer !== event.pointerId) return;
        drag.current = undefined;
        setDragging(false);
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onLostPointerCapture={() => {
        drag.current = undefined;
        setDragging(false);
      }}
      onPointerCancel={() => {
        drag.current = undefined;
        setDragging(false);
      }}
    >
      {[
        ...(departing && departing.url !== selected.url ? [departing] : []),
        {
          url: selected.url,
          source,
          transform:
            zoom === 1
              ? "none"
              : `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
        },
      ].map((item) => {
        const current = item.url === selected.url;
        return item.source ? (
          <img
            key={item.url}
            ref={current ? image : undefined}
            data-review-media={current ? "" : undefined}
            data-gallery-departing={!current ? "" : undefined}
            data-review-chrome={!current ? "" : undefined}
            src={item.source}
            alt={current ? "Attachment preview" : ""}
            aria-hidden={!current || undefined}
            draggable={false}
            onLoad={current ? constrain : undefined}
            style={{ transform: item.transform }}
          />
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
            disabled={zoom >= MAX_ZOOM}
            onClick={() => setBoundedZoom(zoom + ZOOM_STEP)}
            icon={<PlusIcon size={16} aria-hidden="true" />}
          />
        </div>
        {source && supportsImageCopy() && (
          <IconButton
            size="sm"
            type="button"
            aria-label="Copy image"
            title="Copy image"
            disabled={!canCopyImage}
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
          <IconButton
            size="sm"
            type="button"
            aria-label="Download image"
            title="Download image"
            onClick={() => {
              setDownloadErrorSource(undefined);
              void downloadNativeMedia(source).catch(() =>
                setDownloadErrorSource(source),
              );
            }}
            icon={<DownloadIcon size={17} />}
          />
        )}
        {downloadErrorSource === source && (
          <span role="alert">Download failed. Try again.</span>
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
