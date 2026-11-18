import "../styles/avatar-shape.css";
import "../styles/avatar-status.css";
import { Avatar as BaseAvatar } from "@base-ui/react/avatar";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useReadyImage } from "../useReadyImage";

/** The host may supply artwork for recognized sources; unknown images keep normal loading. */
export const AvatarArtworkContext = createContext<
  ((src: string) => ReactNode) | null
>(null);

type AvatarSize = "tiny" | "compact" | "small" | "default" | "large" | "fill";

function AvatarArtwork({
  src,
  fallback,
  loading,
  foreground = false,
}: {
  src: string;
  fallback: ReactNode;
  loading: "eager" | "lazy" | undefined;
  foreground?: boolean;
}) {
  const { status, failing, image } = useReadyImage(src, loading);
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (status !== "loading" || foreground) return;
    const timer = window.setTimeout(() => setLate(true), 150);
    return () => window.clearTimeout(timer);
  }, [status, foreground]);
  // data-avatar-fallback: see `.buzz-avatar:has(> [data-avatar-fallback])`.
  const initial = (
    <span aria-hidden="true" data-avatar-fallback="">
      {fallback}
    </span>
  );
  if (status === "failed") return foreground ? null : initial;
  return (
    <>
      <img
        {...image}
        data-avatar-foreground={foreground || undefined}
        data-loaded={status === "loaded" ? "true" : undefined}
        alt=""
        referrerPolicy="no-referrer"
      />
      {status === "loading" && !foreground && (failing || late) ? initial : null}
    </>
  );
}

export function Avatar({
  src,
  fallbackSrc,
  alt,
  fallback,
  fallbackContent,
  fallbackSurface = "subtle",
  size = "default",
  shape = "circle",
  statusBadge,
  loading,
}: {
  src?: string | null | undefined;
  /** Keep this still image mounted while alternate artwork loads or fails. */
  fallbackSrc?: string | undefined;
  alt: string;
  fallback: string;
  fallbackContent?: ReactNode;
  /** Panel-colored monogram for avatars displayed on an inset surface. */
  fallbackSurface?: "subtle" | "panel";
  size?: AvatarSize;
  shape?: "circle" | "squircle";
  statusBadge?: "online" | "away" | "offline" | undefined;
  /** Immediate visible editors may bypass lazy scheduling, never image readiness. */
  loading?: "eager" | "lazy";
}) {
  const renderArtwork = useContext(AvatarArtworkContext);
  const artwork = src ? renderArtwork?.(src) : undefined;
  const initial = Array.from(fallback.trim())[0]?.toUpperCase() || "?";
  const content = fallbackContent ?? initial;
  const hasStill = !!src && !!fallbackSrc && fallbackSrc !== src;
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
        data-fallback-surface={fallbackSurface}
        role={alt ? "img" : undefined}
        aria-label={
          alt ? `${alt}${statusBadge ? `, ${statusBadge}` : ""}` : undefined
        }
        aria-hidden={!alt || undefined}
      >
        {artwork ?? (
          <>
            {hasStill && (
              <AvatarArtwork
                key={fallbackSrc}
                src={fallbackSrc}
                fallback={content}
                loading={loading}
              />
            )}
            {src ? (
              <AvatarArtwork
                key={src}
                src={src}
                fallback={content}
                loading={loading}
                foreground={hasStill}
              />
            ) : (
              // data-avatar-fallback: see `.buzz-avatar:has(> [data-avatar-fallback])`.
              <span aria-hidden="true" data-avatar-fallback="">
                {content}
              </span>
            )}
          </>
        )}
      </BaseAvatar.Root>
      {statusBadge && (
        <span className="buzz-avatar-status-dot" aria-hidden="true" />
      )}
    </span>
  );
}
