import { expect, it } from "vitest";
import { animatedAvatar, animatedAvatarUrl } from "./animated-avatar";
it("round trips the mobile descriptor, rejecting unsafe animation sources", () => {
  expect(
    animatedAvatar(
      animatedAvatarUrl(
        "https://relay.example/still.png",
        "https://relay.example/animation.png",
      ),
    ),
  ).toEqual({
    poster: "https://relay.example/still.png",
    animation: "https://relay.example/animation.png",
  });
  for (const url of [
    "javascript:alert(1)",
    "https://user:password@relay.example/a",
    "data:image/png;base64,AAAA",
    "%bad",
  ])
    expect(
      animatedAvatar(
        `https://relay.example/still.png#buzz-anim=${encodeURIComponent(url)}`,
      ),
    ).toBeUndefined();
});
