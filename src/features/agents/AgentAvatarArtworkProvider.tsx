import type { ComponentProps, ReactNode } from "react";
import {
  AvatarArtwork,
  AvatarArtworkContext,
} from "../../shared/design-system/ui/Avatar";
import {
  ProfileAvatarArtwork,
  profileAvatarSources,
} from "../profiles/ProfileAvatarArtwork";
import { agentAvatars } from "./avatar-packs";

const packsBySource = new Map(
  agentAvatars.flatMap((avatar) => [
    [avatar.url, avatar] as const,
    [avatar.preview, avatar] as const,
  ]),
);
function renderArtwork(
  src: string,
  {
    autoPlay,
    ...options
  }: { autoPlay: boolean } & Omit<
    ComponentProps<typeof ProfileAvatarArtwork>,
    "poster" | "animation"
  >,
) {
  const animated = profileAvatarSources(src);
  if (animated)
    return autoPlay ? (
      <ProfileAvatarArtwork key={src} {...animated} {...options} />
    ) : (
      <AvatarArtwork
        transparent
        key={animated.poster}
        src={animated.poster}
        {...options}
      />
    );
  const avatar = packsBySource.get(src);
  return avatar ? (
    <img
      data-loaded="true"
      src={avatar.preview}
      alt=""
      style={{ width: "100%", height: "100%", objectFit: "contain" }}
    />
  ) : null;
}

/** Human recordings play in expanded profiles; bundled agent artwork keeps its static portrait. */
export function AgentAvatarArtworkProvider({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <AvatarArtworkContext value={renderArtwork}>
      {children}
    </AvatarArtworkContext>
  );
}
