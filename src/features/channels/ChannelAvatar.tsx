import type { ComponentProps } from "react";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { channelAvatarSurface } from "./channel-icon";

/** Channel artwork shares its monogram and color across lists and previews. */
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
    .slice(0, 2)
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
