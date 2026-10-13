import "../styles/avatar-shape.css";
import "../styles/avatar-status.css";
import { Avatar as BaseAvatar } from "@base-ui/react/avatar";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

type AvatarSize = "compact" | "small" | "default" | "large" | "fill";
type ImageStatus = "loading" | "loaded" | "failed";

function AvatarArtwork({
  src,
  fallback,
  loading,
}: {
  src: string;
  fallback: ReactNode;
  loading: "eager" | "lazy";
}) {
  const image = useRef<HTMLImageElement>(null);
  const [status, setStatus] = useState<ImageStatus>("loading");
  useLayoutEffect(() => {
    // A cached image can be ready before this instance receives its load event.
    if (image.current?.complete && image.current.naturalWidth > 0)
      setStatus("loaded");
  }, []);
  if (status === "failed") return <span aria-hidden="true">{fallback}</span>;
  return (
    <>
      <img
        ref={image}
        src={src}
        data-loaded={status === "loaded" ? "true" : undefined}
        alt=""
        loading={loading}
        decoding="async"
        referrerPolicy="no-referrer"
        onLoad={() => setStatus("loaded")}
        onError={() => setStatus("failed")}
      />
      {status === "loading" ? <span aria-hidden="true">{fallback}</span> : null}
    </>
  );
}

export function Avatar({
  src,
  alt,
  fallback,
  fallbackContent,
  size = "default",
  shape = "circle",
  statusBadge,
  loading = "lazy",
}: {
  src?: string | null | undefined;
  alt: string;
  fallback: string;
  fallbackContent?: ReactNode;
  size?: AvatarSize;
  shape?: "circle" | "squircle";
  statusBadge?: "online" | "away" | "offline" | undefined;
  loading?: "eager" | "lazy";
}) {
  const initial = Array.from(fallback.trim())[0]?.toUpperCase() || "?";
  const content = fallbackContent ?? initial;
  return (
    <span
      className="buzz-avatar-status"
      data-size={size}
      data-shape={shape}
      data-status={statusBadge}
    >
      <BaseAvatar.Root
        data-buzz-ui=""
        className="buzz-avatar"
        data-size={size}
        data-avatar-shape={shape}
        role={alt ? "img" : undefined}
        aria-label={
          alt ? `${alt}${statusBadge ? `, ${statusBadge}` : ""}` : undefined
        }
        aria-hidden={!alt || undefined}
      >
        {src ? (
          <AvatarArtwork
            key={src}
            src={src}
            fallback={content}
            loading={loading}
          />
        ) : (
          <span aria-hidden="true">{content}</span>
        )}
      </BaseAvatar.Root>
      {statusBadge && (
        <span className="buzz-avatar-status-dot" aria-hidden="true" />
      )}
    </span>
  );
}
