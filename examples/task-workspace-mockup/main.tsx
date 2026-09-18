import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Hash,
  Search,
  ListTodo,
  GitBranch,
  GitPullRequest,
  ChevronRight,
  ChevronDown,
  MoreHorizontal,
  Folder,
  Link as LinkIcon,
  ArrowUpRight,
  MessageSquare,
} from "lucide-react";
import { AppShell } from "@buzz/app/shell/AppShell";
import { MessageRow } from "@buzz/features/messages/MessageRow";
import { MessageComposer } from "@buzz/features/messages/MessageComposer";
import channelStyles from "@buzz/bundled/channels/Channels.module.css";
import "@fontsource-variable/inter/wght.css";
import "@buzz/shared/styles/globals.css";
import "./presentation.css";

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
const noSend = () => {
  throw new Error("Presentation only. No messages are sent.");
};
const session = {
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
const descriptions = [
  "Attach a task to an existing thread",
  "View the task, with its branch discussion inline",
  "Give the same task a dedicated channel",
  "Follow project work in conversation and tasks",
];
const captions = [
  "The task is created in place. Its timestamped card joins the conversation, and the thread header retains task context.",
  "A richer view of the same thread, not a new channel. The branch thread expands inline with CI and review. Task discussion continues below it.",
  "The original discussion stays in place and appears as a live reference. New messages and threads use the normal channel timeline.",
  "Linked tasks expand in the project conversation. The Tasks tab lists the same work, including tasks whose conversations live elsewhere.",
];
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
const branch = row(
  "branch",
  "sol",
  "The fix is ready for review. I’ve linked the branch and pull request to this task.",
  "10:18",
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
      onOpenLink={() => false}
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
        <Pill>{project ? "Berd Voice" : "No project"}</Pill>
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
function BranchDiscussion({
  expanded = true,
  accessible = true,
}: {
  expanded?: boolean;
  accessible?: boolean;
}) {
  const [requested, setRequested] = useState(false);
  if (!accessible)
    return (
      <section
        className="reference restricted-branch"
        aria-label="Restricted branch discussion"
      >
        <strong>
          <GitBranch size={16} /> fix/quiet-muted-call-ending
        </strong>
        <p>block / berd</p>
        <p>You don’t have access to the repository channel.</p>
        <button
          type="button"
          className="create-task-channel"
          disabled={requested}
          onClick={() => setRequested(true)}
        >
          {requested ? "Access requested (demo)" : "Request access"}
        </button>
        {requested && <p role="status">Prototype only. No request was sent.</p>}
      </section>
    );
  return (
    <details
      className="reference branch-discussion"
      open={expanded}
      data-testid="branch-discussion"
    >
      <summary>
        <GitBranch size={17} />
        <strong>fix/quiet-muted-call-ending</strong>
        <Pill className="pr">PR open</Pill>
        <ChevronDown size={16} />
      </summary>
      <div className="reference-meta">
        <span>Branch discussion in #berd-repository</span>
      </div>
      <div className="reference-body">
        <div className="creation">
          <GitBranch size={14} />
          Branch created · fix/quiet-muted-call-ending<span>10:12</span>
        </div>
        <div className="creation">
          <GitPullRequest size={14} />
          PR opened · Keep muted calls quiet on disconnect<span>10:18</span>
        </div>
        <div className="ci-result">
          <span aria-hidden="true">✓</span>
          <strong>CI passed · 12 checks</strong>
          <time>10:22</time>
          <span>Build, lint, and regression tests passed.</span>
        </div>
        <Message
          data={row(
            "review",
            "casey",
            "Could we also cover disconnecting while already muted?",
            "10:24",
          )}
          thread
        />
        <Message
          data={row(
            "review-response",
            "sol",
            "Added that regression test. It passes, along with the existing reconnect tests.",
            "10:27",
          )}
          thread
        />
        <div className="audience">
          Reply to branch thread · Visible in #berd-repository
        </div>
        <MessageComposer
          session={session}
          scope="branch-fixture-only"
          channelId="berd-repository"
          channelName="berd-repository"
          threadRootId="demo-branch"
        />
      </div>
    </details>
  );
}
function TaskConversation({
  channel,
  open,
  branchExpanded = true,
  branchAccess = true,
}: {
  channel: boolean;
  open: () => void;
  branchExpanded?: boolean;
  branchAccess?: boolean;
}) {
  return (
    <>
      {channel ? (
        <details className="reference origin" open>
          <summary>
            <LinkIcon size={16} />
            <strong>Original discussion</strong>
            <a href="#1">Thread in #general</a>
            <ChevronDown size={16} />
          </summary>
          <div className="reference-meta">
            Live reference · Original channel access applies
          </div>
          <div className="reference-body">
            <TaskHistory open={open} showCard={false} />
          </div>
        </details>
      ) : (
        <TaskHistory open={open} showCard={false} />
      )}
      <Message data={branch} thread={!channel} />
      <BranchDiscussion expanded={branchExpanded} accessible={branchAccess} />
      <div data-testid="task-follow-up">
        <Message
          data={{
            ...row(
              "task-follow-up",
              "jamie",
              "The muted-call behavior feels right now. Before we close this, can we confirm an ordinary unmute still plays its sound?",
              "10:31",
              channel ? 1 : 0,
            ),
            participants: ["sol"],
          }}
          thread={!channel}
        />
        {channel ? null : (
          <Message
            data={row(
              "task-answer",
              "sol",
              "Yes. Normal unmute still plays the sound; only ending a muted call stays quiet.",
              "10:33",
            )}
            thread={!channel}
          />
        )}
      </div>
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
        {["general", "berd-voice", "berd-repository", "quiet-call-ending"]
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
function CodeContext({
  channel = false,
  restricted = false,
}: {
  channel?: boolean;
  restricted?: boolean;
}) {
  return (
    <aside className="task-context">
      <h3>{restricted ? "Branch" : "Branch & pull request"}</h3>
      <div className="code">
        <div className="repo">
          <Folder size={16} />
          block / berd
        </div>
        <a href="#2" className="branch">
          <GitBranch size={16} />
          fix/quiet-muted-call-ending
        </a>
        {!restricted && (
          <>
            <a href="#2" className="pr-title">
              <GitPullRequest size={17} />
              <span>Keep muted calls quiet on disconnect</span>
            </a>
            <Pill className="pr">PR open</Pill>
          </>
        )}
      </div>
      <h3>Conversation</h3>
      <div className="location">
        <a href={channel ? "#3" : "#1"}>
          {channel ? "#quiet-call-ending" : "Thread in #general"}
        </a>
      </div>
      {!channel && (
        <a className="create-task-channel" href="#3">
          Create task channel…
        </a>
      )}
    </aside>
  );
}
function TaskHeader({ channel = false }: { channel?: boolean }) {
  return (
    <div className="task-header">
      <div className="card-meta">
        <span>
          <ListTodo size={16} />
          Task{" "}
          {channel && (
            <>
              <ChevronRight size={14} />
              <a href="#3">#quiet-call-ending</a>
            </>
          )}
        </span>
        <Pill>No project</Pill>
      </div>
      <h1>{task}</h1>
      <p>
        Ending a muted call should stay quiet, without playing the unmute sound.
      </p>
      <div className="card-bottom">
        <Status />
        <Pill>Sol · Agent</Pill>
      </div>
    </div>
  );
}
function TaskIndex({ choose }: { choose: (n: number) => void }) {
  const [tab, setTab] = useState("conversation");
  return (
    <section className="project-view surface column">
      <header className="project-header">
        <div className="overline">Project</div>
        <h1>Berd Voice</h1>
        <p>Make voice conversations reliable, natural, and easy to use.</p>
        <button
          type="button"
          className="text-link"
          onClick={() => setTab("conversation")}
        >
          #berd-voice
        </button>
      </header>
      <div className="project-tabs" role="tablist" aria-label="Project views">
        {["conversation", "tasks"].map((value) => (
          <button
            type="button"
            key={value}
            id={"project-tab-" + value}
            role="tab"
            aria-selected={tab === value}
            aria-controls="project-panel"
            onClick={() => setTab(value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                event.preventDefault();
                const other = value === "tasks" ? "conversation" : "tasks";
                setTab(other);
                document.getElementById("project-tab-" + other)?.focus();
              }
            }}
          >
            {value === "conversation" ? "Conversation" : "Tasks · 3"}
          </button>
        ))}
      </div>
      <div
        id="project-panel"
        role="tabpanel"
        aria-labelledby={"project-tab-" + tab}
        className="project-panel column"
      >
        {tab === "conversation" ? (
          <>
            <div className="timeline project-timeline">
              <Message
                data={row(
                  "project-start",
                  "jamie",
                  "Let’s use this project to track the next round of voice improvements.",
                  "11:00",
                )}
              />
              <div className="creation">
                <LinkIcon size={14} />
                Jamie linked a task<span>11:02</span>
              </div>
              <details className="reference project-task" open>
                <summary>
                  <ListTodo size={17} />
                  <strong>{task}</strong>
                  <Status />
                  <ChevronDown size={16} />
                </summary>
                <div className="reference-meta">
                  <button
                    type="button"
                    className="text-link"
                    onClick={() => choose(2)}
                  >
                    Open task
                  </button>
                  <span>
                    Conversation in #general · Original channel access applies
                  </span>
                </div>
                <div className="reference-body">
                  <TaskConversation
                    channel={false}
                    open={() => choose(2)}
                    branchExpanded={false}
                  />
                  <Composer label="Reply in the task thread · Visible in #general" />
                </div>
              </details>
              <Message
                data={row(
                  "project-next",
                  "alex",
                  "I’ll pick up connection feedback next. The onboarding guide can stay a separate task.",
                  "11:05",
                )}
              />
            </div>
            <Composer
              channel="berd-voice"
              thread={false}
              label="New message in #berd-voice · Visible to project-channel members"
            />
          </>
        ) : (
          <div className="project-task-list">
            <table>
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Status</th>
                  <th>Assignee</th>
                  <th>Code</th>
                </tr>
              </thead>
              <tbody>
                {[
                  {
                    name: task,
                    who: "Sol",
                    home: "Thread in #general",
                    code: "1 branch · PR open",
                    status: "In progress",
                  },
                  {
                    name: "Improve voice connection feedback",
                    who: "Alex",
                    home: "Thread in #voice-feedback",
                    code: "1 branch · Draft PR",
                    status: "In progress",
                  },
                  {
                    name: "Write the voice onboarding guide",
                    who: "Jamie",
                    home: "Thread in #berd-voice",
                    code: "No branch",
                    status: "Planned",
                  },
                ].map((item, i) => (
                  <tr key={item.name}>
                    <td>
                      {i === 0 ? (
                        <button
                          type="button"
                          className="text-link"
                          onClick={() => choose(2)}
                        >
                          <ListTodo size={17} />
                          {item.name}
                        </button>
                      ) : (
                        <span className="task-list-title">
                          <ListTodo size={17} />
                          {item.name}
                        </span>
                      )}
                      <div className="task-list-location">{item.home}</div>
                    </td>
                    <td>
                      <Pill
                        className={
                          item.status === "In progress" ? "progress" : ""
                        }
                      >
                        {item.status}
                      </Pill>
                    </td>
                    <td>{item.who}</td>
                    <td>{item.code}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
function App() {
  const [restricted, setRestricted] = useState(false);
  const [scene, setScene] = useState(
    Math.min(4, Math.max(1, Number(location.hash.slice(1)) || 1)),
  );
  const choose = (n: number) => {
    setScene(n);
    history.replaceState(null, "", "#" + n);
  };
  React.useEffect(() => {
    const cb = () =>
      setScene(Math.min(4, Math.max(1, Number(location.hash.slice(1)) || 1)));
    addEventListener("hashchange", cb);
    return () => removeEventListener("hashchange", cb);
  }, []);
  return (
    <>
      <div className="app-frame">
        <AppShell
          pages={pages}
          selected={
            scene === 4 ? "buzz.projects/projects" : "buzz.channels/channels"
          }
          onSelect={(key) => choose(key.includes("projects") ? 4 : 1)}
          communities={communities}
          workspace
          tone="lime"
        >
          <div
            className={`fixture-layout ${scene === 4 ? "without-sidebar" : ""}`}
          >
            {scene !== 4 && <Sidebar scene={scene} choose={choose} />}{" "}
            {scene === 1 ? (
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
                      onClick={() => choose(2)}
                    >
                      <ListTodo size={14} />
                      {task}
                    </button>
                  </div>
                  <Composer
                    thread={false}
                    label="Message visible in #general"
                  />
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
                      <button type="button" onClick={() => choose(2)}>
                        Open task
                      </button>
                    </details>
                  </div>
                  <div className="timeline">
                    <TaskHistory open={() => choose(2)} />
                  </div>
                  <Composer label="Reply in the task thread · Visible in #general" />
                </section>
              </div>
            ) : scene === 4 ? (
              <TaskIndex choose={choose} />
            ) : (
              <section className="surface column">
                <TaskHeader channel={scene === 3} />
                <div className="task-grid">
                  <div className="column discussion">
                    <div className="bar">
                      <strong>
                        <MessageSquare size={17} />
                        {scene === 3 ? "#quiet-call-ending" : "Discussion"}
                      </strong>
                      <span>
                        {scene === 3
                          ? "Visible to channel members"
                          : "Replies visible in #general"}
                      </span>
                    </div>
                    <div className="timeline" data-testid="task-timeline">
                      <TaskConversation
                        channel={scene === 3}
                        open={() => choose(2)}
                        branchAccess={scene !== 3 || !restricted}
                      />
                    </div>
                    <details className="task-reply" open>
                      <summary>
                        {scene === 3
                          ? "New message in #quiet-call-ending"
                          : "Reply in the task thread · Visible in #general"}
                      </summary>
                      <Composer
                        channel={scene === 3 ? "quiet-call-ending" : "general"}
                        thread={scene !== 3}
                        label={
                          scene === 3
                            ? "New message in #quiet-call-ending"
                            : "Reply in the task thread · Visible in #general"
                        }
                      />
                    </details>
                  </div>
                  <CodeContext
                    channel={scene === 3}
                    restricted={scene === 3 && restricted}
                  />
                </div>
              </section>
            )}
          </div>
        </AppShell>
      </div>
      <footer className="presentation-footer">
        <div>
          <strong>
            {scene}. {descriptions[scene - 1]}
          </strong>
          <p>{captions[scene - 1]}</p>
        </div>
        {scene === 3 && (
          <label className="access-toggle">
            <input
              type="checkbox"
              checked={restricted}
              onChange={(e) => setRestricted(e.target.checked)}
            />
            Restricted branch access
          </label>
        )}
        <label>
          Concept · Dummy data
          <select
            aria-label="Choose focused scene"
            value={scene}
            onChange={(e) => choose(Number(e.target.value))}
          >
            {descriptions.map((d, i) => (
              <option key={d} value={i + 1}>
                {i + 1}.{" "}
                {
                  [
                    "Thread + task",
                    "Task viewer + branch",
                    "Dedicated task channel",
                    "Project viewer",
                  ][i]
                }
              </option>
            ))}
          </select>
        </label>
      </footer>
    </>
  );
}
const mount = document.getElementById("root");
if (mount) createRoot(mount).render(<App />);
