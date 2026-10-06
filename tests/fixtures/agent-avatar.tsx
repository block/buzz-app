import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentAvatar } from "../../src/features/agents/AgentAvatar";
import { avatarSource } from "../../src/shared/avatar-source";
import { Avatar } from "../../src/shared/design-system/ui/Avatar";
import "../../src/shared/styles/globals.css";

function Fixture() {
  const [thinking, setThinking] = useState(false);
  const [picture, setPicture] = useState<"fallback" | "external" | "emoji">(
    "fallback",
  );
  const emojiSvg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" rx="256" fill="#2ED3A2"/><text x="50%" y="56%" dominant-baseline="middle" text-anchor="middle" font-size="258">🚀</text></svg>';
  const emojiPicture = avatarSource(
    `data:image/svg+xml,${encodeURIComponent(emojiSvg)}`,
  );
  return (
    <main style={{ padding: 40 }}>
      <button type="button" onClick={() => setThinking(!thinking)}>
        Toggle thinking
      </button>
      <button type="button" onClick={() => setPicture("external")}>
        Load picture
      </button>
      <button type="button" onClick={() => setPicture("emoji")}>
        Load emoji picture
      </button>
      {[22, 40].map((size) => (
        <section
          key={size}
          aria-label={`${size}px avatars`}
          style={{ display: "flex", gap: 24, padding: 24 }}
        >
          <div style={{ width: size, height: size }}>
            <AgentAvatar
              alt="Agent"
              fallback="A"
              size="fill"
              shape="squircle"
              working={thinking}
              statusBadge="online"
              src={
                picture === "emoji"
                  ? emojiPicture
                  : picture === "external"
                    ? "https://images.example/agent-fallback.png"
                    : undefined
              }
            />
          </div>
          <div style={{ width: size, height: size }}>
            <Avatar alt="Reference" fallback="A" size="fill" shape="squircle" />
          </div>
        </section>
      ))}
    </main>
  );
}
const root = document.getElementById("root");
if (root) createRoot(root).render(<Fixture />);
