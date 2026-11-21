import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { useChatAvatar } from "../../src/features/profiles/use-chat-avatar";
import { Avatar } from "../../src/shared/design-system/ui/Avatar";
import "../../src/shared/styles/globals.css";

const picture = `https://community.example/media/${"a".repeat(64)}.webp`;
const still = "/tests/fixtures/design-system/assets/avatar.png";
const media = (_source: string, size?: "small") =>
  size ? still : "/avatar-animation-original.webp";

function Fixture() {
  const [responding, setResponding] = useState(false);
  const src = useChatAvatar(picture, media, responding);
  return (
    <main>
      <button type="button" onClick={() => setResponding(true)}>
        Start response
      </button>
      <Avatar
        src={src}
        fallbackSrc={still}
        alt="Responding agent"
        fallback="Agent"
        loading="eager"
      />
    </main>
  );
}

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <StrictMode>
      <Fixture />
    </StrictMode>,
  );
