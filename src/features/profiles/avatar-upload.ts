import { prepareAttachment } from "../messages/prepare-attachment";
import { mediaUrl } from "../relay/transport";
import { nativeIdentityEnabled } from "../identity/service";
import { nativeMediaUrl } from "../relay/native";
import { connectCommunityTransport } from "../communities/connection";
import { communityDestination } from "../communities/destination";
import { avatarSource } from "../../shared/avatar-source";

/** Shared save policy; display-only inherited artwork may still fail validation. */
export function avatarPictureError(value: string): string | undefined {
  if (
    !value ||
    (value.length <= 2048 && avatarSource(value)?.startsWith("https://"))
  )
    return undefined;
  return "Use an HTTPS image URL without credentials (up to 2,048 characters), or remove the avatar.";
}

export function avatarPreview(
  value: string,
  community?: string,
  size?: "small",
): string | undefined {
  const source = avatarSource(value);
  if (!source || !community || source.startsWith("data:")) return source;
  return communityMedia(community)(source, size);
}

/** Relay-hosted media of one community through the host's media adapter. */
export function communityMedia(community: string) {
  const { id, url } = communityDestination(community);
  const proxy = nativeIdentityEnabled()
    ? nativeMediaUrl
    : (target: string) =>
        `/api/relay/${encodeURIComponent(id)}/media?url=${encodeURIComponent(target)}`;
  return (source: string, size?: "small") => mediaUrl(source, proxy, url, size);
}

/** Use the existing host upload/preparation contract, never an agent key in React. */
export async function uploadAvatar(
  file: File,
  community: string,
  signal: AbortSignal,
): Promise<string> {
  if (!/^image\/(png|jpeg|gif|webp|heic|heif)$/.test(file.type))
    throw new Error("Choose a PNG, JPEG, GIF, WebP or HEIC image.");
  if (!file.size || file.size > 50 * 1024 * 1024)
    throw new Error("Choose an image smaller than 50 MiB.");
  const transport = await connectCommunityTransport(
    communityDestination(community).id,
    signal,
  );
  if (!transport.uploadAttachment)
    throw new Error("Image uploads are unavailable on this connection.");
  const prepared = await prepareAttachment(file, signal, true);
  const result = await transport.uploadAttachment(prepared, signal);
  signal.throwIfAborted();
  if (!result.type.startsWith("image/") || !avatarSource(result.url))
    throw new Error("The server did not return an avatar image.");
  return result.url;
}

/** The emoji's longer side as a share of the image: by default the square
 * inscribed in a circular avatar, so clipping never crops it. */
export const emojiAvatarScale = 0.7;

/** Fit painted pixels: emoji font metrics differ between browser engines. */
export function paintEmojiAvatar(
  canvas: HTMLCanvasElement,
  emoji: string,
  color?: string,
  scale = emojiAvatarScale,
) {
  canvas.width = canvas.height = 512;
  // Paint large and only ever shrink, so a zoomed emoji stays sharp.
  const glyph = document.createElement("canvas");
  glyph.width = glyph.height = 1024;
  const context = canvas.getContext("2d");
  const source = glyph.getContext("2d", { willReadFrequently: true });
  if (!context || !source)
    throw new Error("Emoji images are unavailable in this browser.");
  source.font =
    '516px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
  source.textAlign = "center";
  source.textBaseline = "middle";
  source.fillStyle = "#000000";
  source.fillText(emoji, 512, 512);
  const pixels = source.getImageData(0, 0, 1024, 1024);
  let left = 1024;
  let right = -1;
  let top = 1024;
  let bottom = -1;
  for (let y = 0; y < 1024; y++) {
    for (let x = 0; x < 1024; x++) {
      // Ignore the nearly transparent fringe/shadow around Apple emoji artwork.
      if ((pixels.data[(y * 1024 + x) * 4 + 3] ?? 0) < 32) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  }
  if (color) {
    context.fillStyle = color;
    context.fillRect(0, 0, 512, 512);
  }
  if (right < left) return;
  const width = right - left + 1;
  const height = bottom - top + 1;
  const fit = (512 * scale) / Math.max(width, height);
  context.imageSmoothingQuality = "high";
  context.drawImage(
    glyph,
    left,
    top,
    width,
    height,
    256 - (width * fit) / 2,
    256 - (height * fit) / 2,
    width * fit,
    height * fit,
  );
}

/** Persist ordinary square artwork; Avatar owns human/agent clipping. */
export async function emojiAvatar(
  emoji: string,
  color: string,
  scale = emojiAvatarScale,
): Promise<File> {
  if (!emoji || emoji.length > 64 || !/^#[0-9a-f]{6}$/i.test(color))
    throw new Error("Choose an emoji and a background color.");
  const canvas = document.createElement("canvas");
  paintEmojiAvatar(canvas, emoji, color, scale);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (value) =>
        value
          ? resolve(value)
          : reject(new Error("Could not prepare the emoji image.")),
      "image/png",
    ),
  );
  return new File([blob], "avatar.png", { type: "image/png" });
}
