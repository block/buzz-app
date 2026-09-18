import type React from "react";
import { createRoot } from "react-dom/client";
import {
  Hash,
  Search,
  ListTodo,
  MoreHorizontal,
  ArrowUpRight,
} from "lucide-react";
import { AppShell } from "@buzz/app/shell/AppShell";
import { MessageRow } from "@buzz/features/messages/MessageRow";
import { MessageComposer } from "@buzz/features/messages/MessageComposer";
import channelStyles from "@buzz/bundled/channels/Channels.module.css";
import "@fontsource-variable/inter/wght.css";
import "@buzz/shared/styles/globals.css";
import "./mockup.css";

// These fixtures implement only the read surfaces needed by the real UI.
// No production app bootstrap, relay, signing, or credentials are imported.
const noop = () => () => {};
const communitySnapshot = {
  selected: "demo",
  memberships: [{ id: "demo", name: "Block", relayUrl: "", icon: "" }],
  profile: { name: "Jamie", picture: "" },
};
const communities = {
  subscribe: noop,
  snapshot: () => communitySnapshot,
  select: () => {},
} as unknown as React.ComponentProps<typeof AppShell>["communities"];
const emptyEmoji = { status: "ready", entries: [] };
const emptyTyping = Object.freeze([]);
const emptyProfiles = new Map();
const noSend = () => {
  throw new Error("Presentation only. No messages are sent.");
};
const session = {
  typing: { subscribe: noop, snapshot: () => emptyTyping },
  profiles: { subscribe: noop, snapshot: () => emptyProfiles },
  emoji: {
    subscribe: noop,
    snapshot: () => emptyEmoji,
    ensure: async () => {},
  },
  outbox: { supports: () => true },
  media: () => undefined,
  messages: { send: noSend, reply: noSend },
} as unknown as React.ComponentProps<typeof MessageComposer>["session"];
const pages = [
  {
    key: "buzz.channels/channels",
    id: "channels",
    title: "Messages",
    pluginId: "buzz.channels",
    revision: "1",
    component: () => null,
    layout: "workspace",
  },
  {
    key: "buzz.projects/projects",
    id: "projects",
    title: "Projects",
    pluginId: "buzz.projects",
    revision: "1",
    component: () => null,
    layout: "workspace",
  },
] as React.ComponentProps<typeof AppShell>["pages"];
const people = new Map([
  ["alex", { name: "Alex" }],
  ["jamie", { name: "Jamie" }],
  ["sol", { name: "Sol" }],
  ["casey", { name: "Casey" }],
]);
const task = "Avoid the unmute sound when ending a muted voice call";
function row(id: string, who: string, text: string, time: string, replies = 0) {
  return {
    id,
    authorId: who,
    channelId: "demo-general",
    createdAt: Date.parse(`2026-09-16T${time}:00-04:00`) / 1000,
    content: text,
    mentions: [],
    attachments: [],
    reactions: [],
    replyCount: replies,
    participants: replies ? ["jamie", "sol"] : [],
  };
}
const root = row(
  "origin",
  "alex",
  "Ending a muted voice call plays the unmute sound. It sounds like the mic turned back on.",
  "10:04",
  3,
);
const agree = row(
  "agree",
  "jamie",
  "Let’s fix it. Ending the call should stay quiet if I’m muted.",
  "10:06",
);
const acknowledge = row(
  "ack",
  "sol",
  "I’ll check the teardown path and keep the fix scoped to muted calls.",
  "10:09",
);
function Message({
  data,
  thread = false,
}: {
  data: ReturnType<typeof row>;
  thread?: boolean;
}) {
  return (
    <MessageRow
      row={thread ? { ...data, replyCount: 0 } : data}
      profile={people.get(data.authorId)}
      participantProfiles={people}
      media={() => undefined}
      onOpenLink={() => true}
      day={false}
      retry={undefined}
      onOpenThread={() => {}}
    />
  );
}
function Composer({
  channel = "general",
  thread = true,
  label,
}: {
  channel?: string;
  thread?: boolean;
  label: string;
}) {
  return (
    <div className="compose-wrap">
      <div className="audience">{label}</div>
      <MessageComposer
        session={session}
        scope="presentation-fixture-only"
        channelId={channel}
        channelName={channel}
        {...(thread ? { threadRootId: "demo-thread" } : {})}
      />
    </div>
  );
}
function Pill({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <span className={`pill ${className}`}>{children}</span>;
}
function Status() {
  return (
    <Pill className="progress">
      <span className="status-dot" />
      In progress
    </Pill>
  );
}
function TaskCard({
  open,
  project = false,
}: {
  open: () => void;
  project?: boolean;
}) {
  return (
    <section className="task-card">
      <div className="card-meta">
        <span>
          <ListTodo size={15} />
          Task
        </span>
        <Pill>{project ? "Buzz Voice" : "No project"}</Pill>
      </div>
      <button type="button" className="task-title" onClick={open}>
        {task}
        <ArrowUpRight size={16} />
      </button>
      <div className="card-bottom">
        <Status />
        <Pill>Sol · Agent</Pill>
      </div>
    </section>
  );
}
function SourceMessages() {
  return (
    <>
      <Message data={root} thread />
      <Message data={agree} thread />
    </>
  );
}
function TaskHistory({
  open,
  showCard = true,
}: {
  open: () => void;
  showCard?: boolean;
}) {
  return (
    <>
      <SourceMessages />
      <Message
        data={row(
          "investigate",
          "sol",
          "Confirmed: call teardown triggers the unmute sound. I’ll create a task for the fix.",
          "10:06",
        )}
        thread
      />
      <div className="creation">
        <ListTodo size={14} />
        Sol created this task<span>10:07</span>
      </div>
      {showCard && <TaskCard open={open} />}
      <Message data={acknowledge} thread />
    </>
  );
}
function Sidebar({
  scene,
  choose,
}: {
  scene: number;
  choose: (n: number) => void;
}) {
  return (
    <aside
      className={`${channelStyles.sidebar} ${channelStyles.channelList}`}
      aria-label="Channel sidebar"
    >
      <div className={channelStyles.search}>
        <Search size={17} />
        <input placeholder="Search" aria-label="Search channels" />
      </div>
      <details className={channelStyles.channelSection} open>
        <summary>Channels</summary>
        {["general", "buzz-voice", "buzz-repository", "quiet-call-ending"]
          .filter((n) => scene === 3 || n !== "quiet-call-ending")
          .map((name) => (
            <button
              type="button"
              key={name}
              aria-current={
                (
                  scene === 3
                    ? name === "quiet-call-ending"
                    : name === "general"
                )
                  ? "page"
                  : undefined
              }
              onClick={() => choose(name === "quiet-call-ending" ? 3 : 1)}
            >
              <Hash size={17} />
              <span>{name}</span>
            </button>
          ))}
      </details>
    </aside>
  );
}

function App() {
  const choose = () =>
    document
      .querySelector(".thread-task-header")
      ?.scrollIntoView({ block: "nearest" });
  return (
    <>
      <div className="app-frame">
        <AppShell
          pages={pages}
          selected="buzz.channels/channels"
          onSelect={choose}
          communities={communities}
          workspace
          tone="lime"
        >
          <div className="fixture-layout">
            <Sidebar scene={1} choose={choose} />
            <div className="split">
              <section className="surface column">
                <div className="bar">
                  <strong>
                    <Hash size={18} />
                    general
                  </strong>
                  <MoreHorizontal size={18} />
                </div>
                <div className="timeline">
                  <Message
                    data={row(
                      "earlier",
                      "casey",
                      "The new voice build is ready to try. Let us know if anything feels off.",
                      "09:42",
                    )}
                  />
                  <Message data={root} />
                  <button
                    type="button"
                    className="root-task-link"
                    onClick={() => choose()}
                  >
                    <ListTodo size={14} />
                    {task}
                  </button>
                </div>
                <Composer thread={false} label="Message visible in #general" />
              </section>
              <section className="surface column">
                <div className="bar thread-task-header">
                  <div>
                    <strong>
                      <ListTodo size={17} />
                      Quiet call ending
                    </strong>
                    <span>Thread in #general</span>
                  </div>
                  <Status />
                  <details className="actions">
                    <summary aria-label="Thread actions">
                      <MoreHorizontal size={18} />
                    </summary>
                    <button type="button" onClick={() => choose()}>
                      Open task
                    </button>
                  </details>
                </div>
                <div className="timeline">
                  <TaskHistory open={() => choose()} />
                </div>
                <Composer label="Reply in the task thread · Visible in #general" />
              </section>
            </div>
          </div>
        </AppShell>
      </div>
      <footer className="presentation-footer">
        <div>
          <strong>Attach a task to an existing thread</strong>
          <p>
            The task is created in place. Its timestamped card joins the
            conversation, and the thread header retains task context.
          </p>
        </div>
        <span>Concept · Dummy data</span>
      </footer>
    </>
  );
}
const mount = document.getElementById("root");
if (mount) createRoot(mount).render(<App />);
