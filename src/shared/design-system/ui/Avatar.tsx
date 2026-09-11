import { Avatar as BaseAvatar } from "@base-ui/react/avatar";
import { useState } from "react";

type AvatarSize = "small" | "default" | "large";

export function Avatar({
  src,
  alt,
  fallback,
  size = "default",
}: {
  src?: string | null;
  alt: string;
  fallback: string;
  size?: AvatarSize;
}) {
  const [loaded, setLoaded] = useState(false);
  return (
    <BaseAvatar.Root
      data-buzz-ui=""
      className="buzz-avatar"
      data-size={size}
      role="img"
      aria-label={alt}
    >
      {src ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onLoad={() => setLoaded(true)}
        />
      ) : null}
      <BaseAvatar.Fallback delay={src && !loaded ? 150 : 0} aria-hidden="true">
        {fallback.slice(0, 1).toUpperCase()}
      </BaseAvatar.Fallback>
    </BaseAvatar.Root>
  );
}
