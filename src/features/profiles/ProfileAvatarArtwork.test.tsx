// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { avatarMedia } from "../../shared/avatar-source";
import { AgentAvatarArtworkProvider } from "../agents/AgentAvatarArtworkProvider";
import { profileAvatarSources } from "./ProfileAvatarArtwork";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const picture =
  "https://relay.example/poster.png#buzz-anim=https%3A%2F%2Frelay.example%2Fanimation.png";
function setup(allowed = true, autoPlay = true) {
  vi.stubGlobal("matchMedia", () => ({
    matches: allowed,
    addEventListener() {},
    removeEventListener() {},
  }));
  const requests: {
    src: string;
    onload: (() => void) | null;
    referrerPolicy: string;
  }[] = [];
  vi.stubGlobal(
    "Image",
    class {
      src = "";
      onload = null;
      referrerPolicy = "";
      constructor() {
        requests.push(this);
      }
    },
  );
  const source = avatarMedia(
    picture,
    (url, size) =>
      `/protected/${size ?? "full"}?url=${encodeURIComponent(url)}`,
  );
  const view = render(
    <AgentAvatarArtworkProvider>
      <Avatar autoPlay={autoPlay} src={source} alt="Person" fallback="Person" />
    </AgentAvatarArtworkProvider>,
  );
  const avatar = view.getByRole("img", { name: "Person" });
  const enter = (type = "mouse") => {
    const event = new MouseEvent("pointerenter", { bubbles: false });
    Object.defineProperty(event, "pointerType", { value: type });
    fireEvent(avatar, event);
  };
  return { avatar, enter, requests };
}
it("autoplays an expanded portrait once its authorized animation is ready", () => {
  const { avatar, requests } = setup();
  expect(avatar.querySelector("img")?.getAttribute("src")).toContain(
    "/protected/small?",
  );
  expect(requests[0]?.src).toContain("/protected/full?");
  act(() => requests[0]?.onload?.());
  expect(avatar.querySelector("img")).toHaveAttribute("src", requests[0]?.src);
});
it("keeps the inline portrait still on hover", () => {
  const { enter, requests } = setup(true, false);
  enter();
  expect(requests).toHaveLength(0);
});
it("keeps expanded portraits still with reduced motion", () => {
  expect(setup(false).requests).toHaveLength(0);
});
it("rejects unsafe animation schemes in display descriptors", () => {
  expect(
    profileAvatarSources(
      "https://example.org/poster#buzz-anim=file%3A%2F%2F%2Fprivate",
    ),
  ).toBeUndefined();
});

it("never interprets persisted profile metadata as authorized display metadata", () => {
  expect(
    profileAvatarSources(
      "https://example.org/poster#buzz-anim=%2Fapi%2Frelay%2Fprivate",
    ),
  ).toBeUndefined();
});

it("rejects display metadata hidden after another URL fragment", () => {
  const src = avatarMedia(
    "https://example.org/poster.png#section#buzz-avatar-display=%2Fapi%2Frelay%2Fprivate",
    (url) => url,
  );
  expect(profileAvatarSources(src ?? "")).toBeUndefined();
});

it.each([
  "/api/relay/private",
  "buzz-media://localhost/private",
  "http://buzz-media.localhost/private",
])(
  "never promotes a public poster into protected media reads: %s",
  (animation) => {
    expect(
      profileAvatarSources(
        `https://example.org/poster.png#buzz-avatar-display=${encodeURIComponent(animation)}`,
      ),
    ).toBeUndefined();
  },
);
it.each([
  "buzz-media://localhost",
  "http://buzz-media.localhost",
  "https://buzz-media.localhost",
])("supports matching native media hosts: %s", (origin) => {
  expect(
    profileAvatarSources(
      `${origin}/poster#buzz-avatar-display=${encodeURIComponent(`${origin}/animation`)}`,
    ),
  ).toEqual({ poster: `${origin}/poster`, animation: `${origin}/animation` });
});

it.each([
  "api/relay/private",
  " /api/relay/private",
  "\t/api/relay/private",
  "//example.org/animation",
])("rejects ambiguous display URL spellings: %j", (animation) => {
  expect(
    profileAvatarSources(
      `https://example.org/poster#buzz-avatar-display=${encodeURIComponent(animation)}`,
    ),
  ).toBeUndefined();
});
