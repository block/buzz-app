import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { useEffect, useRef, useState } from "react";
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
import { isProxySource, safeOpenUrl } from "./attachment-source";
import { copyImageToClipboard, supportsImageCopy } from "./image-copy";
import styles from "./Messages.module.css";

const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.25;

type Point = Readonly<{ x: number; y: number }>;

type ImageReviewStageProps = {
  attachments: readonly Attachment[];
  selectedUrl: string;
  media(url: string): string | undefined;
  select(url: string): void;
  onOpenLink(url: string): boolean;
};

function clamp(value: number, limit: number) {
  return Math.max(-limit, Math.min(limit, value));
}

export function ImageReviewStage({
  attachments,
  selectedUrl,
  media,
  select,
  onOpenLink,
}: ImageReviewStageProps) {
  const stage = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const drag = useRef<
    { pointer: number; origin: Point; offset: Point } | undefined
  >(undefined);
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const [offset, setOffset] = useState<Point>({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [copying, setCopying] = useState(false);
  const [copyNotice, setCopyNotice] = useState<"success" | "error">();
  const copyBusy = useRef(false);
  const copyNoticeTimer = useRef<number | undefined>(undefined);
  const mounted = useRef(false);
  const previousSelectedUrl = useRef(selectedUrl);
  const selectedUrlRef = useRef(selectedUrl);
  selectedUrlRef.current = selectedUrl;
  const selectedIndex = Math.max(
    0,
    attachments.findIndex((item) => item.url === selectedUrl),
  );
  const selected = attachments[selectedIndex] ?? attachments[0];
  const source = selected ? media(selected.url) : undefined;
  const proxySource = source ? isProxySource(source) : false;
  const externalSource = source ? safeOpenUrl(source) && !proxySource : false;
  const canCopyImage = supportsImageCopy();
  const pannable = zoom > MIN_ZOOM;
  const clearCopyNoticeTimer = () => {
    if (copyNoticeTimer.current === undefined) return;
    window.clearTimeout(copyNoticeTimer.current);
    copyNoticeTimer.current = undefined;
  };
  const clearCopyNotice = () => {
    clearCopyNoticeTimer();
    setCopyNotice(undefined);
  };
  const showCopyNotice = (notice: "success" | "error") => {
    if (!mounted.current) return;
    clearCopyNoticeTimer();
    setCopyNotice(notice);
    copyNoticeTimer.current = window.setTimeout(
      () => {
        copyNoticeTimer.current = undefined;
        setCopyNotice(undefined);
      },
      notice === "success" ? 4000 : 6000,
    );
  };

  const panLimits = (nextZoom = zoom) => {
    const frame = stage.current?.getBoundingClientRect();
    const element = image.current;
    if (!frame || !element?.naturalWidth || !element.naturalHeight)
      return { x: 0, y: 0 };
    const fit = Math.min(
      frame.width / element.naturalWidth,
      frame.height / element.naturalHeight,
    );
    const width = element.naturalWidth * fit * nextZoom;
    const height = element.naturalHeight * fit * nextZoom;
    return {
      x: Math.max(0, (width - frame.width) / 2),
      y: Math.max(0, (height - frame.height) / 2),
    };
  };
  const setBoundedZoom = (value: number) => {
    const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value));
    const limits = panLimits(next);
    setZoom(next);
    setOffset((current) => ({
      x: clamp(current.x, limits.x),
      y: clamp(current.y, limits.y),
    }));
  };
  const choose = (index: number) => {
    const item = attachments[index];
    if (!item) return;
    setZoom(MIN_ZOOM);
    setOffset({ x: 0, y: 0 });
    clearCopyNotice();
    select(item.url);
  };
  const copyImage = async () => {
    if (copyBusy.current || !image.current) return;
    const copiedUrl = selectedUrl;
    copyBusy.current = true;
    setCopying(true);
    clearCopyNotice();
    try {
      await copyImageToClipboard(image.current);
      if (selectedUrlRef.current === copiedUrl) showCopyNotice("success");
    } catch {
      if (selectedUrlRef.current === copiedUrl) showCopyNotice("error");
    } finally {
      copyBusy.current = false;
      if (mounted.current) setCopying(false);
    }
  };

  useEffect(() => {
    const reset = () => setBoundedZoom(zoom);
    window.addEventListener("resize", reset);
    return () => window.removeEventListener("resize", reset);
  });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (copyNoticeTimer.current !== undefined) {
        window.clearTimeout(copyNoticeTimer.current);
        copyNoticeTimer.current = undefined;
      }
    };
  }, []);

  if (previousSelectedUrl.current !== selectedUrl) {
    previousSelectedUrl.current = selectedUrl;
    clearCopyNoticeTimer();
    if (copyNotice !== undefined) setCopyNotice(undefined);
  }

  if (!selected || !source)
    return (
      <p className={styles.mediaReviewUnavailable} role="status">
        Image unavailable
      </p>
    );
  return (
    <div
      ref={stage}
      className={`${styles.imageReviewStage} ${pannable ? styles.imageReviewPannable : ""} ${dragging ? styles.imageReviewDragging : ""}`}
      onPointerDown={(event) => {
        if (!pannable) return;
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
        const limits = panLimits();
        setOffset({
          x: clamp(active.offset.x + event.clientX - active.origin.x, limits.x),
          y: clamp(active.offset.y + event.clientY - active.origin.y, limits.y),
        });
      }}
      onPointerUp={(event) => {
        if (drag.current?.pointer !== event.pointerId) return;
        drag.current = undefined;
        setDragging(false);
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => {
        drag.current = undefined;
        setDragging(false);
      }}
    >
      <img
        ref={image}
        src={source}
        alt="Attachment preview"
        draggable={false}
        style={{
          transform: `translate3d(${offset.x}px, ${offset.y}px, 0) scale(${zoom})`,
        }}
      />
      {copyNotice && (
        <div
          className={`${styles.imageReviewCopyNotice} ${copyNotice === "error" ? styles.imageReviewCopyNoticeError : ""}`}
          role={copyNotice === "error" ? "alert" : "status"}
        >
          {copyNotice === "success" ? "Image copied" : "Couldn't copy image"}
        </div>
      )}
      <div
        className={styles.imageReviewToolbar}
        onPointerDown={(event) => event.stopPropagation()}
      >
        {attachments.length > 1 && (
          <div className={styles.imageReviewSwitcher}>
            <IconButton
              size="compact"
              type="button"
              aria-label="Previous image"
              disabled={selectedIndex === 0}
              onClick={() => choose(selectedIndex - 1)}
              icon={<CaretLeftIcon size={18} aria-hidden="true" />}
            />
            <span>
              {selectedIndex + 1} / {attachments.length}
            </span>
            <IconButton
              size="compact"
              type="button"
              aria-label="Next image"
              disabled={selectedIndex === attachments.length - 1}
              onClick={() => choose(selectedIndex + 1)}
              icon={<CaretRightIcon size={18} aria-hidden="true" />}
            />
          </div>
        )}
        <div className={styles.imageReviewZoom}>
          <IconButton
            size="compact"
            type="button"
            aria-label="Zoom out"
            disabled={zoom <= MIN_ZOOM}
            onClick={() => setBoundedZoom(zoom - ZOOM_STEP)}
            icon={<MinusIcon size={16} aria-hidden="true" />}
          />
          <input
            type="range"
            aria-label="Image zoom"
            min={MIN_ZOOM}
            max={MAX_ZOOM}
            step={ZOOM_STEP}
            value={zoom}
            onChange={(event) =>
              setBoundedZoom(Number(event.currentTarget.value))
            }
          />
          <IconButton
            size="compact"
            type="button"
            aria-label="Zoom in"
            disabled={zoom >= MAX_ZOOM}
            onClick={() => setBoundedZoom(zoom + ZOOM_STEP)}
            icon={<PlusIcon size={16} aria-hidden="true" />}
          />
          <Button
            size="sm"
            type="button"
            aria-label="Reset image zoom"
            onClick={() => setBoundedZoom(MIN_ZOOM)}
          >
            {Math.round(zoom * 100)}%
          </Button>
        </div>
        {proxySource && (
          <>
            <IconButton
              size="compact"
              type="button"
              aria-label="Copy image"
              title={canCopyImage ? "Copy image" : "Image copy unavailable"}
              disabled={!canCopyImage || copying}
              onClick={() => void copyImage()}
              icon={<CopyIcon size={17} />}
            />
            <IconButton
              nativeButton={false}
              role="link"
              render={<a href={source} download />}
              size="compact"
              aria-label="Download image"
              title="Download image"
              icon={<DownloadIcon size={17} />}
            />
          </>
        )}
        {externalSource && (
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
            size="compact"
            aria-label="Open image in browser"
            title="Open image in browser"
            icon={<ArrowSquareOutIcon size={17} />}
          />
        )}
      </div>
    </div>
  );
}
