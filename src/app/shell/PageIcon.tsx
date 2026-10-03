import { useState, type ComponentProps } from "react";
import type { BrowserIcon } from "../../shared/design-system/icons/index";

type PageIconProps = {
  icon: typeof BrowserIcon;
  image?: string | undefined;
  size: number;
  strokeWidth?: ComponentProps<typeof BrowserIcon>["strokeWidth"];
};

const pixelsPerRem = 16;

/**
 * Shows a page's declared image, or `icon` when there is none or the image
 * fails to load. A failed source stays on `icon`; a new source gets one attempt.
 * `strokeWidth` applies to `icon` only.
 */
export function PageIcon({
  icon: Icon,
  image,
  size,
  strokeWidth,
}: PageIconProps) {
  const [failedImage, setFailedImage] = useState<string>();
  if (image !== undefined && image !== failedImage) {
    const length = `${size / pixelsPerRem}rem`;
    return (
      <img
        src={image}
        alt=""
        aria-hidden="true"
        className="object-contain"
        style={{ width: length, height: length }}
        onError={() => setFailedImage(image)}
      />
    );
  }
  return (
    <Icon
      size={size}
      aria-hidden="true"
      {...(strokeWidth === undefined ? {} : { strokeWidth })}
    />
  );
}
