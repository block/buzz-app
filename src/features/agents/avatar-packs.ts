import catalog from "./avatar-packs/catalog.json";

const posters = import.meta.glob<string>("./avatar-packs/*.png", {
  eager: true,
  query: "?url",
  import: "default",
});

export const avatarPacks = catalog.collections;
export const agentAvatars = catalog.assets.map((asset) => ({
  ...asset,
  preview: posters[`./avatar-packs/${asset.id}.png`],
}));

const animations = import.meta.glob<string>(
  ["./avatar-packs/*.webm", "./avatar-packs/*.mp4"],
  {
    eager: true,
    query: "?url",
    import: "default",
  },
);
export function avatarAnimation(id: string) {
  return {
    webm: animations[`./avatar-packs/${id}.webm`],
    hevc: animations[`./avatar-packs/${id}.mp4`],
  };
}

export function randomAgentAvatar() {
  const avatar = agentAvatars[Math.floor(Math.random() * agentAvatars.length)];
  if (!avatar) throw new Error("Bundled avatar catalog is empty");
  return avatar;
}

/** Retired pack choices in an open create draft should not become broken images. */
export function isRetiredAgentAvatar(picture: string): boolean {
  if (agentAvatars.some((avatar) => avatar.url === picture)) return false;
  try {
    const url = new URL(picture);
    const bundled = new URL(agentAvatars[0]?.url ?? "");
    return (
      url.origin === bundled.origin &&
      /^\/avatars\/[^/]+\/poster\/(pollies|fuzzies|gloopies)\//.test(
        url.pathname,
      )
    );
  } catch {
    return false;
  }
}
