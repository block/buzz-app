import { animatedAvatar, avatarMedia } from "../../shared/avatar-source";
import {
  onImageRecovery,
  RETRY_DELAYS_MS,
  rememberLoadedImage,
} from "../../shared/design-system/useReadyImage";
import { usePrefersReducedMotion } from "../agents/PackedAgentAvatar";
import { useEffect, useState } from "react";
import { communityDestination } from "../communities/destination";
import { registerBrokerCommunity } from "../relay/transport";
import { avatarPreview } from "./avatar-upload";

/** A protected image must not mount before its destination is registered. */
export function useAvatarPreview(
  value: string,
  community?: string,
  size?: "small",
  /** An already-bound session's thumbnail resolver needs no second registration. */
  thumbnailMedia?: (url: string, size: "small") => string | undefined,
) {
  const source = thumbnailMedia
    ? avatarMedia(value, thumbnailMedia)
    : avatarPreview(value, community, size);
  const destination =
    !thumbnailMedia && source?.startsWith("/api/relay/") && community
      ? communityDestination(community).id
      : undefined;
  const [registered, setRegistered] = useState<string>();
  useEffect(() => {
    if (!destination) return;
    const request = new AbortController();
    setRegistered(undefined);
    void registerBrokerCommunity(destination, request.signal).then(
      () => {
        if (!request.signal.aborted) setRegistered(destination);
      },
      () => {
        // Keep the existing initials fallback; never expose an unregistered URL.
      },
    );
    return () => request.abort();
  }, [destination]);
  return !destination || registered === destination ? source : undefined;
}

// Animation loads still waiting, by source, so one mount's success wakes the
// rest.
const waiting = new Map<string, Set<() => void>>();

/** An animated avatar's full-size animation once it has decoded. The poster
 * shows until then, and whenever motion is reduced. A failed load retries on
 * the same schedule as a mounted image, and when a connection recovers. */
export function useAvatarAnimation(
  picture: string | undefined,
  community?: string,
): string | undefined {
  const still = usePrefersReducedMotion();
  // Reduced motion never fetches the animation.
  const parts = still ? undefined : animatedAvatar(picture);
  // Full size: the relay's thumbnail is only the first frame.
  const source = useAvatarPreview(parts?.animation ?? "", community);
  const [loaded, setLoaded] = useState<string>();
  useEffect(() => {
    if (!source) return;
    let live = true;
    let failures = 0;
    let timer = 0;
    // One request at a time; a recovery during it earns an immediate retry
    // if it fails, as a mounted image's does.
    let pending = false;
    let recovered = false;
    const peers = waiting.get(source) ?? new Set<() => void>();
    waiting.set(source, peers);
    const load = () => {
      if (!live) return;
      if (pending) {
        recovered = true;
        return;
      }
      window.clearTimeout(timer);
      pending = true;
      recovered = false;
      const image = new Image();
      image.src = source;
      const decoded =
        typeof image.decode === "function"
          ? image.decode()
          : new Promise((done, fail) => {
              image.onload = done;
              image.onerror = fail;
            });
      decoded.then(
        () => {
          pending = false;
          if (!live) return;
          stop();
          rememberLoadedImage(source);
          setLoaded(source);
          // Other mounts still waiting on it can play it now.
          for (const peer of [...peers]) peer();
        },
        () => {
          // The poster stays meanwhile.
          pending = false;
          if (!live) return;
          const delay = recovered ? 0 : RETRY_DELAYS_MS[failures++];
          if (delay !== undefined) timer = window.setTimeout(load, delay);
        },
      );
    };
    const unsubscribe = onImageRecovery(load);
    peers.add(load);
    const stop = () => {
      unsubscribe();
      peers.delete(load);
      if (!peers.size && waiting.get(source) === peers) waiting.delete(source);
    };
    load();
    return () => {
      live = false;
      window.clearTimeout(timer);
      stop();
    };
  }, [source]);
  return loaded === source ? source : undefined;
}
