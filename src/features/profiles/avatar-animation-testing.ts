import { readFileSync } from "node:fs";
import { vi } from "vitest";

const animation = new Uint8Array(
  readFileSync("tests/fixtures/attachment-media/animated.webp"),
);

/** Exercise the real animation parser with a small, encoded WebP fixture. */
export function stubAvatarAnimationFetch() {
  const fetch = vi.fn<typeof globalThis.fetch>(
    async () =>
      new Response(animation.slice(), {
        headers: {
          "Content-Type": "image/webp",
          "Content-Length": String(animation.length),
        },
      }),
  );
  let serial = 0;
  const create = vi.fn<typeof URL.createObjectURL>(
    () => `blob:avatar-${++serial}`,
  );
  const revoke = vi.fn<typeof URL.revokeObjectURL>();
  const NativeURL = URL;
  vi.stubGlobal("fetch", fetch);
  vi.stubGlobal(
    "URL",
    class extends NativeURL {
      static createObjectURL = create;
      static revokeObjectURL = revoke;
    },
  );
  return { fetch, create, revoke };
}
