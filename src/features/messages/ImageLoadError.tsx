import type { MouseEvent, Ref } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import {
  ArrowClockwiseIcon,
  WarningCircleIcon,
} from "../../shared/design-system/icons/index";
import styles from "./Messages.module.css";

/** A failed image's status and Retry over its preview. The space it covers
    chooses the layout, so message tiles and the viewer share it. */
export function ImageLoadError({
  ref,
  name = "image",
  retrying,
  onRetry,
}: {
  ref?: Ref<HTMLSpanElement>;
  /** Tells the image apart from its neighbors, e.g. "image 2 of 4". */
  name?: string | undefined;
  retrying: boolean;
  onRetry(): void;
}) {
  const retry = (event: MouseEvent<HTMLButtonElement>) => {
    // Retry never also activates an opener around the image.
    event.stopPropagation();
    onRetry();
  };
  return (
    <span
      ref={ref}
      className={`${styles.imageLoadError} dark`}
      data-color-mode="dark"
    >
      <span className={styles.imageLoadErrorContent}>
        <WarningCircleIcon
          size={20}
          aria-hidden="true"
          style={{ visibility: retrying ? "hidden" : undefined }}
        />
        <span role="status">
          {retrying ? "Loading image…" : "Couldn't load image"}
        </span>
        <Button
          size="sm"
          loading={retrying}
          aria-label={`Retry ${name}`}
          data-image-retry="label"
          onClick={retry}
        >
          Retry
        </Button>
        <IconButton
          size="sm"
          shape="round"
          variant="subtle"
          loading={retrying}
          aria-label={`Couldn't load ${name}. Retry`}
          title={`Couldn't load ${name}. Retry`}
          data-image-retry="icon"
          onClick={retry}
          icon={<ArrowClockwiseIcon size={16} aria-hidden="true" />}
        />
      </span>
    </span>
  );
}

/** Focuses the Retry the error's layout shows; the hidden one takes no focus. */
export function focusRetry(container: Element) {
  for (const retry of container.querySelectorAll<HTMLElement>(
    "[data-image-retry]",
  )) {
    retry.focus({ preventScroll: true });
    if (document.activeElement === retry) return;
  }
}
