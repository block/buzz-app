import type { ComponentProps } from "react";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { channelAvatarSurface } from "./channel-icon";

/** A channel's monogram: its first three letters on its identity fill. */
export function ChannelAvatar({
  name,
  size = "default",
  shape = "circle",
}: {
  name: string;
  size?: ComponentProps<typeof Avatar>["size"];
  shape?: ComponentProps<typeof Avatar>["shape"];
}) {
  const letters = Array.from(name.trim().replace(/^#+/, "").trim())
    .slice(0, 3)
    .join("")
    .toUpperCase();
  return (
    <Avatar
      alt=""
      fallback={name}
      fallbackContent={letters || "?"}
      fallbackSurface={channelAvatarSurface(name)}
      size={size}
      shape={shape}
    />
  );
}
