import "@fontsource-variable/inter";
import "@fontsource/jetbrains-mono";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Accordion } from "../../src/shared/design-system/ui/Accordion";
import { Avatar } from "../../src/shared/design-system/ui/Avatar";
import { Button } from "../../src/shared/design-system/ui/Button";
import { IconButton } from "../../src/shared/design-system/ui/IconButton";
import { Panel } from "../../src/shared/design-system/ui/Panel";
import { PanelHeader } from "../../src/shared/design-system/ui/PanelHeader";
import { useKeyboardFocusVisibility } from "../../src/shared/design-system/useKeyboardFocusVisibility";
import {
  ArrowSquareOutIcon,
  ChatCircleIcon,
  FileTextIcon,
  HashIcon,
  MagnifyingGlassIcon,
  MoonIcon,
  SunIcon,
  TerminalWindowIcon,
  WrenchIcon,
  XIcon,
} from "../../src/shared/design-system/icons";
import "../../src/shared/styles/globals.css";
import "./preview.css";

const steps = [
  {
    id: "read",
    icon: FileTextIcon,
    label: "Read",
    target: "MessageComposer.tsx",
    description: "Checked how selected agents are kept in the message draft.",
    detail:
      "src/features/messages/MessageComposer.tsx\n\nconst recipients = draft.mentions.map(({ pubkey }) => pubkey);",
  },
  {
    id: "find",
    icon: MagnifyingGlassIcon,
    label: "Found",
    target: "the validation path",
    description:
      "The error clears the selected agent before the draft is restored.",
    detail:
      "Searched for draft restoration and mention handling.\nFound 3 relevant call sites in the composer.",
  },
  {
    id: "change",
    icon: WrenchIcon,
    label: "Updated",
    target: "draft recovery",
    description:
      "Kept the selected agent attached when a message fails to send.",
    detail:
      "Preserve the existing draft on rejection.\nClear the draft only after the message is accepted.",
  },
  {
    id: "test",
    icon: TerminalWindowIcon,
    label: "Running",
    target: "composer tests",
    description:
      "Checking the failure and retry paths with the same selected agent.",
    detail:
      "$ pnpm vitest run MessageComposer.test.tsx\n\n✓ keeps recipients after a rejected send\n✓ retries with the original draft\n✓ clears the draft after acceptance",
  },
];
type PreviewState = "working" | "complete" | "unknown";

function ActivityStream({
  state,
  expanded,
  onExpand,
}: {
  state: PreviewState;
  expanded: string[];
  onExpand: (ids: string[]) => void;
}) {
  return (
    <div className="activity-stream">
      <p className="activity-intro text-body-sm text-subtle">
        I found the issue in draft recovery. I’m keeping the selected agent in
        place when sending fails, then checking the retry path.
      </p>
      <Accordion
        variant="activity"
        value={expanded}
        onValueChange={onExpand}
        items={steps.map((step) => ({
          value: step.id,
          title: (
            <span className="step-label text-body-sm">
              <step.icon size={16} weight="regular" />
              <span>
                {step.id === "test" && state === "complete"
                  ? "Ran"
                  : step.label}{" "}
                <span className="text-standard">{step.target}</span>
              </span>
            </span>
          ),
          content: (
            <div className="step-detail">
              <p className="text-body-sm text-subtle">{step.description}</p>
              <pre className="text-mono">
                <code>{step.detail}</code>
              </pre>
            </div>
          ),
        }))}
      />
      {state === "unknown" && (
        <p className="activity-note text-body-sm text-subtle" role="status">
          No recent activity received. The agent’s current status is unknown.
        </p>
      )}
    </div>
  );
}

function Person({
  name,
  time,
  agent = false,
  children,
}: {
  name: string;
  time?: string;
  agent?: boolean;
  children: ReactNode;
}) {
  return (
    <article className="message">
      <Avatar fallback={name} alt="" shape={agent ? "squircle" : "circle"} />
      <div className="message-content">
        <div className="message-heading">
          <span className="text-label-sm">{name}</span>
          {time && <span className="text-caption text-subtle">{time}</span>}
        </div>
        {children}
      </div>
    </article>
  );
}

function Composer({ label }: { label: string }) {
  return (
    <section
      className="preview-composer text-body-sm text-subtle"
      aria-label={`${label} (visual placeholder)`}
    >
      {label}
      <span className="text-caption">Preview only · messages aren’t sent</span>
    </section>
  );
}

function Preview() {
  useKeyboardFocusVisibility();
  const [state, setState] = useState<PreviewState>("working");
  const [inline, setInline] = useState<string[]>([]);
  const [details, setDetails] = useState<string[]>([]);
  const [panel, setPanel] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [dark, setDark] = useState(false);
  const activityEntry = useRef<HTMLFieldSetElement>(null);
  const panelTitle = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    document.documentElement.dataset.colorMode = dark ? "dark" : "light";
  }, [dark]);
  useEffect(() => {
    if (panel) panelTitle.current?.focus();
  }, [panel]);
  function openPanel() {
    setInline([]);
    setPanel(true);
    setDragging(false);
  }
  function closePanel() {
    setPanel(false);
    activityEntry.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }
  function show(next: PreviewState, expand = false) {
    setState(next);
    setInline(expand ? ["activity"] : []);
    setDetails(expand ? ["test"] : []);
    setPanel(false);
    setDragging(false);
  }
  const label =
    state === "complete"
      ? "View activity"
      : state === "unknown"
        ? "Status unknown"
        : "Running composer tests";
  const activity = (
    <ActivityStream state={state} expanded={details} onExpand={setDetails} />
  );

  return (
    <div className="preview" data-buzz-ui="">
      <header className="preview-controls">
        <div className="preview-caption">
          <span className="text-label-sm">Agent activity</span>
          <span className="text-caption text-subtle">
            Design preview · sample data
          </span>
        </div>
        <fieldset className="preview-actions" aria-label="Preview states">
          <Button size="sm" variant="ghost" onClick={() => show("working")}>
            Working
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => show("working", true)}
          >
            Expanded
          </Button>
          <Button size="sm" variant="ghost" onClick={() => show("complete")}>
            Completed
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => show("unknown", true)}
          >
            Unknown
          </Button>
          <IconButton
            size="compact"
            aria-label={dark ? "Preview light mode" : "Preview dark mode"}
            icon={dark ? <SunIcon size={18} /> : <MoonIcon size={18} />}
            onClick={() => setDark(!dark)}
          />
        </fieldset>
      </header>

      <main className="workspace" data-panel-open={panel || undefined}>
        <div className="channel-pane">
          <Panel aria-label="Channel context">
            <PanelHeader title="design" icon={<HashIcon size={18} />} />
            <div className="channel-content">
              <p className="day-label text-caption text-subtle">Today</p>
              <Person name="Alex" time="10:24 AM">
                <p className="text-body">
                  One last thing before we try the new composer: the agent
                  selection disappears if sending fails.
                </p>
              </Person>
              <Person name="Sam" time="10:26 AM">
                <p className="text-body">
                  Good catch. Let’s keep the draft intact so people can retry
                  without starting over.
                </p>
              </Person>
              <div className="thread-context text-body-sm text-subtle">
                <ChatCircleIcon size={16} />
                <span>Thread open · Fix draft recovery</span>
              </div>
            </div>
            <Composer label="Message #design" />
          </Panel>
        </div>

        <div className="thread-pane">
          <Panel aria-label="Agent conversation thread">
            <PanelHeader title="Thread" />
            <div className="thread-content">
              <div className="thread-heading">
                <p className="text-caption text-subtle">#design</p>
                <h1 className="text-heading">Keep the agent in the draft</h1>
              </div>
              <Person name="Alex" time="10:28 AM">
                <p className="text-body">
                  <span className="text-label">@Rivet</span> Can you fix the
                  agent selection disappearing when a message fails to send?
                </p>
              </Person>
              <Person name="Rivet" agent>
                <div className="response-activity">
                  <fieldset
                    ref={activityEntry}
                    className="activity-disclosure"
                    aria-label="Rivet activity: expand inline or open in side panel"
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer.setData(
                        "application/x-buzz-activity-preview",
                        "rivet",
                      );
                      event.dataTransfer.effectAllowed = "move";
                      setDragging(true);
                    }}
                    onDragEnd={() => setDragging(false)}
                  >
                    <Accordion
                      variant="activity"
                      value={inline}
                      onValueChange={setInline}
                      items={[
                        {
                          value: "activity",
                          title: <span className="text-body-sm">{label}</span>,
                          content: activity,
                        },
                      ]}
                    />
                  </fieldset>
                </div>
                {state === "complete" && (
                  <div className="reply text-body">
                    <p>
                      Fixed. The selected agent now stays in your draft if
                      sending fails, so you can retry without mentioning it
                      again.
                    </p>
                    <p>
                      I also checked the rejected-send and retry paths. The
                      draft still clears normally after an accepted send.
                    </p>
                  </div>
                )}
              </Person>
            </div>
            <Composer label="Reply in thread" />
          </Panel>
        </div>

        {panel && (
          <div className="activity-pane">
            <Panel aria-label="Agent activity side panel">
              <PanelHeader
                title={
                  <h2 ref={panelTitle} tabIndex={-1} className="text-label">
                    Activity
                  </h2>
                }
                actions={
                  <IconButton
                    size="compact"
                    aria-label="Close activity panel"
                    icon={<XIcon size={18} />}
                    onClick={closePanel}
                  />
                }
              />
              <div className="panel-content">
                <div className="panel-identity">
                  <Avatar fallback="Rivet" alt="" shape="squircle" />
                  <div>
                    <p className="text-label-sm">Rivet</p>
                    <p className="text-caption text-subtle">
                      #design · Channel activity
                    </p>
                  </div>
                </div>
                {activity}
                <p className="retention-note text-caption text-subtle">
                  Only visible to you · Live activity, not saved history
                </p>
              </div>
            </Panel>
          </div>
        )}
      </main>
      {dragging && (
        <section
          className="drop-target"
          aria-label="Drop activity here to open a side panel"
          onDragOver={(event) => {
            if (
              event.dataTransfer.types.includes(
                "application/x-buzz-activity-preview",
              )
            ) {
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
            }
          }}
          onDrop={(event) => {
            if (
              event.dataTransfer.getData(
                "application/x-buzz-activity-preview",
              ) === "rivet"
            ) {
              event.preventDefault();
              openPanel();
            }
          }}
        >
          <ArrowSquareOutIcon size={24} />
          <p className="text-label">Open activity here</p>
          <p className="text-body-sm text-subtle">
            Keep the conversation in view
          </p>
        </section>
      )}
    </div>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Preview />);
