/** Display-only avatars. No file URLs, SVG data, executable schemes or credentials. */
export function avatarSource(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const source = value.trim();
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
