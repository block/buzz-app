import { useEffect, useState } from "react";
import { avatarMedia, avatarSource } from "../../shared/avatar-source";

type Media = (url: string, size?: "small") => string | undefined;

// Earlier desktop versions stored a poster plus an encoded APNG or loop URL.
function responseMedia(source: string | undefined, media: Media | undefined) {
  if (!source || !media || !source.startsWith("https://")) return;
  const [poster, fragment] = source.split("#");
  if (
    !poster ||
    !/^https:\/\/[^/?#]+\/media\/[a-f\d]{64}\.(?:webp|gif|png|jpe?g)$/i.test(
      poster,
    )
  )
    return;
  let animation = poster;
  if (fragment !== undefined) {
    if (!fragment.startsWith("buzz-anim=")) return;
    try {
      animation = decodeURIComponent(fragment.slice("buzz-anim=".length));
    } catch {
      return;
    }
    const origin = new URL(poster).origin;
    if (
      !animation.startsWith(origin) ||
      !/^\/media\/[a-f\d]{64}\.(?:webp|gif|png|apng)$/i.test(
        animation.slice(origin.length),
      )
    )
      return;
  } else if (!/\.(?:webp|gif|png)$/i.test(animation)) {
    return;
  }
  // The relay resolver returns an external HTTPS URL unchanged. Only load
  // originals served through this community's media resolver.
  const resolved = media(animation);
  return resolved !== animation ? resolved : undefined;
}

/** Play the uploaded loop in an active response or expanded profile. Other
 * views use the cached thumbnail.
 * The resolver binds both URLs to this community's normal media access. */
export function useChatAvatar(
  value: unknown,
  media: Media | undefined,
  responding: boolean,
) {
  const still = avatarMedia(value, media);
  const source = responding ? avatarSource(value) : undefined;
  const original = responseMedia(source, media);
  const [loaded, setLoaded] = useState<string>();

  useEffect(() => {
    if (!original || !still || original === still || !window.matchMedia) return;
    const motion = window.matchMedia("(prefers-reduced-motion: no-preference)");
    let image: HTMLImageElement | undefined;
    function update() {
      if (image) image.onload = null;
      image = undefined;
      setLoaded(undefined);
      if (!motion.matches || !original) return;
      image = new Image();
      image.onload = () => setLoaded(original);
      image.src = original;
    }
    update();
    motion.addEventListener("change", update);
    return () => {
      motion.removeEventListener("change", update);
      if (image) image.onload = null;
    };
  }, [original, still]);

  return original && loaded === original ? original : still;
}
