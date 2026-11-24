import { animatedAvatarSource, avatarMedia } from "../../shared/avatar-source";
import { useEffect, useState } from "react";
import { communityDestination } from "../communities/destination";
import { registerBrokerCommunity } from "../relay/transport";
import { avatarPreview, communityMedia } from "./avatar-upload";

/** A protected image must not mount before its destination is registered. */
export function useAvatarPreview(
  value: string,
  community?: string,
  size?: "small",
  /** An already-bound session's thumbnail resolver needs no second registration. */
  thumbnailMedia?: (url: string, size?: "small") => string | undefined,
  animate = false,
) {
  const source = thumbnailMedia
    ? avatarMedia(value, (url, requestedSize) =>
        requestedSize || animate
          ? thumbnailMedia(url, requestedSize)
          : undefined,
      )
    : animate && animatedAvatarSource(value)
      ? avatarMedia(value, community ? communityMedia(community) : (url) => url)
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
