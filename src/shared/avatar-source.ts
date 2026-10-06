const MAX_INLINE_AVATAR_SVG_LENGTH = 2048;
const EMOJI_AVATAR_SVG =
  /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" rx="(112|256)" fill="(#[0-9a-fA-F]{6})"\/><text x="50%" y="56%" dominant-baseline="middle" text-anchor="middle" font-size="258">((?:[^<>&]|&(?:amp|lt|gt);){1,128})<\/text><\/svg>$/;

/** Display-only avatars. No file URLs, executable schemes or credentials. */
export function avatarSource(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const source = value.trim();
  if (source.startsWith("data:image/svg+xml,")) {
    if (source.length > MAX_INLINE_AVATAR_SVG_LENGTH) return undefined;
    try {
      // Rebuild Buzz emoji avatars from their fixed template rather than trusting
      // arbitrary SVG from profile metadata (scripts, foreignObject, remote loads).
      const svg = decodeURIComponent(
        source.slice("data:image/svg+xml,".length),
      );
      const match = EMOJI_AVATAR_SVG.exec(svg);
      if (!match) return undefined;
      const [, radius, color, text] = match;
      const safeSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" rx="${radius}" fill="${color}"/><text x="50%" y="56%" dominant-baseline="middle" text-anchor="middle" font-size="258">${text}</text></svg>`;
      return `data:image/svg+xml,${encodeURIComponent(safeSvg)}`;
    } catch {
      return undefined;
    }
  }
  if (
    /^data:image\/(?:png|jpeg|webp|gif);base64,[a-zA-Z0-9+/]+=*$/.test(source)
  )
    return source.length <= 512 * 1024 ? source : undefined;
  if (source.length > 2048) return undefined;
  try {
    const url = new URL(source);
    if (url.protocol === "https:" && !url.username && !url.password)
      return url.href;
  } catch {
    /* Missing/invalid optional artwork falls back to initials. */
  }
  return undefined;
}

/** Displayable small avatar: inline data as-is, remote art through the
 * session's authenticated media path (never the raw URL). */
export function avatarMedia(
  value: unknown,
  media: ((url: string, size: "small") => string | undefined) | undefined,
) {
  const source = avatarSource(value);
  return source?.startsWith("data:")
    ? source
    : source && media?.(source, "small");
}
