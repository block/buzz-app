export { animatedAvatarSource as animatedAvatar } from "../../shared/avatar-source";

export function animatedAvatarUrl(poster: string, animation: string) {
  return `${poster}#buzz-anim=${encodeURIComponent(animation)}`;
}
