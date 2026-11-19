// Real controls and CSS, with display-only data and no identity or relay access.
import "../../src/shared/styles/globals.css";
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { AgentAvatarArtworkProvider } from "../../src/features/agents/AgentAvatarArtworkProvider";
import { agentAvatars } from "../../src/features/agents/avatar-packs";
import { MessageRow } from "../../src/features/messages/MessageRow";
import type { ChannelMessage } from "../../src/features/relay/contracts";
import type { RegisteredPage } from "../../src/features/pages/service";
import { PageNavigation } from "../../src/app/shell/PageNavigation";
import { BestieNavigationContext } from "../../src/app/shell/bestie-context";
import { ToastProvider } from "../../src/shared/design-system/ui/Toast";
import { useKeyboardFocusVisibility } from "../../src/shared/design-system/useKeyboardFocusVisibility";

const pack = agentAvatars[0];
if (!pack) throw new Error("Missing bundled avatar");
const author = "a".repeat(64);
const row: ChannelMessage = {
  id: "message",
  channelId: "fixture",
  authorId: author,
  createdAt: 1,
  content: "A message with a bundled avatar",
  mentions: [],
  attachments: [],
  reactions: [],
  participants: [],
  replyCount: 0,
};
const page: RegisteredPage = {
  id: "bestie",
  key: "buzz.bestie/bestie",
  pluginId: "buzz.bestie",
  revision: "bundled",
  title: "Bestie",
  component: () => null,
  ...(location.search.includes("preview")
    ? { preview: () => <p>Bestie preview</p> }
    : {}),
};
const mark = {
  label: "Test Bestie",
  detail: "Bestie" as const,
  avatar: { src: pack.preview, shape: "squircle" as const },
};
function Fixture() {
  useKeyboardFocusVisibility();
  const [opened, setOpened] = useState<string[]>([]);
  return (
    <AgentAvatarArtworkProvider>
      <ToastProvider>
        <main style={{ padding: 24, background: "var(--surface)" }}>
          <BestieNavigationContext value={mark}>
            <PageNavigation
              pages={[page]}
              selected="another-page"
              onSelect={() =>
                setOpened((previous) => [...previous, "Bestie opened"])
              }
              placement="dock"
              previews
            />
          </BestieNavigationContext>
          <MessageRow
            row={row}
            profile={{ name: "Test Agent", picture: pack.url, isAgent: true }}
            media={(url) => url}
            canOpenLink={() => true}
            onOpenLink={() => {
              setOpened((previous) => [...previous, "Profile opened"]);
              return true;
            }}
            day={false}
            retry={undefined}
          />
          <output>{opened.join(", ")}</output>
        </main>
      </ToastProvider>
    </AgentAvatarArtworkProvider>
  );
}
createRoot(document.getElementById("root") as HTMLElement).render(<Fixture />);
