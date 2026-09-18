import { type ComponentProps, useState } from "react";
import { createRoot } from "react-dom/client";
import { Hash, ListTodo } from "lucide-react";
import { AppShell } from "@buzz/app/shell/AppShell";
import {
  MessageRow,
  type MessageRowProps,
} from "@buzz/features/messages/MessageRow";
import { MessageComposer } from "@buzz/features/messages/MessageComposer";
import { Button } from "@buzz/shared/design-system/ui/Button";
import { useKeyboardFocusVisibility } from "@buzz/shared/design-system/useKeyboardFocusVisibility";
import channelStyles from "@buzz/bundled/channels/Channels.module.css";
import "@fontsource-variable/inter/wght.css";
import "@buzz/shared/styles/globals.css";
import "./mockup.css";

// Stable read-only fixtures for the services these components consume.
const subscribe = () => () => {};
const communitySnapshot = {
  selected: "demo",
  memberships: [{ id: "demo", name: "Block", relayUrl: "", icon: "" }],
  profile: { name: "Jamie", picture: "" },
};
const communities = {
  subscribe,
  snapshot: () => communitySnapshot,
  select: () => {},
} as unknown as ComponentProps<typeof AppShell>["communities"];
const emptyTyping = Object.freeze([]);
const emptyProfiles = new Map();
const emptyEmoji = { status: "ready", entries: [] };
const session = {
  typing: { subscribe, snapshot: () => emptyTyping },
  profiles: { subscribe, snapshot: () => emptyProfiles },
  emoji: { subscribe, snapshot: () => emptyEmoji, ensure: async () => {} },
  outbox: { supports: () => false },
  media: () => undefined,
} as unknown as ComponentProps<typeof MessageComposer>["session"];
const pages: ComponentProps<typeof AppShell>["pages"] = [
  {
    key: "buzz.channels/channels",
    id: "channels",
    title: "Messages",
    pluginId: "buzz.channels",
    revision: "1",
    component: () => null,
    layout: "workspace",
  },
];
const people = new Map([
  ["alex", { name: "Alex" }],
  ["jamie", { name: "Jamie" }],
  ["sol", { name: "Sol" }],
  ["casey", { name: "Casey" }],
]);
function message(
  id: string,
  authorId: string,
  content: string,
  replies = 0,
): MessageRowProps["row"] {
  return {
    id,
    authorId,
    content,
    channelId: "demo-general",
    createdAt: 1789567440,
    mentions: [],
    attachments: [],
    reactions: [],
    replyCount: replies,
    participants: replies ? ["jamie", "sol"] : [],
  };
}
const rootMessage = message(
  "origin",
  "alex",
  "Ending a muted voice call plays the unmute sound. It sounds like the mic turned back on.",
  3,
);
const taskTitle = "Avoid the unmute sound when ending a muted voice call";
function Message({
  row,
  open,
}: {
  row: MessageRowProps["row"];
  open?: () => void;
}) {
  return (
    <MessageRow
      row={row}
      profile={people.get(row.authorId)}
      participantProfiles={people}
      media={() => undefined}
      onOpenLink={() => true}
      day={false}
      retry={undefined}
      onOpenThread={open}
    />
  );
}
function Composer({ thread = false }: { thread?: boolean }) {
  return (
    <div className="mock-composer">
      <p className="text-caption">Preview only · Sending disabled</p>
      <MessageComposer
        session={session}
        scope="offline-mockup"
        channelId="demo-general"
        channelName="general"
        disabled
        {...(thread ? { threadRootId: "origin" } : {})}
      />
    </div>
  );
}
function Mockup() {
  useKeyboardFocusVisibility();
  const [threadOpen, setThreadOpen] = useState(true);
  const [done, setDone] = useState(false);
  return (
    <div data-buzz-ui="" className="text-body">
      <AppShell
        pages={pages}
        selected="buzz.channels/channels"
        onSelect={() => {}}
        communities={communities}
        workspace
        tone="lime"
      >
        <div className="mock-layout">
          <aside
            className={`${channelStyles.sidebar} ${channelStyles.channelList}`}
            aria-label="Channel sidebar"
          >
            <details className={channelStyles.channelSection} open>
              <summary>Channels</summary>
              <button
                type="button"
                aria-current="page"
                onClick={() => setThreadOpen(false)}
              >
                <Hash size={17} aria-hidden="true" />
                <span>general</span>
              </button>
            </details>
          </aside>
          <div className="mock-panes" data-thread-open={threadOpen}>
            <section className="mock-panel" aria-label="General channel">
              <header className="mock-bar">
                <strong>
                  <Hash size={18} aria-hidden="true" />
                  general
                </strong>
              </header>
              <div className="mock-timeline">
                <Message
                  row={message(
                    "earlier",
                    "casey",
                    "The new voice build is ready to try. Let us know if anything feels off.",
                  )}
                />
                <Message row={rootMessage} open={() => setThreadOpen(true)} />
                <Button onClick={() => setThreadOpen(true)}>
                  <ListTodo size={16} aria-hidden="true" />
                  Quiet call ending
                </Button>
              </div>
              <Composer />
            </section>
            {threadOpen && (
              <section className="mock-panel" aria-label="Task thread">
                <header className="mock-bar">
                  <div>
                    <strong>
                      <ListTodo size={18} aria-hidden="true" />
                      Quiet call ending
                    </strong>
                    <p className="text-caption">Thread in #general</p>
                  </div>
                  <Button onClick={() => setThreadOpen(false)}>
                    Close thread
                  </Button>
                </header>
                <div className="mock-timeline">
                  <Message row={{ ...rootMessage, replyCount: 0 }} />
                  <Message
                    row={message(
                      "agree",
                      "jamie",
                      "Let’s fix it. Ending the call should stay quiet if I’m muted.",
                    )}
                  />
                  <p className="mock-creation text-caption">
                    Sol created this task
                  </p>
                  <section className="mock-task" aria-label="Task">
                    <div className="mock-task-meta text-caption">
                      <span>Task</span>
                      <span>No project</span>
                    </div>
                    <h2 className="text-heading">{taskTitle}</h2>
                    <div className="mock-task-meta">
                      <Button
                        aria-pressed={done}
                        onClick={() => setDone(!done)}
                      >
                        {done ? "Done" : "In progress"}
                      </Button>
                      <span className="text-caption">Sol · Agent</span>
                    </div>
                  </section>
                  <Message
                    row={message(
                      "ack",
                      "sol",
                      "I’ll check the teardown path and keep the fix scoped to muted calls.",
                    )}
                  />
                </div>
                <Composer thread />
              </section>
            )}
          </div>
        </div>
      </AppShell>
    </div>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing mockup root");
createRoot(root).render(<Mockup />);
