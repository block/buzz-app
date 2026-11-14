import { useMemo, useState, type ComponentProps } from "react";
import type { BrowserIcon } from "../../shared/design-system/icons/index";

type PageIconProps = {
  icon: typeof BrowserIcon;
  image?: string | undefined;
  size: number;
  strokeWidth?: ComponentProps<typeof BrowserIcon>["strokeWidth"];
};

const pixelsPerRem = 16;
const svgData = /^data:image\/svg\+xml((?:;[^,]*)?),/i;
const nonPaint = /<!--[\s\S]*?-->|<(title|desc|metadata)\b[\s\S]*?<\/\1\s*>/gi;
const currentColorPaint =
  /(?:^|[\s;"'{])(?:fill|stroke|stop-color|flood-color|lighting-color)\s*(?:=\s*["']?|:)\s*currentcolor\b/i;

function svgSource(image: string): string | undefined {
  const match = svgData.exec(image);
  if (!match) return undefined;
  const payload = image.slice(match[0].length);
  try {
    return /;base64$/i.test(match[1] ?? "")
      ? new TextDecoder().decode(
          Uint8Array.from(atob(payload), (char) => char.charCodeAt(0)),
        )
      : decodeURIComponent(payload);
  } catch {
    return undefined;
  }
}

/** An SVG that paints with `currentColor`, which an `<img>` can't resolve. */
export function paintsCurrentColor(image: string): boolean {
  const svg = svgSource(image);
  return svg !== undefined && currentColorPaint.test(svg.replace(nonPaint, ""));
}

const paintKinds = ["fill", "stroke"] as const;
const multiPaint =
  /^(image|foreignObject|linearGradient|radialGradient|pattern|style)$/;
const declared = (element: Element, property: string) =>
  (
    new RegExp(`(?:^|;)\\s*${property}\\s*:([^;]*)`, "i").exec(
      element.getAttribute("style") ?? "",
    )?.[1] ??
    element.getAttribute(property) ??
    ""
  )
    .trim()
    .toLowerCase();

const shape = /^(path|rect|circle|ellipse|polygon|polyline|text)$/;
const black = /^(black|#000|#000000)$/;

/** A shape with no fill of its own or from a parent is filled black. */
function inheritedFill(element: Element | null): string {
  for (; element; element = element.parentElement) {
    const fill = declared(element, "fill");
    if (fill) return fill;
  }
  return "black";
}

function oneColour(elements: readonly Element[]) {
  const paints = new Set<string>();
  const add = (paint: string) => {
    if (paint && paint !== "none" && paint !== "transparent")
      paints.add(black.test(paint) ? "black" : paint);
  };
  for (const element of elements) {
    if (multiPaint.test(element.localName)) return false;
    // Clip and mask shapes shape the glyph; they are never painted.
    if (element.closest("clipPath, mask")) continue;
    for (const kind of paintKinds) add(declared(element, kind));
    if (shape.test(element.localName)) add(inheritedFill(element));
  }
  return paints.size <= 1;
}

/**
 * The mask source for an SVG glyph: one that paints with `currentColor`, or,
 * when `strokeWidth` is given, one painted in a single colour. With
 * `strokeWidth`, its strokes take that width on a 24-unit grid, so a plugin's
 * glyph matches the host icons beside it. Other images draw as they are, so
 * this returns undefined.
 */
export function glyphMask(
  image: string,
  strokeWidth?: number | string,
): string | undefined {
  const source = svgSource(image);
  if (source === undefined) return undefined;
  const root = new DOMParser().parseFromString(
    source,
    "image/svg+xml",
  ).documentElement;
  if (root.localName !== "svg" || root.querySelector("parsererror"))
    return undefined;
  const elements = [root, ...root.querySelectorAll("*")];
  const tinted = paintsCurrentColor(image);
  if (strokeWidth === undefined) return tinted ? image : undefined;
  if (!tinted && !oneColour(elements)) return undefined;
  for (const element of elements) {
    element.removeAttribute("stroke-width");
    const style = element
      .getAttribute("style")
      ?.replace(/(^|;)\s*stroke-width\s*:[^;]*/gi, "$1");
    if (style !== undefined) element.setAttribute("style", style);
    if (element.localName === "style")
      element.textContent =
        element.textContent?.replace(/stroke-width\s*:[^;}]*;?/gi, "") ?? "";
  }
  // The square mask fits the artwork by its longer side.
  const [, , ...box] = (root.getAttribute("viewBox") ?? "")
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  const sized = ["width", "height"].map((side) =>
    Number(/^\s*([\d.]+)(?:px)?\s*$/.exec(root.getAttribute(side) ?? "")?.[1]),
  );
  const fits = (sides: number[]) =>
    Math.max(...sides.filter((side) => side > 0), 0);
  const grid = fits(box) || fits(sized) || 24;
  root.setAttribute("stroke-width", String((Number(strokeWidth) * grid) / 24));
  return `data:image/svg+xml,${encodeURIComponent(new XMLSerializer().serializeToString(root))}`;
}

const cssUrl = (image: string) =>
  `url("${image.replace(/["\\\n\r]/g, (char) => `%${char.charCodeAt(0).toString(16).padStart(2, "0")}`)}")`;

/**
 * Shows a page's declared image, or `icon` when there is none or the image
 * fails to load. A failed source stays on `icon`; a new source gets one attempt.
 * An SVG glyph (see `glyphMask`) is drawn as a mask in the text colour with
 * `strokeWidth`, so it follows the theme, the row's hover and selected states
 * and the weight of `icon`.
 */
export function PageIcon({
  icon: Icon,
  image,
  size,
  strokeWidth,
}: PageIconProps) {
  const [failedImage, setFailedImage] = useState<string>();
  const glyph = useMemo(
    () => (image === undefined ? undefined : glyphMask(image, strokeWidth)),
    [image, strokeWidth],
  );
  if (image !== undefined && image !== failedImage) {
    const length = `${size / pixelsPerRem}rem`;
    if (glyph !== undefined) {
      const mask = cssUrl(glyph);
      return (
        <span
          aria-hidden="true"
          className="inline-block shrink-0 bg-current"
          style={{
            width: length,
            height: length,
            maskImage: mask,
            WebkitMaskImage: mask,
            maskSize: "contain",
            WebkitMaskSize: "contain",
            maskRepeat: "no-repeat",
            WebkitMaskRepeat: "no-repeat",
            maskPosition: "center",
            WebkitMaskPosition: "center",
          }}
        >
          {/* A mask reports no load failure, so a hidden copy watches for one. */}
          <img
            src={image}
            alt=""
            hidden
            onError={() => setFailedImage(image)}
          />
        </span>
      );
    }
    return (
      <img
        src={image}
        alt=""
        aria-hidden="true"
        draggable={false}
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
