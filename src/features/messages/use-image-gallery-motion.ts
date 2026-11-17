import { useCallback, useLayoutEffect, useState, type RefObject } from "react";

/** Shared directional navigation recipe for sent images and draft media. */
export const galleryMotion = {
  distance: 40,
  duration: 0.2,
  ease: [0.19, 1, 0.22, 1] as const,
};

type DepartingImage = {
  url: string;
  source: string;
  transform: string;
  direction: number;
  /** Its original was showing; otherwise its preview leaves in its place. */
  decoded: boolean;
};

/** Keep the outgoing DOM image alive while its replacement slides into view.
 * The slide starts at once; previews move with their images. */
export function useImageGalleryMotion(
  stage: RefObject<HTMLDivElement | null>,
  image: RefObject<HTMLImageElement | null>,
  url: string | undefined,
  source: string | undefined,
) {
  const [departing, setDeparting] = useState<DepartingImage>();
  const prepare = useCallback(
    (direction: number, decoded: boolean) => {
      if (
        !url ||
        !source ||
        window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
      ) {
        setDeparting(undefined);
        return;
      }
      setDeparting({
        url,
        source,
        decoded,
        direction,
        transform: image.current
          ? getComputedStyle(image.current).transform
          : "none",
      });
    },
    [url, source, image],
  );
  useLayoutEffect(() => {
    if (!departing) return;
    const container = stage.current;
    const incoming = image.current;
    const outgoing = Array.from(
      container?.querySelectorAll<HTMLElement>("[data-gallery-departing]") ??
        [],
    );
    const reducedMotion = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    );
    if (
      departing.url === url ||
      !container ||
      !incoming?.animate ||
      !outgoing.length ||
      reducedMotion?.matches
    ) {
      setDeparting(undefined);
      return;
    }
    const arriving = container.querySelectorAll<HTMLElement>(
      "[data-gallery-preview]:not([data-gallery-departing])",
    );
    const animations: Animation[] = [];
    const clear = () => {
      for (const animation of animations) {
        animation.onfinish = null;
        animation.cancel();
      }
    };
    const finish = () => {
      for (const element of outgoing) element.style.visibility = "hidden";
      clear();
      // The slide held the opacity of a preview whose original decoded
      // meanwhile, so its own fade never started.
      for (const element of arriving) {
        if (!element.hasAttribute("data-gallery-ready")) continue;
        const style = getComputedStyle(element);
        element.animate([{ opacity: 1 }, { opacity: 0 }], {
          duration: Number.parseFloat(style.transitionDuration) * 1000 || 0,
          easing: style.transitionTimingFunction,
        });
      }
      setDeparting((current) => (current === departing ? undefined : current));
    };
    const distance = departing.direction * galleryMotion.distance;
    const timing = {
      duration: galleryMotion.duration * 1000,
      easing: `cubic-bezier(${galleryMotion.ease.join(",")})`,
    };
    for (const element of outgoing)
      animations.push(
        element.animate(
          [
            { translate: "0px 0px", opacity: 1 },
            { translate: `${-distance}px 0px`, opacity: 0 },
          ],
          { ...timing, fill: "forwards" },
        ),
      );
    const [arrival, ...previews] = [incoming, ...arriving].map((element) =>
      element.animate(
        [
          { translate: `${distance}px 0px`, opacity: 0 },
          { translate: "0px 0px", opacity: 1 },
        ],
        timing,
      ),
    );
    if (arrival) {
      animations.push(arrival, ...previews);
      arrival.onfinish = finish;
    }
    window.addEventListener("resize", finish, { once: true });
    reducedMotion?.addEventListener("change", finish);
    return () => {
      clear();
      window.removeEventListener("resize", finish);
      reducedMotion?.removeEventListener("change", finish);
    };
  }, [stage, image, url, departing]);
  return { departing, prepare };
}
