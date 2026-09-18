import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  MessageRow,
  type MessageRowProps,
} from "@buzz/features/messages/MessageRow";
import "@fontsource-variable/inter/wght.css";
import "@buzz/shared/styles/globals.css";
import { Button } from "@buzz/shared/design-system/ui/Button";
import { useKeyboardFocusVisibility } from "@buzz/shared/design-system/useKeyboardFocusVisibility";

const message = {
  id: "mockup-message",
  authorId: "mockup-alex",
  channelId: "mockup-channel",
  createdAt: 1_789_560_000,
  content: "Could we turn this discussion into a task?",
  mentions: [],
  attachments: [],
  reactions: [],
  replyCount: 1,
  participants: [],
} satisfies MessageRowProps["row"];

// Deliberately do not resolve remote media or navigate out of this mockup.
const noMedia = () => undefined;
const noNavigation = () => true;

function Mockup() {
  useKeyboardFocusVisibility();
  const [threadOpen, setThreadOpen] = useState(false);
  return (
    <main
      data-buzz-ui=""
      className="text-body"
      style={{ maxWidth: "48rem", margin: "2rem auto", padding: "1rem" }}
    >
      <h1 className="text-heading">Conversation mockup</h1>
      <p>Fake data, real Buzz message UI. Open the reply to try the flow.</p>
      <MessageRow
        row={message}
        profile={{ name: "Alex" }}
        media={noMedia}
        onOpenLink={noNavigation}
        day={false}
        retry={undefined}
        onOpenThread={() => setThreadOpen(true)}
      />
      {threadOpen && (
        <section aria-label="Thread">
          <Button onClick={() => setThreadOpen(false)}>Close thread</Button>
          <MessageRow
            row={{
              ...message,
              id: "mockup-reply",
              content: "Yes, let's sketch that flow.",
              replyCount: 0,
            }}
            profile={{ name: "Alex" }}
            media={noMedia}
            onOpenLink={noNavigation}
            day={false}
            retry={undefined}
          />
        </section>
      )}
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing mockup root");
createRoot(root).render(<Mockup />);
