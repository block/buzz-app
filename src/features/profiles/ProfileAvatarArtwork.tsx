import { useEffect, useState, type ReactNode } from "react";
import { AvatarArtwork } from "../../shared/design-system/ui/Avatar";
import { avatarAnimationParts } from "../../shared/avatar-source";

/** Accept authorized host URLs as well as public HTTPS artwork, never file or executable URLs. */
export function profileAvatarSources(src: string) {
  const parts = avatarAnimationParts(src, "#buzz-avatar-display=");
  const classify = (value: string) => {
    if (
      Array.from(value).some(
        (character) => character.charCodeAt(0) <= 32 || character === "\\",
      )
    )
      return;
    try {
      if (value.startsWith("/") && !value.startsWith("//"))
        return { protectedOrigin: "broker" };
      if (
        !/^(?:https:\/\/|http:\/\/buzz-media\.localhost\/|buzz-media:\/\/localhost\/|blob:)/.test(
          value,
        )
      )
        return;
      const url = new URL(value);
      if (url.username || url.password) return;
      if (url.protocol === "buzz-media:" && url.host === "localhost")
        return { protectedOrigin: "buzz-media://localhost" };
      if (url.protocol === "http:" && url.host === "buzz-media.localhost")
        return { protectedOrigin: "http://buzz-media.localhost" };
      if (url.protocol === "https:" || url.protocol === "blob:")
        return { protectedOrigin: undefined };
    } catch {
      /* Invalid optional artwork stays static. */
    }
  };
  if (!parts) return;
  const poster = classify(parts.poster);
  const animation = classify(parts.animation);
  if (!poster || !animation) return;
  // Public artwork cannot turn a fragment into a same-origin/native read.
  if (
    animation.protectedOrigin &&
    animation.protectedOrigin !== poster.protectedOrigin
  )
    return;

  return parts;
}

export function ProfileAvatarArtwork({
  poster,
  animation,
  fallback,
  loading,
}: {
  poster: string;
  animation: string;
  fallback: ReactNode;
  loading: "eager" | "lazy" | undefined;
}) {
  const [allowed, setAllowed] = useState(false);
  const [loaded, setLoaded] = useState<string>();
  useEffect(() => {
    const query = matchMedia("(prefers-reduced-motion: no-preference)");
    const update = () => setAllowed(query.matches && !document.hidden);
    update();
    query.addEventListener("change", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      query.removeEventListener("change", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  const active = allowed;
  useEffect(() => {
    if (!active) return;
    const image = new Image();
    image.referrerPolicy = "no-referrer";
    image.onload = () => setLoaded(animation);
    image.src = animation;
    return () => {
      image.onload = null;
      image.src = "";
    };
  }, [active, animation]);
  const src = active && loaded === animation ? animation : poster;
  return (
    <AvatarArtwork
      transparent
      key={src}
      src={src}
      fallback={fallback}
      loading={loading}
    />
  );
}
