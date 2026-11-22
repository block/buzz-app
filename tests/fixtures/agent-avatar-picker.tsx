import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AgentAvatarPicker,
  type AvatarSelection,
} from "../../src/bundled/agents/AgentAvatarPicker";
import { randomAgentAvatar } from "../../src/features/agents/avatar-packs";
import type { RegisteredAgentAvatarSource } from "../../src/features/agents/service";
import { bitties } from "../../src/bundled/bitties";
import { communityDestination } from "../../src/features/communities/destination";
import { Button } from "../../src/shared/design-system/ui/Button";
import { useKeyboardFocusVisibility } from "../../src/shared/design-system/useKeyboardFocusVisibility";
import { avatarMediaFixture } from "./avatar-media";
import "../../src/shared/styles/globals.css";

const community = "https://relay.example.test";
const media = avatarMediaFixture();
window.fetch = async (input, init) => {
  const url = String(input);
  const upload = await media.request(url, init);
  if (upload) return upload;
  if (url.endsWith("/register"))
    return Response.json(
      communityDestination(JSON.parse(String(init?.body)).url),
    );
  if (url.endsWith("/session"))
    return Response.json({
      viewer: "ab".repeat(32),
      relayAuthor: "ef".repeat(32),
      relayUrl: community,
      attachmentUploads: true,
    });
  throw new Error(`Unexpected fixture request: ${url}`);
};

// `?bitties` adds the bundled Bitties source, as the app does by default.
const sources: readonly RegisteredAgentAvatarSource[] = new URLSearchParams(
  location.search,
).has("bitties")
  ? [
      Object.freeze({
        ...bitties,
        key: "buzz.bitties/bitties",
        pluginId: "buzz.bitties",
        revision: "bundled",
      }),
    ]
  : [];

function Fixture() {
  useKeyboardFocusVisibility();
  const [selection, setSelection] = useState<AvatarSelection>(() => ({
    kind: "gloopie",
    picture: randomAgentAvatar().url,
  }));
  const [saved, setSaved] = useState<string>();
  const avatarRef = useRef<{
    prepare(destination: string | undefined): Promise<string>;
  }>(null);
  return (
    <main data-buzz-ui="" className="mx-auto max-w-sm space-y-4 p-4">
      <AgentAvatarPicker
        name="Nova"
        selection={selection}
        disabled={false}
        community={community}
        sources={sources}
        onChange={setSelection}
        onBusyChange={() => {}}
        avatarRef={avatarRef}
      />
      <Button
        onClick={async () => {
          const picture = (await avatarRef.current?.prepare(community)) ?? "";
          const file = media.display(picture);
          setSaved(file ? URL.createObjectURL(file) : picture);
        }}
      >
        Save
      </Button>
      {saved && <img src={saved} alt="Saved avatar" width={128} height={128} />}
      <p>Agents introduce themselves with this avatar.</p>
    </main>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Fixture />);
