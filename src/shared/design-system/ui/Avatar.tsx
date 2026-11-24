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
  | ((
      src: string,
      options: {
        autoPlay: boolean;
        fallback: ReactNode;
        loading: "eager" | "lazy" | undefined;
      },
    ) => ReactNode)
  | null
>(null);

type AvatarSize = "tiny" | "compact" | "small" | "default" | "large" | "fill";

export function AvatarArtwork({
  transparent = false,
  src,
  fallback,
  loading,
}: {
  src: string;
  transparent?: boolean;
  fallback: ReactNode;
  loading: "eager" | "lazy" | undefined;
}) {
  const { status, failing, image } = useReadyImage(src, loading);
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (status !== "loading") return;
    const timer = window.setTimeout(() => setLate(true), 150);
    return () => window.clearTimeout(timer);
  }, [status]);
  // data-avatar-fallback: see `.buzz-avatar:has(> [data-avatar-fallback])`.
  const initial = (
    <span aria-hidden="true" data-avatar-fallback="">
      {fallback}
    </span>
  );
  if (status === "failed") return initial;
  return (
    <>
      <img
        {...image}
        data-transparent={transparent || undefined}
        data-loaded={status === "loaded" ? "true" : undefined}
        alt=""
        referrerPolicy="no-referrer"
      />
      {status === "loading" && (failing || late) ? initial : null}
    </>
  );
}

export function Avatar({
  src,
  alt,
  fallback,
  fallbackContent,
  fallbackSurface = "subtle",
  size = "default",
  shape = "circle",
  statusBadge,
  autoPlay = false,
  loading,
}: {
  src?: string | null | undefined;
  alt: string;
  fallback: string;
  fallbackContent?: ReactNode;
  /** Panel-colored monogram for avatars displayed on an inset surface. */
  fallbackSurface?: "subtle" | "panel";
  size?: AvatarSize;
  shape?: "circle" | "squircle";
  statusBadge?: "online" | "away" | "offline" | undefined;
  autoPlay?: boolean;
  /** Immediate visible editors may bypass lazy scheduling, never image readiness. */
  loading?: "eager" | "lazy";
}) {
  const renderArtwork = useContext(AvatarArtworkContext);
  const initial = Array.from(fallback.trim())[0]?.toUpperCase() || "?";
  const content = fallbackContent ?? initial;
  const artwork = src
    ? renderArtwork?.(src, { autoPlay, fallback: content, loading })
    : undefined;
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
        {artwork ??
          (src ? (
            <AvatarArtwork
              key={src}
              src={src}
              fallback={content}
              loading={loading}
            />
          ) : (
            // data-avatar-fallback: see `.buzz-avatar:has(> [data-avatar-fallback])`.
            <span aria-hidden="true" data-avatar-fallback="">
              {content}
            </span>
          ))}
      </BaseAvatar.Root>
      {statusBadge && (
        <span className="buzz-avatar-status-dot" aria-hidden="true" />
      )}
    </span>
  );
}
