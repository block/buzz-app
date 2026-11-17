import "../styles/avatar-shape.css";
import "../styles/avatar-status.css";
import { Avatar as BaseAvatar } from "@base-ui/react/avatar";
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

/** The host may supply artwork for recognized sources; unknown images keep normal loading. */
export const AvatarArtworkContext = createContext<
  ((src: string) => ReactNode) | null
>(null);

/** The host may hold recognized sources' bytes locally. `held` returns the URL
 * to show now: the source itself when unrecognized, a local URL once held, or
 * undefined until `load` resolves one. `load` rejects when it is unavailable. */
export const AvatarSourceContext = createContext<{
  held(src: string): string | undefined;
  load(src: string): Promise<string>;
  /** Drop held bytes that failed to decode, so a retry fetches again. */
  forget(src: string): void;
} | null>(null);

type AvatarSize = "tiny" | "compact" | "small" | "default" | "large" | "fill";
type ImageStatus = "loading" | "loaded" | "failed";

// WebKit re-requests cached custom-scheme images on lazy remounts. Remember a
// bounded set of successful sources so only their subsequent mounts are eager.
// This is a loading hint; the real image still decides whether artwork is ready.
const loadedAvatarSources = new Set<string>();
function rememberAvatar(src: string) {
  loadedAvatarSources.delete(src);
  loadedAvatarSources.add(src);
  if (loadedAvatarSources.size > 128) {
    const oldest = loadedAvatarSources.values().next().value;
    if (oldest !== undefined) loadedAvatarSources.delete(oldest);
  }
  for (const retry of failedAvatars.get(src) ?? []) retry();
}
// A failed request may be transient (relay, network or native proxy), and a
// mounted avatar gets no new source to reset it. Behind the fallback, retry the
// same source a bounded number of times, and whenever another mount loads it.
const RETRY_DELAYS_MS = [2_000, 10_000, 30_000];
const failedAvatars = new Map<string, Set<() => void>>();

function AvatarArtwork({
  src,
  fallback,
  loading,
  fallbackShown,
}: {
  src: string;
  fallback: ReactNode;
  loading: "eager" | "lazy" | undefined;
  fallbackShown: RefObject<boolean>;
}) {
  const [status, setStatus] = useState<ImageStatus>("loading");
  // The delay keeps artwork that is ready at once from flashing the initial.
  // An initial already on screen has nothing to protect, so it stays until
  // this image is ready rather than blanking for the delay.
  const [showFallback, setShowFallback] = useState(() => fallbackShown.current);
  const [attempt, setAttempt] = useState(0);
  const [previouslyLoaded] = useState(() => loadedAvatarSources.has(src));
  const sources = useContext(AvatarSourceContext);
  const [shown, setShown] = useState(() => (sources ? sources.held(src) : src));
  const image = useRef<HTMLImageElement>(null);
  useEffect(() => {
    if (shown !== undefined || status !== "loading" || !sources) return;
    let live = true;
    sources.load(src).then(
      (url) => live && setShown(url),
      () => live && setStatus("failed"),
    );
    return () => {
      live = false;
    };
  }, [sources, src, shown, status]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a host-fetched source mounts its element once it resolves.
  useLayoutEffect(() => {
    // Cached artwork is already ready at mount; reveal it before the first paint
    // instead of waiting for another asynchronous load event after navigation.
    if (image.current?.complete) {
      if (image.current.naturalWidth > 0) {
        rememberAvatar(src);
        setStatus("loaded");
      } else {
        loadedAvatarSources.delete(src);
        if (shown !== src) sources?.forget(src);
        setStatus("failed");
      }
    }
  }, [src, shown]);
  useLayoutEffect(() => {
    fallbackShown.current =
      status === "failed" || (status === "loading" && showFallback);
  }, [fallbackShown, status, showFallback]);
  useEffect(() => {
    if (status !== "loading") return;
    const timer = window.setTimeout(() => setShowFallback(true), 150);
    return () => window.clearTimeout(timer);
  }, [status]);
  useEffect(() => {
    if (status !== "failed") return;
    const retry = () => {
      setShowFallback(true);
      setAttempt(attempt + 1);
      // A held URL may have been released since; ask again.
      setShown(sources ? sources.held(src) : src);
      setStatus("loading");
    };
    const waiting = failedAvatars.get(src) ?? new Set();
    failedAvatars.set(src, waiting.add(retry));
    const delay = RETRY_DELAYS_MS[attempt];
    const timer = delay === undefined ? 0 : window.setTimeout(retry, delay);
    return () => {
      window.clearTimeout(timer);
      waiting.delete(retry);
      if (!waiting.size) failedAvatars.delete(src);
    };
  }, [sources, src, status, attempt]);
  // data-avatar-fallback: see `.buzz-avatar:has(> [data-avatar-fallback])`.
  if (status === "failed")
    return (
      <span aria-hidden="true" data-avatar-fallback="">
        {fallback}
      </span>
    );
  return (
    <>
      {shown !== undefined && (
        <img
          ref={image}
          src={shown}
          data-loaded={status === "loaded" ? "true" : undefined}
          alt=""
          // Local bytes need no lazy scheduling.
          loading={
            loading ?? (previouslyLoaded || shown !== src ? "eager" : "lazy")
          }
          decoding="async"
          referrerPolicy="no-referrer"
          onLoad={() => {
            rememberAvatar(src);
            setStatus("loaded");
          }}
          onError={() => {
            loadedAvatarSources.delete(src);
            if (shown !== src) sources?.forget(src);
            setStatus("failed");
          }}
        />
      )}
      {status === "loading" && showFallback ? (
        <span aria-hidden="true" data-avatar-fallback="">
          {fallback}
        </span>
      ) : null}
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
  /** Immediate visible editors, and rows whose virtualized list already bounds
   * what mounts, may bypass lazy scheduling, never image readiness. */
  loading?: "eager" | "lazy" | undefined;
}) {
  const renderArtwork = useContext(AvatarArtworkContext);
  const artwork = src ? renderArtwork?.(src) : undefined;
  const initial = Array.from(fallback.trim())[0]?.toUpperCase() || "?";
  const content = fallbackContent ?? initial;
  // Whether the fallback was on screen at the last commit; mounted
  // AvatarArtwork reports its own.
  const fallbackShown = useRef(false);
  useLayoutEffect(() => {
    if (!src) fallbackShown.current = true;
    else if (artwork) fallbackShown.current = false;
  });
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
              fallbackShown={fallbackShown}
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
