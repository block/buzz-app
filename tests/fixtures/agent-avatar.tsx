import { createRoot } from "react-dom/client";
import { AgentAvatar } from "../../src/features/agents/AgentAvatar";
import { foldProfiles } from "../../src/features/relay/profiles";
import { avatarSource } from "../../src/shared/avatar-source";
import { Avatar } from "../../src/shared/design-system/ui/Avatar";
import "../../src/shared/styles/globals.css";

const agentProfile = foldProfiles([
  {
    kind: 0,
    pubkey: "a".repeat(64),
    content: JSON.stringify({
      name: "Rocket agent",
      picture:
        "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org/2000/svg%22%20width%3D%22512%22%20height%3D%22512%22%20viewBox%3D%220%200%20512%20512%22%3E%3Crect%20width%3D%22512%22%20height%3D%22512%22%20rx%3D%22256%22%20fill%3D%22%232ED3A2%22%2F%3E%3Ctext%20x%3D%2250%25%22%20y%3D%2256%25%22%20dominant-baseline%3D%22middle%22%20text-anchor%3D%22middle%22%20font-size%3D%22258%22%3E%F0%9F%9A%80%3C%2Ftext%3E%3C%2Fsvg%3E",
    }),
    created_at: 1,
    tags: [],
  },
]);

function Fixture() {
  const picture = avatarSource(agentProfile.get("a".repeat(64))?.picture);
  return (
    <main style={{ padding: 40 }}>
      {[22, 40].map((size) => (
        <section
          key={size}
          aria-label={`${size}px avatars`}
          style={{ display: "flex", gap: 24, padding: 24 }}
        >
          <div style={{ width: size, height: size }}>
            <AgentAvatar
              alt="Rocket agent"
              fallback="R"
              size="fill"
              shape="squircle"
              statusBadge="online"
              src={picture}
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
